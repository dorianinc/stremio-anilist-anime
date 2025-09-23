const { getImages } = require('./fanart');
const { getGenreUrl } = require('./config');
const { getImdbMapping } = require("./metadataEnrich");

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
  const meta = await _toStremioMeta(animeData);

  // If we have a known IMDb mapping for this Kitsu ID, attach it
  const imdbId = getImdbMapping(meta.kitsu_id)?.imdb_id;

  return {
    id: meta.id,
    kitsu_id: meta.kitsu_id,
    imdb_id: imdbId,
    type: meta.type,
    animeType: meta.animeType,
    name: meta.name,           // Prefer English where available
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
    links: meta.links
  };
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
  // `includes` is reserved for future use (e.g., pre-fetched related data)
  return _toStremioMeta(animeData);
}

/**
 * Core transformer: converts raw Kitsu anime payload to Stremio meta.
 * Handles:
 *  - Type normalization (movie vs series)
 *  - Release info string building (e.g., "2020-" for ongoing)
 *  - Genre extraction
 *  - Fanart/logo/poster/background selection
 *  - Videos array (episodes) construction
 *  - Title dedup/priority selection
 *  - Ratings/runtime/links/trailers
 *
 * @param {Object} animeData - Raw Kitsu anime object
 * @returns {Promise<Object>} - Fully-formed Stremio meta
 */
async function _toStremioMeta(animeData) {
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

  // Extract genre names (if present)
  const genres = animeData.genres.data?.map((genre) => genre.name);

  // Attempt to fetch fanart (logo/poster/background). Fail soft.
  const fanartImages = await getImages(animeData.id).catch(() => ({}));

  // Build videos array (episodes) for series if we have data or a count.
  let videos;
  if (animeData.subtype !== 'movie' || animeData.episodes.data?.length || animeData.episodeCount > 1) {
    const seriesStartTime = new Date(animeData.startDate).getTime();

    if (animeData.episodes.data?.length) {
      // Build from explicit episode list
      let lastReleaseDate = new Date(seriesStartTime);
      videos = animeData.episodes.data
        .map((ep, index, self) => ({
          id: `kitsu:${animeData.id}:${ep.number}`,
          title:
            ep.titles.en_us ||
            ep.titles.en ||
            ep.titles.en_jp ||
            ep.canonicalTitle ||
            `Episode ${ep.number}`,
          released: episodeReleased(ep, self[index + 1], lastReleaseDate),
          season: 1,
          episode: ep.number,
          thumbnail: ep.thumbnail?.original,
          overview: cleanDescription(ep.synopsis),
        }))
        .sort((a, b) => a.episode - b.episode);
    } else if (animeData.episodeCount) {
      // Fallback: create placeholders when we only know the count
      videos = [...Array(animeData.episodeCount).keys()]
        .map((ep) => ep + 1)
        .map((ep) => ({
          id: `kitsu:${animeData.id}:${ep}`,
          title: `Episode ${ep}`,
          released: new Date(seriesStartTime),
          season: 1,
          episode: ep,
        }));
    }

    // If it's effectively a single-video special (OVA/ONA/etc.), collapse to single ID
    if (videos && videos.length === 1 && ['movie', 'special', 'OVA', 'ONA'].includes(animeData.subtype)) {
      videos[0].id = `kitsu:${animeData.id}`;
    }
  }

  // Build title variants, dedupe case-insensitively, and pick a display name
  const titlesArray = [
    animeData.titles?.en_us,
    animeData.titles?.en,
    animeData.titles?.en_jp,
    animeData.titles?.ja_jp,
    animeData.canonicalTitle
  ]
    .concat(animeData.abbreviatedTitles || [])
    .filter(Boolean);

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

  // Assemble the final meta object and prune null/undefined fields
  const output = cleanOutputObject({
    id: `kitsu:${animeData.id}`,
    kitsu_id: animeData.id,
    type: type,
    animeType: animeData.subtype,
    name: displayName,
    slug: animeData.slug,
    aliases: titles,
    genres: genres || [],
    logo: fanartImages.logo,
    poster: animeData?.posterImage?.medium || fanartImages.poster,
    background: fanartImages.background || (animeData.coverImage && animeData.coverImage.original),
    description: cleanDescription(animeData.synopsis),
    releaseInfo: releaseInfo,
    year: releaseInfo, // Stremio sometimes uses `year`; we mirror releaseInfo
    imdbRating: roundedRating(animeData.averageRating)?.toString(),
    userCount: animeData.userCount,
    status: animeData.status,
    runtime: (Number.isInteger(animeData.episodeLength) && `${animeData.episodeLength} min`) || null,
    trailers: (animeData.youtubeVideoId && [{ source: animeData.youtubeVideoId, type: 'Trailer' }]) || [],
    videos: videos,
    links: kitsuLinks(animeData, type)
  });

  return output;
}

/**
 * Decide final Stremio content type based on Kitsu subtype.
 * Movies -> 'movie', everything else -> 'series'
 */
function getType(animeData) {
  return (animeData.subtype === 'movie') ? 'movie' : 'series';
}

/**
 * Convert Kitsu's 0–100 rating (string/number) into IMDb-like 0–10 with 1 decimal.
 * Returns a string like "8.3" or undefined if input missing.
 */
function roundedRating(rating) {
  const val = rating && (Math.round(((rating / 10.0) + Number.EPSILON) * 10.0) / 10.0).toFixed(1);
  return val;
}

/**
 * Build the "links" array used by Stremio:
 *  - A faux IMDb category with the rating (click goes to Kitsu page)
 *  - Franchise links (prequel/sequel) deep-linking back into Stremio
 *  - Genre links that route to your genre catalogs
 */
function kitsuLinks(animeData, type) {
  const imdbRating = roundedRating(animeData.averageRating);

  const rating = (imdbRating && [{
    name: `${imdbRating}`,
    category: 'imdb',
    url: `https://kitsu.io/anime/${animeData.slug}`
  }]) || [];

  const franchise = (animeData.mediaRelationships.data || [])
    .filter((relationship) => allowedRelationships.includes(relationship.role))
    .map((relationship) => ({
      name: `${capitalize(relationship.role)}: ${relationship.destination.data.titles?.en}`,
      category: 'Franchise',
      url: `stremio:///detail/${type}/kitsu:${relationship.destination.data.id}`
    }));

  const genres = (animeData.genres.data || [])
    .map((genre) => genre.name)
    .map((genre) => ({
      name: genre,
      category: 'Genres',
      url: getGenreUrl(genre)
    }));

  return rating.concat(franchise).concat(genres);
}

/**
 * Decide a reasonable "released" date for an episode, considering adjacent episodes.
 * Ensures monotonic, non-decreasing dates within a season list by clamping forwards.
 *
 * @param {Object} ep - Current episode object
 * @param {Object} nextEp - Next episode object (if any)
 * @param {Date} lastReleaseDate - Mutable reference for last release date seen
 * @returns {Date} - Release date to assign to this episode
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
  return released;
}

/**
 * Capitalize the first character of a string.
 */
function capitalize(input) {
  return input.charAt(0).toUpperCase() + input.slice(1);
}

/**
 * Remove trailing source/notes footers and extra newlines from descriptions.
 * - Strips blocks like "(Source: ...)" and subsequent "Note ..." blobs.
 *
 * @param {string} description
 * @returns {string|undefined}
 */
function cleanDescription(description) {
  return description?.replace(/\n+(?:[([].+[)\]\n]|Source:.*)?(?:\n+Note(.|\n)+)?$/, '');
}

/**
 * Remove null/undefined properties from an object (to keep Stremio responses tidy).
 */
function cleanOutputObject(object) {
  return Object.fromEntries(Object.entries(object).filter(([_, v]) => v != null));
}

module.exports = { toStremioCatalogMeta, toStremioEntryMeta };
