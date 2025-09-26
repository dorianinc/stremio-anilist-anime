const { mapToKitsuId } = require("./id_convert"); // <-- from within /lib

// anilist_catalog.js
// Minimal AniList-powered catalogs for the Kitsu add-on:
// - Trending Now
// - Popular This Season
// Returns Stremio-ready catalog metas using id: `anilist:{id}`.
// Movies are excluded via format_not_in: [MOVIE].

const ANILIST_URL = "https://graphql.anilist.co";
const PAGE_SIZE = 20;

/**
 * Lightweight GraphQL executor for AniList.
 */
async function gql(query, variables) {
  console.log("AniList gql: starting request");

  const res = await fetch(ANILIST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    console.log("AniList gql: http error");
    const text = await res.text().catch(() => "");
    throw new Error(`AniList HTTP ${res.status}: ${text}`);
  }

  const json = await res.json().catch((e) => {
    console.log("AniList gql: json parse error");
    throw e;
  });

  if (json.errors) {
    console.log("AniList gql: graphql error");
    throw new Error(JSON.stringify(json.errors));
  }

  console.log("AniList gql: request ok");
  return json.data;
}

// function pickTitle(t) {
//   return t?.english || t?.romaji || t?.native || "Unknown";
// }

/**
 * Convert AniList media to a Stremio catalog meta.
 */
async function toCatalogMeta(media) {
  console.log("AniList toCatalogMeta start");

  const anilistFullId = `anilist:${media.id}`;
  let kitsuNumericId = null;

  try {
    // map AniList -> Kitsu (numeric)
    kitsuNumericId = await mapToKitsuId(anilistFullId);
    console.log("AniList toCatalogMeta mapped");
  } catch {
    console.log("AniList toCatalogMeta map failed");
  }

  // Prefer Kitsu id for mobile compatibility; fall back to AniList if mapping failed
  const finalId = kitsuNumericId ? `kitsu:${kitsuNumericId}` : anilistFullId;

  return {
    id: finalId, // Kitsu when available, else AniList
    kitsu_id: kitsuNumericId || undefined,
    type: "series", // match your manifest catalog type
    name:
      media.title?.english ||
      media.title?.romaji ||
      media.title?.native ||
      "Unknown",
    description: media.description
      ? String(media.description).replace(/<[^>]+>/g, "")
      : undefined,
    poster: media.coverImage?.large || media.coverImage?.medium,
    background: media.bannerImage || undefined,
    genres: media.genres || [],
    year: media.seasonYear || undefined,
  };
}
function getCurrentSeasonYear(now = new Date()) {
  const m = now.getUTCMonth() + 1; // 1..12
  const y = now.getUTCFullYear();
  if (m >= 1 && m <= 3) return { season: "WINTER", seasonYear: y };
  if (m >= 4 && m <= 6) return { season: "SPRING", seasonYear: y };
  if (m >= 7 && m <= 9) return { season: "SUMMER", seasonYear: y };
  return { season: "FALL", seasonYear: y };
}

function pageFromOffset(offset = 0, perPage = PAGE_SIZE) {
  return Math.floor(offset / perPage) + 1;
}

/**
 * Trending Now catalog (AniList)
 */
async function trendingEntries({ offset = 0, limit = PAGE_SIZE } = {}) {
  console.log("AniList trendingEntries: start");

  const page = pageFromOffset(offset, limit);
  const perPage = limit;

  const query = `
  query TrendingTv($page: Int!, $perPage: Int!) {
    Page(page: $page, perPage: $perPage) {
      media(
        type: ANIME
        status_in: [RELEASING, FINISHED]
        format_in: [TV]
        genre_not_in: ["Hentai"]
        sort: [TRENDING_DESC]
      ) {
        id
        title { english romaji native }
        seasonYear
        genres
        description(asHtml: false)
        coverImage { medium large }
        bannerImage
      }
    }
  }
`;

  try {
    const data = await gql(query, { page, perPage });
    console.log("AniList trendingEntries: data received");

    const items = data?.Page?.media || [];
    // after fetching AniList items array:
    const metas = await Promise.all(items.map(toCatalogMeta));

    console.log("AniList trendingEntries: finished");
    return metas;
  } catch (e) {
    console.log("AniList trendingEntries: error");
    throw e;
  }
}
/**
 * Airing This Season (AniList) — at most 2 queries, combines results
 */
/**
 * Airing This Season (AniList) — always fetch the full season (1–2 requests),
 * then slice by offset/limit for Stremio.
 */
async function airingThisSeasonEntries() {
  console.log("AniList airingThisSeason: start");

  const PER_PAGE = 50;
  const { season, seasonYear } = getCurrentSeasonYear();

  const query = `
  query SeasonalAnime(
    $page: Int!
    $perPage: Int!
    $season: MediaSeason
    $seasonYear: Int
  ) {
    Page(page: $page, perPage: $perPage) {
      pageInfo {
        total
        hasNextPage
      }
      media(
        type: ANIME
        season: $season
        seasonYear: $seasonYear
        status_in: [RELEASING, FINISHED]
        format_in: [TV]
        genre_not_in: ["Hentai"]
        sort: [POPULARITY_DESC]
      ) {
        id
        title { english romaji native }
        seasonYear
        genres
        description(asHtml: false)
        coverImage { medium large }
        bannerImage
      }
    }
  }
`;

  try {
    // 1) Always fetch first page
    const res1 = await gql(query, {
      page: 1,
      perPage: PER_PAGE,
      season,
      seasonYear,
    });
    const pageInfo1 = res1?.Page?.pageInfo;
    const items1 = res1?.Page?.media ?? [];

    // 2) If there’s a second page, fetch it (covers >50 cases)
    let items = items1;
    if (pageInfo1?.hasNextPage) {
      const res2 = await gql(query, {
        page: 2,
        perPage: PER_PAGE,
        season,
        seasonYear,
      });
      const items2 = res2?.Page?.media ?? [];
      items = items1.concat(items2);
    }

    // 3) Convert once
    const metas = await Promise.all(items.map(toCatalogMeta));
    return metas;
  } catch (e) {
    console.log("AniList airingThisSeason: error", e?.message || e);
    throw e;
  }
}

module.exports = { trendingEntries, airingThisSeasonEntries, PAGE_SIZE };
