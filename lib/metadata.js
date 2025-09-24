const { getImages } = require('./fanart');
const { getGenreUrl } = require('./config');
const { getImdbMapping } = require('./metadataEnrich');
const { scope } = require('./logger');

const L = {
  META: scope('META_BUILD'),
  EP: scope('EPISODES'),
  TIT: scope('TITLES'),
  LNK: scope('LINKS'),
  CLR: scope('CLEAN'),
  ERR: scope('ERROR'),
};

/**
 * Relationship roles we expose as "Franchise" links in the UI.
 */
const allowedRelationships = ['prequel', 'sequel'];

/**
 * Build a lightweight Stremio catalog meta object (for catalog rows/cards)
 * from a raw Kitsu anime payload by first creating the full Stremio meta
 * and then trimming to catalog-friendly fields.
 *
 * @param {Object} animeData - Raw Kitsu anime object
 * @returns {Promise<Object>} - Catalog meta object for Stremio catalogs
 */
async function toStremioCatalogMeta(animeData) {
  // L.META('toStremioCatalogMeta start', { kitsuId: animeData?.id });
  const meta = await _toStremioMeta(animeData);

  const imdbId = getImdbMapping(meta.kitsu_id)?.imdb_id;
  // L.META('imdb mapping', { kitsuId: meta.kitsu_id, imdbId: imdbId || null });

  const out = {
    id: meta.id,
    kitsu_id: meta.kitsu_id,
    imdb_id: imdbId,
    type: meta.type,
    animeType: meta.animeType,
    name: meta.name, // Prefer English where available
    aliases: meta.aliases,
    description: meta.description,
    releaseInfo: meta.releaseInfo,
    runtime: meta.runtime,
    imdbRating: meta.imdbRating,
    genres: meta.genres,
    logo: meta.logo,
    poster: meta.poster,
    background: meta.background,
    trailers: meta.trailers,
    links: meta.links,
  };
  // L.META('toStremioCatalogMeta done', {
  //   id: out.id,
  //   name: out.name,
  //   hasVideos: Array.isArray(meta.videos) && meta.videos.length > 0,
  // });
  return out;
}

/**
 * Build a complete Stremio "entry" meta object (for detail pages).
 * Currently the `includes` param is not used, but kept for future extension.
 *
 * @param {Object} animeData - Raw Kitsu anime object
 * @param {Object} [includes] - Optional hint data (unused)
 * @returns {Promise<Object>} - Full Stremio meta object
 */
async function toStremioEntryMeta(animeData, includes) {
  console.log("pomogranate")
  // L.META('toStremioEntryMeta start', {
  //   kitsuId: animeData?.id,
  //   includes: !!includes,
  // });
  const meta = await _toStremioMeta(animeData);
  // L.META('toStremioEntryMeta done', {
  //   id: meta.id,
  //   videos: Array.isArray(meta.videos) ? meta.videos.length : 0,
  // });
  return meta;
}

/**
 * Core transformer: converts raw Kitsu anime payload to Stremio meta.
 *
 * @param {Object} animeData - Raw Kitsu anime object
 * @returns {Promise<Object>} - Fully-formed Stremio meta
 */
async function _toStremioMeta(animeData) {
  // L.META('_toStremioMeta start', {
  //   kitsuId: animeData?.id,
  //   subtype: animeData?.subtype,
  //   status: animeData?.status,
  // });

  const type = getType(animeData);

  // Build a simple `releaseInfo` string:
  // - "YYYY-YYYY" if start & end differ
  // - "YYYY-" for ongoing (status === 'current')
  let releaseInfo = animeData.startDate && `${animeData.startDate.match(/^\d+/)[0]}`;
  if (animeData.endDate && !animeData.endDate.startsWith(releaseInfo)) {
    releaseInfo = releaseInfo && releaseInfo.concat(`-${animeData.endDate.match(/^\d+/)[0]}`);
  } else if (animeData.status === 'current') {
    releaseInfo = releaseInfo && releaseInfo.concat('-');
  }
  // L.META('releaseInfo', releaseInfo || null);

  // Extract genres
  const genres = animeData.genres?.data?.map((g) => g.name) || [];
  // L.META('genres count', genres.length);

  // Attempt to fetch fanart (logo/poster/background). Fail soft.
  let fanartImages = {};
  try {
    fanartImages = await getImages(animeData.id);
    // L.META('fanart fetched', Object.keys(fanartImages));
  } catch (e) {
    L.ERR('fanart fetch failed', e?.message || e);
  }

  // Build videos array (episodes) if we have data or a count.
  let videos;
  const hasEpisodeData = Array.isArray(animeData.episodes?.data) && animeData.episodes.data.length > 0;
  const hasEpisodeCount = Number.isInteger(animeData.episodeCount) && animeData.episodeCount > 0;

  if (animeData.subtype !== 'movie' || hasEpisodeData || animeData.episodeCount > 1) {
    const seriesStartTime = animeData.startDate ? new Date(animeData.startDate).getTime() : Date.now();

    if (hasEpisodeData) {
      // L.EP('building videos from episodes.data', animeData.episodes.data.length);
      let lastReleaseDate = new Date(seriesStartTime);

      videos = animeData.episodes.data
        .map((ep, index, self) => ({
          id: `kitsu:${animeData.id}:${ep.number}`,
          title:
            ep.titles?.en_us ||
            ep.titles?.en ||
            ep.titles?.en_jp ||
            ep.canonicalTitle ||
            `Episode ${ep.number}`,
          released: episodeReleased(ep, self[index + 1], lastReleaseDate),
          season: 1,
          episode: ep.number,
          thumbnail: ep.thumbnail?.original,
          overview: cleanDescription(ep.synopsis),
        }))
        .sort((a, b) => a.episode - b.episode);
      // L.EP('built videos (from list)', videos.length);
    } else if (hasEpisodeCount) {
      // L.EP('building videos from episodeCount', animeData.episodeCount);
      videos = [...Array(animeData.episodeCount).keys()]
        .map((ep) => ep + 1)
        .map((ep) => ({
          id: `kitsu:${animeData.id}:${ep}`,
          title: `Episode ${ep}`,
          released: new Date(seriesStartTime),
          season: 1,
          episode: ep,
        }));
      // L.EP('built videos (placeholders)', videos.length);
    }

    // Single-video special collapse
    if (videos && videos.length === 1 && ['movie', 'special', 'OVA', 'ONA'].includes(animeData.subtype)) {
      // L.EP('single video special collapse', { from: videos[0].id, to: `kitsu:${animeData.id}` });
      videos[0].id = `kitsu:${animeData.id}`;
    }
  } else {
    L.EP('no episodes built', {
      subtype: animeData.subtype,
      hasEpisodeData,
      hasEpisodeCount,
      episodeCount: animeData.episodeCount,
    });
  }

  // Title variants & display name
  const titlesArray = [
    animeData.titles?.en_us,
    animeData.titles?.en,
    animeData.titles?.en_jp,
    animeData.titles?.ja_jp,
    animeData.canonicalTitle,
    ...(animeData.abbreviatedTitles || []),
  ].filter(Boolean);

  // L.TIT('titlesArray size', titlesArray.length);

  const titles = titlesArray.reduce((acc, cur) => {
    const lower = cur.toLowerCase();
    if (!acc.some((v) => v.toLowerCase() === lower)) acc.push(cur);
    return acc;
  }, []);

  const displayName =
    animeData.titles?.en_us ||
    animeData.titles?.en ||
    animeData.titles?.en_jp ||
    animeData.titles?.ja_jp ||
    animeData.canonicalTitle ||
    titles[0] ||
    'Unknown Title';

  // L.TIT('displayName', displayName);

  const output = cleanOutputObject({
    id: `kitsu:${animeData.id}`,
    kitsu_id: animeData.id,
    type: type,
    animeType: animeData.subtype,
    name: displayName,
    slug: animeData.slug,
    aliases: titles,
    genres: genres,
    logo: fanartImages.logo,
    poster: animeData?.posterImage?.medium || fanartImages.poster,
    background: fanartImages.background || (animeData.coverImage && animeData.coverImage.original),
    description: cleanDescription(animeData.synopsis),
    releaseInfo: releaseInfo,
    year: releaseInfo, // mirror releaseInfo
    imdbRating: roundedRating(animeData.averageRating)?.toString(),
    userCount: animeData.userCount,
    status: animeData.status,
    runtime: (Number.isInteger(animeData.episodeLength) && `${animeData.episodeLength} min`) || null,
    trailers: (animeData.youtubeVideoId && [{ source: animeData.youtubeVideoId, type: 'Trailer' }]) || [],
    videos: videos,
    links: kitsuLinks(animeData, type),
  });

  // L.META('_toStremioMeta done', {
  //   id: output.id,
  //   name: output.name,
  //   videos: Array.isArray(output.videos) ? output.videos.length : 0,
  // });

  return output;
}

/**
 * Decide final Stremio content type based on Kitsu subtype.
 * Movies -> 'movie', everything else -> 'series'
 */
function getType(animeData) {
  const t = animeData?.subtype === 'movie' ? 'movie' : 'series';
  // L.META('getType', { subtype: animeData?.subtype, type: t });
  return t;
}

/**
 * Convert Kitsu's 0–100 rating (string/number) into IMDb-like 0–10 with 1 decimal.
 * Returns a string like "8.3" or undefined if input missing.
 */
function roundedRating(rating) {
  const val = rating && (Math.round(((rating / 10.0) + Number.EPSILON) * 10.0) / 10.0).toFixed(1);
  // L.META('roundedRating', { input: rating, output: val || null });
  return val;
}

/**
 * Build the "links" array used by Stremio.
 */
function kitsuLinks(animeData, type) {
  // L.LNK('kitsuLinks start', { kitsuId: animeData?.id, type });

  const imdbRating = roundedRating(animeData.averageRating);

  const rating =
    (imdbRating && [
      {
        name: `${imdbRating}`,
        category: 'imdb',
        url: `https://kitsu.io/anime/${animeData.slug}`,
      },
    ]) ||
    [];

  const franchise = (animeData.mediaRelationships?.data || [])
    .filter((relationship) => allowedRelationships.includes(relationship.role))
    .map((relationship) => ({
      name: `${capitalize(relationship.role)}: ${relationship.destination?.data?.titles?.en}`,
      category: 'Franchise',
      url: `stremio:///detail/${type}/kitsu:${relationship.destination?.data?.id}`,
    }));

  const genreNames = (animeData.genres?.data || []).map((g) => g.name);
  const genres = genreNames.map((genre) => ({
    name: genre,
    category: 'Genres',
    url: getGenreUrl(genre),
  }));

  const result = rating.concat(franchise).concat(genres);
  // L.LNK('kitsuLinks done', { rating: rating.length, franchise: franchise.length, genres: genres.length });
  return result;
}

/**
 * Decide a reasonable "released" date for an episode, considering adjacent episodes.
 * Ensures monotonic, non-decreasing dates within a season list by clamping forwards.
 */
function episodeReleased(ep, nextEp, lastReleaseDate) {
  const airDate = ep.airdate && new Date(ep.airdate);
  const nextAirDate = (nextEp && nextEp.airdate && new Date(nextEp.airdate)) || airDate;

  const released =
    airDate &&
    airDate.getTime() > lastReleaseDate.getTime() &&
    airDate.getTime() <= nextAirDate.getTime()
      ? airDate
      : new Date(lastReleaseDate.getTime());

  lastReleaseDate.setTime(released.getTime());
  // L.EP('episodeReleased', {
  //   ep: ep?.number,
  //   airDate: airDate ? airDate.toISOString() : null,
  //   result: released ? released.toISOString() : null,
  // });
  return released;
}

/**
 * Capitalize the first character of a string.
 */
function capitalize(input) {
  const val = input ? input.charAt(0).toUpperCase() + input.slice(1) : input;
  return val;
}

/**
 * Remove trailing source/notes footers and extra newlines from descriptions.
 */
function cleanDescription(description) {
  const cleaned = description?.replace(/\n+(?:[([].+[)\]\n]|Source:.*)?(?:\n+Note(.|\n)+)?$/, '');
  // L.CLR('cleanDescription', { had: !!description, cleaned: !!cleaned });
  return cleaned;
}

/**
 * Remove null/undefined properties from an object (to keep Stremio responses tidy).
 */
function cleanOutputObject(object) {
  const pruned = Object.fromEntries(Object.entries(object).filter(([_, v]) => v != null));
  L.CLR('cleanOutputObject', {
    before: Object.keys(object || {}).length,
    after: Object.keys(pruned || {}).length,
  });
  return pruned;
}

module.exports = { toStremioCatalogMeta, toStremioEntryMeta };
