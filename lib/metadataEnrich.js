const { getGenreUrl } = require('./config')
const kitsuToImdbMappping = require('../static/data/imdb_mapping');

// Build a reverse lookup map: IMDb ID → list of Kitsu entries
// Each entry includes season/episode offset info so we can align episode numbering.
const imdbToKitsuMapping = Object.entries(kitsuToImdbMappping)
    .map(([kitsuId, value]) => ({
      kitsu_id: kitsuId,
      imdb_id: value.imdb_id,
      title: value.title,
      nonImdbEpisodes: value.nonImdbEpisodes,
      fromSeason: value.fromSeason === undefined ? 1 : value.fromSeason,
      fromEpisode: value.fromEpisode === undefined ? 1 : value.fromEpisode
    }))
    .filter((entry) => entry.imdb_id) // only keep entries that have an IMDb ID
    .reduce((map, nextEntry) => {
      // Group by IMDb ID
      map[nextEntry.imdb_id] = (map[nextEntry.imdb_id] || []).concat(nextEntry)
          // Sort by season, then by episode so alignment is consistent
          .sort((a, b) => {
            const seasonSort = a.fromSeason - b.fromSeason;
            if (seasonSort !== 0) {
              return seasonSort;
            }
            return a.fromEpisode - b.fromEpisode
          });
      return map;
    }, {});

// Check if a given ID has an IMDb mapping available
function hasImdbMapping(id) {
  if (id.startsWith('tt')) {
    // If it's an IMDb ID, check reverse mapping
    return !!imdbToKitsuMapping[id];
  }
  // Otherwise treat it as a Kitsu ID
  return !!kitsuToImdbMappping[id]
}

// Get mapping data for a given Kitsu ID
function getImdbMapping(kitsuId) {
  return kitsuToImdbMappping[kitsuId];
}

/**
 * Enrich Kitsu metadata with IMDb data if a mapping exists.
 * - Adds runtime, IMDb rating, genres
 * - Aligns episode lists with IMDb numbering
 * - Adds IMDb link and genres if missing
 */
async function enrichKitsuMetadata(metadata, retrieveImdbMetadata) {
  const imdbInfo = kitsuToImdbMappping[metadata.kitsu_id];
  if (imdbInfo && imdbInfo.imdb_id) {
    // Fetch IMDb metadata for the mapped ID
    const imdbMetadata = await retrieveImdbMetadata(imdbInfo.imdb_id, metadata.type).catch(() => undefined);
    return sanitize({
      ...metadata,
      imdb_id: imdbInfo.imdb_id,
      runtime: metadata.runtime || imdbMetadata?.runtime,
      imdbRating: metadata.imdbRating || imdbMetadata?.imdbRating || undefined,
      genres: metadata.genres.length ? metadata.genres : imdbMetadata?.genres?.filter(genre => genre !== 'Animation'),
      videos: await enrichKitsuEpisodes(metadata, imdbInfo, imdbMetadata),
      links: []
          .concat(metadata.links)
          .concat(metadata.imdbRating ? [] : getImdbLink(imdbMetadata))
          .concat(metadata.genres.length ? [] : getCinemetaGenres(imdbMetadata))
    });
  }
  return metadata;
}

/**
 * Aligns Kitsu episode list with IMDb episode numbering.
 * Handles:
 *  - Season/episode offsets from mapping
 *  - Skipping episodes not present on IMDb
 *  - Carrying over titles/thumbnails/overviews from IMDb
 */
async function enrichKitsuEpisodes(metadata, imdbInfo, imdbMetadata) {
  if (!metadata.videos || !metadata.videos.length) {
    return metadata.videos;
  }

  const startSeason = Number.isInteger(imdbInfo.fromSeason) ? imdbInfo.fromSeason : 1;
  const startEpisode = Number.isInteger(imdbInfo.fromEpisode) ? imdbInfo.fromEpisode : 1;

  // Check if there are later Kitsu entries for the same IMDb ID
  const otherImdbEntries = imdbToKitsuMapping[imdbInfo.imdb_id]
      .filter((entry) => entry.kitsu_id !== metadata.kitsu_id
          && entry.fromSeason >= startSeason
          && entry.fromEpisode >= startEpisode);

  const nextImdbEntry = otherImdbEntries && otherImdbEntries[0];

  // Build per-season episode counts from IMDb metadata
  const perSeasonEpisodeCount = imdbMetadata && imdbMetadata.videos && imdbMetadata.videos
      .filter((video) => video.episode = Number.isInteger(video.episode) ? video.episode : video.number)
      .filter((video) => (video.season === startSeason && video.episode >= startEpisode) || (video.season > startSeason
          && (!nextImdbEntry || nextImdbEntry.fromSeason > video.season)))
      .reduce(
          (counts, next) => (counts[next.season - startSeason] = counts[next.season - startSeason] + 1 || 1, counts),
          []);

  // Map for quick lookup of IMDb episodes
  const videosMap = perSeasonEpisodeCount && imdbMetadata.videos.reduce((map, next) => (map[next.id] = next, map), {})
  let skippedEpisodes = 0;

  if (perSeasonEpisodeCount && perSeasonEpisodeCount.length) {
    let lastReleased;
    return metadata.videos
        .map(video => {
          // Skip episodes explicitly excluded
          if (imdbInfo.nonImdbEpisodes && imdbInfo.nonImdbEpisodes.includes(video.episode)) {
            skippedEpisodes++
            return video
          }

          // Figure out which season/episode this maps to on IMDb
          const seasonIndex = ([...perSeasonEpisodeCount.keys()]
              .find((i) => perSeasonEpisodeCount.slice(0, i + 1)
                  .reduce((a, b) => a + b, 0) >= video.episode - skippedEpisodes) + 1 || perSeasonEpisodeCount.length) - 1;

          const previousSeasonsEpisodeCount = perSeasonEpisodeCount.slice(0, seasonIndex).reduce((a, b) => a + b, 0);
          const season = startSeason + seasonIndex;
          const episode = startEpisode - 1 + video.episode - skippedEpisodes - previousSeasonsEpisodeCount;

          const imdbVideo = videosMap[`${imdbInfo.imdb_id}:${season}:${episode}`];

          // Carry over title/thumbnail/overview from IMDb if available
          const title = video.title.match(/Episode \d+/) && (imdbVideo?.title || imdbVideo?.name) || video.title;
          const thumbnail = video.thumbnail || imdbVideo?.thumbnail;
          const overview = video.overview || imdbVideo?.overview;

          // Keep release dates monotonic
          const released = new Date(imdbVideo?.released || video.released.getTime());
          lastReleased = lastReleased?.getTime() > released.getTime() ? lastReleased : released;

          return {
            ...video,
            title,
            thumbnail,
            overview,
            released: lastReleased,
            imdb_id: imdbInfo.imdb_id,
            imdbSeason: season,
            imdbEpisode: episode
          }
        });
  }

  // Fallback: map everything linearly starting from given season/episode
  return metadata.videos
      .map((video) => ({
        ...video,
        imdb_id: imdbInfo.imdb_id,
        imdbSeason: startSeason,
        imdbEpisode: startEpisode - 1 + video.episode // startEpisode is inclusive, so need -1
      }));
}

/**
 * Enrich IMDb metadata with Kitsu data if mapping exists.
 * - Adds Kitsu ID(s)
 * - Aligns videos with Kitsu numbering
 */
async function enrichImdbMetadata(metadata, retrieveKitsuMetadata) {
  const kitsuEntries = imdbToKitsuMapping[metadata.id];
  if (kitsuEntries && kitsuEntries.length) {
    const kitsuIds = kitsuEntries
        .filter((entry) => Number.isNaN(entry.fromSeason) || entry.fromSeason > 0)
        .map((entry) => entry.kitsu_id)

    return sanitize({
      ...metadata,
      imdb_id: metadata.id,
      kitsu_id: kitsuIds.length === 1 ? kitsuIds[0] : kitsuIds,
      videos: await enrichImdbEpisodes(metadata, kitsuEntries, retrieveKitsuMetadata)
    });
  }
  return metadata;
}

/**
 * Align IMDb episode list with Kitsu episodes.
 * - If videos are missing, fetch from Kitsu
 * - Otherwise, attach Kitsu ID/episode numbers
 */
async function enrichImdbEpisodes(metadata, kitsuEntries, retrieveKitsuMetadata) {
  if (metadata.type === 'movie') {
    return metadata.videos;
  }

  // If no episodes exist, fetch from Kitsu directly
  if (metadata.type === undefined || !metadata.videos || !metadata.videos.length) {
    return Promise.all(kitsuEntries.map((kitsuEntry) => retrieveKitsuMetadata(kitsuEntry.kitsu_id)
        .then((kitsuMetadata) => (kitsuMetadata.videos || [])
            .map((video) => ({
              title: video.title,
              season: kitsuEntry.fromSeason,
              episode: kitsuEntry.fromEpisode + video.episode - 1,
              kitsu_id: kitsuEntry.kitsu_id,
              kitsuEpisode: video.episode
            })))))
        .then((videos) => videos.reduce((a, b) => a.concat(b), []));
  }

  // Otherwise, map existing episodes
  const episode = video => video.episode || video.number;
  const episodeCounter = kitsuEntries.reduce((counter, next) => (counter[next.kitsu_id] = 1, counter), {});

  return metadata.videos
      .sort((a, b) => a.season - b.season || episode(a) - episode(b))
      .map((video) => {
        // Find the most recent matching Kitsu entry for this season/episode
        const kitsuEntry = kitsuEntries.slice().reverse()
            .find((entry) => entry.fromSeason <= video.season && entry.fromEpisode <=  episode(video));

        if (!kitsuEntry) {
          return video
        }

        // Increment through Kitsu episodes, skipping ones not on IMDb
        let kitsuEpisode = episodeCounter[kitsuEntry.kitsu_id]++
        while (kitsuEntry.nonImdbEpisodes && kitsuEntry.nonImdbEpisodes.includes(kitsuEpisode)) {
          kitsuEpisode = episodeCounter[kitsuEntry.kitsu_id]++
        }

        return {
          ...video,
          kitsu_id: kitsuEntry.kitsu_id,
          kitsuEpisode: kitsuEpisode
        };
      })
}

// Extract IMDb links from metadata
function getImdbLink(metadata) {
  return (metadata?.links || []).filter(link => link.category === 'imdb');
}

// Extract genres from Cinemeta links, remap URLs to your own genre catalog
function getCinemetaGenres(metadata) {
  return (metadata?.links || [])
      .filter(link => link.category === 'Genres' && link.name !== 'Animation')
      .map(link => ({
        ...link,
        url: getGenreUrl(link.name)
      }));
}

// Remove null/undefined values from an object
function sanitize(obj) {
  Object.keys(obj).forEach((key) => (obj[key] == null) && delete obj[key]);
  return obj;
}

module.exports = { enrichKitsuMetadata, enrichImdbMetadata, hasImdbMapping, getImdbMapping };
