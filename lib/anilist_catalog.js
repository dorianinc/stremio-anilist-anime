// anilist_catalog.js
// Minimal AniList-powered catalogs for the Kitsu add-on:
// - Trending Now
// - Popular This Season
// Returns Stremio-ready catalog metas using id: `anilist:{id}`.
// Movies are excluded via format_not_in: [MOVIE].

const { scope } = require('./logger');
const L = { ANI: scope('ANILIST') };

const ANILIST_URL = 'https://graphql.anilist.co';
const PAGE_SIZE = 20;

/**
 * Lightweight GraphQL executor for AniList.
 * Logs request variables, HTTP errors, and GraphQL errors.
 */
async function gql(query, variables) {
  L.ANI('gql request', { url: ANILIST_URL, variables });

  const res = await fetch(ANILIST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query, variables })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    L.ANI('gql http error', { status: res.status, body: text?.slice?.(0, 500) });
    throw new Error(`AniList HTTP ${res.status}: ${text}`);
  }

  const json = await res.json().catch((e) => {
    L.ANI('gql json parse error', e?.message || e);
    throw e;
  });

  if (json.errors) {
    L.ANI('gql errors', json.errors);
    throw new Error(JSON.stringify(json.errors));
  }

  L.ANI('gql ok', { hasData: !!json.data });
  return json.data;
}

function pickTitle(t) {
  return t?.english || t?.romaji || t?.native || 'Unknown';
}

/**
 * Convert AniList media to a Stremio catalog meta.
 * NOTE: `kitsu_id` here is a placeholder (`kitsu:${media.id}`) and may not correspond
 * 1:1 to a real Kitsu ID. If you need true mapping, resolve via Yuna or your mapper.
 */
function toCatalogMeta(media) {
  const meta = {
    id: `anilist:${media.id}`,
    kitsu_id: `kitsu:${media.id}`, // placeholder; keep as in your original
    type: 'series',
    name: pickTitle(media.title),
    description: media.description ? String(media.description).replace(/<[^>]+>/g, '') : undefined,
    poster: media.coverImage?.large || media.coverImage?.medium,
    background: media.bannerImage || undefined,
    genres: media.genres || [],
    year: media.seasonYear || undefined,
  };
  return meta;
}

function getCurrentSeasonYear(now = new Date()) {
  const m = now.getUTCMonth() + 1; // 1..12
  const y = now.getUTCFullYear();
  if (m >= 1 && m <= 3) return { season: 'WINTER', seasonYear: y };
  if (m >= 4 && m <= 6) return { season: 'SPRING', seasonYear: y };
  if (m >= 7 && m <= 9) return { season: 'SUMMER', seasonYear: y };
  return { season: 'FALL', seasonYear: y };
}

function pageFromOffset(offset = 0, perPage = PAGE_SIZE) {
  return Math.floor(offset / perPage) + 1;
}

/**
 * Trending Now catalog (AniList)
 */
async function trendingEntries({ offset = 0, limit = PAGE_SIZE } = {}) {
  const page = pageFromOffset(offset, limit);
  const perPage = limit;

  L.ANI('trendingEntries start', { offset, limit, page, perPage });

  const query = `
  query ($page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) {
      media(
        type: ANIME,
        sort: TRENDING_DESC,
        status: RELEASING,
        format_not_in: [MOVIE]
      ) {
        id
        idMal
        format
        title { romaji english native }
        synonyms
        description(asHtml: false)
        season
        seasonYear
        coverImage { medium large extraLarge }
        bannerImage
        averageScore
        duration
        episodes
        trailer { id site thumbnail }
        siteUrl
        nextAiringEpisode { episode airingAt timeUntilAiring }
        externalLinks { site url }
        genres
      }
    }
  }`;

  try {
    const data = await gql(query, { page, perPage });
    const items = data?.Page?.media || [];
    L.ANI('trendingEntries response', { count: items.length });
    if (items[0]) L.ANI('trendingEntries first item', { id: items[0].id, title: items[0]?.title });

    const metas = items.map(toCatalogMeta);
    L.ANI('trendingEntries mapped metas', { count: metas.length, firstId: metas[0]?.id });
    return metas;
  } catch (e) {
    L.ANI('trendingEntries error', e?.message || e);
    throw e;
  }
}

/**
 * Popular This Season catalog (AniList)
 */
async function popularThisSeasonEntries({ offset = 0, limit = PAGE_SIZE } = {}) {
  const page = pageFromOffset(offset, limit);
  const perPage = limit;
  const { season, seasonYear } = getCurrentSeasonYear();

  L.ANI('popularThisSeason start', { offset, limit, page, perPage, season, seasonYear });

  const query = `
    query ($page: Int, $perPage: Int, $season: MediaSeason, $seasonYear: Int) {
      Page(page: $page, perPage: $perPage) {
        media(
          type: ANIME,
          season: $season,
          seasonYear: $seasonYear,
          sort: POPULARITY_DESC,
          format_not_in: [MOVIE]
        ) {
          id
          title { romaji english native }
          description(asHtml: false)
          seasonYear
          coverImage { medium large }
          bannerImage
          genres
        }
      }
    }
  `;

  try {
    const data = await gql(query, { page, perPage, season, seasonYear });
    const items = data?.Page?.media || [];
    L.ANI('popularThisSeason response', { count: items.length });
    if (items[0]) L.ANI('popularThisSeason first item', { id: items[0].id, title: items[0]?.title });

    const metas = items.map(toCatalogMeta);
    L.ANI('popularThisSeason mapped metas', { count: metas.length, firstId: metas[0]?.id });
    return metas;
  } catch (e) {
    L.ANI('popularThisSeason error', e?.message || e);
    throw e;
  }
}

module.exports = { trendingEntries, popularThisSeasonEntries, PAGE_SIZE };
