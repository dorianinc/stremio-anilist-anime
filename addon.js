const { addonBuilder } = require('stremio-addon-sdk');
const genres = require('./static/data/genres');
const { enrichKitsuMetadata, enrichImdbMetadata, hasImdbMapping } = require('./lib/metadataEnrich');
const { cacheWrapMeta, cacheWrapCatalog } = require('./lib/cache');
const { mapToKitsuId } = require('./lib/id_convert');
const kitsu = require('./lib/kitsu_api');
const cinemeta = require('./lib/cinemeta_api');
const opensubtitles = require('./lib/opensubtitles_api');
// NEW: lightweight AniList catalogs (Trending, Popular This Season)
const anilistCatalog = require('./lib/anilist_catalog');

const CACHE_MAX_AGE = parseInt(process.env.CACHE_MAX_AGE) || 12 * 60 * 60; // 12 hours
// const CACHE_MAX_AGE = 0;

/**
 * Stremio addon manifest describing:
 * - resources exposed (catalog, meta, subtitles)
 * - supported content types (anime, movie, series)
 * - catalogs (AniList trending/popular and Kitsu-based lists)
 * - accepted ID prefixes (kitsu, mal, anilist, anidb)
 */
const manifest = {
  id: 'community.anime.dattebayo',
  version: '0.0.11',
  name: 'Dattebayo',
  description: 'Anime Kitsu-based meta/subtitles with AniList-powered Trending & Popular This Season catalogs.',
  logo: 'https://i.ibb.co/pBknMb80/dattebayo-logo.png',
  background: 'https://i.ibb.co/BJ0xMpX/dattebayo-background.png',
  resources: ['catalog', 'meta', 'subtitles'],
  types: ['anime', 'movie', 'series'],
  catalogs: [
    {
      id: 'anilist-anime-trending',
      name: 'Anilist Trending',
      type: 'anime'
    },
    // {
    //   id: 'anilist-anime-popular-season',
    //   name: 'Anilist Popular This Season',
    //   type: 'anime'
    // },
    {
      id: 'kitsu-anime-airing',
      name: 'Kitsu Top Airing',
      type: 'anime',
      extra: [{ name: 'genre', options: genres }, { name: 'skip' }],
      genres: genres
    },
    {
      id: 'kitsu-anime-list',
      name: 'Kitsu',
      type: 'anime',
      extra: [
        { name: 'search', isRequired: true },
        { name: 'lastVideosIds', isRequired: false, optionsLimit: 20 },
        { name: 'skip' }
      ]
    }
  ],
  idPrefixes: ['kitsu', 'mal', 'anilist', 'anidb']
};

const builder = new addonBuilder(manifest);

/**
 * Mapping of catalog id -> Kitsu sort field expected by your Kitsu API wrapper.
 * (Negative prefix like '-average_rating' means descending order.)
 */
const sortValue = {
  'kitsu-anime-list': 'createdAt',
  'kitsu-anime-rating': '-average_rating',
  'kitsu-anime-popular': '-user_count',
  'kitsu-anime-airing': '-average_rating'
};

/**
 * Mapping of catalog id -> Kitsu status filter.
 * For example, "current" narrows to currently airing shows.
 */
const statusValue = {
  'kitsu-anime-airing': 'current'
};

/**
 * Catalog handler
 * ----------------
 * Returns lists of metadata entries ("metas") for the requested catalog.
 *
 * Supports:
 *  - AniList Trending (and optional Popular This Season)
 *  - Kitsu search ("kitsu-anime-list" with `extra.search`)
 *  - Kitsu list by lastVideosIds (to batch-resolve multiple ids)
 *  - Kitsu general entries (with optional genre/sort/status)
 *
 * Caching:
 *  Uses cacheWrapCatalog with a key derived from catalog id, genre, and skip.
 *
 * @param {Object} args - Stremio catalog request args
 * @param {string} args.id - Catalog identifier (e.g., 'anilist-anime-trending', 'kitsu-anime-airing')
 * @param {Object} [args.extra] - Extra params like { search, genre, skip, lastVideosIds }
 * @returns {Promise<{ metas: Array, cacheMaxAge: number }>}
 */
builder.defineCatalogHandler((args) => {
  const skip = (args.extra && args.extra.skip) || 0;
  const idKey = `${args.id}|${(args.extra && args.extra.genre) || 'All'}|${skip}`;

  // AniList: Trending catalog
  if (args.id === 'anilist-anime-trending') {
    return cacheWrapCatalog(idKey, () =>
      anilistCatalog
        .trendingEntries({ offset: skip, limit: 20 })
        .then((metas) => ({ metas, cacheMaxAge: CACHE_MAX_AGE }))
    );
  }

  // AniList: Popular this season (if you decide to re-enable it above)
  if (args.id === 'anilist-anime-popular-season') {
    return cacheWrapCatalog(idKey, () =>
      anilistCatalog
        .popularThisSeasonEntries({ offset: skip, limit: 20 })
        .then((metas) => ({ metas, cacheMaxAge: CACHE_MAX_AGE }))
    );
  }

  // Kitsu: search-by-text flow (kitsu-anime-list with `extra.search`)
  if (args.extra?.search) {
    // Basic guard against URLs being passed as a search query
    if (args.extra.search.match(/(?:https?|stremio):\/\//)) {
      return Promise.reject(`Invalid search term: ${args.extra.search}`);
    }
    return kitsu
      .search(args.extra.search)
      .then((metas) => ({ metas, cacheMaxAge: CACHE_MAX_AGE }));
  }

  // Kitsu: list by explicit ids flow (kitsu-anime-list with `extra.lastVideosIds`)
  if (args.extra?.lastVideosIds) {
    return kitsu
      .list(args.extra.lastVideosIds)
      .then((metas) => ({ metas, cacheMaxAge: CACHE_MAX_AGE }));
  }

  // Kitsu: general catalog flow (airing/top/etc.)
  const options = {
    offset: skip,
    genre: args.extra?.genre,
    sort: sortValue[args.id],
    status: statusValue[args.id],
    trending: args.id === 'kitsu-anime-trending'
  };

  return cacheWrapCatalog(idKey, () =>
    kitsu
      .animeEntries(options)
      .then((metas) => ({ metas, cacheMaxAge: CACHE_MAX_AGE }))
  );
});

/**
 * Meta handler
 * ------------
 * Resolves detailed metadata for a single item.
 *
 * ID routing:
 *  - If id looks like "<kitsu|mal|anilist|anidb>:<num>" (optionally with :<episode> for subtitles),
 *    we map/normalize to a Kitsu id and fetch enriched Kitsu metadata.
 *  - If id looks like "tt<digits>", it's treated as an IMDb id. We verify we have an IMDb mapping,
 *    then fetch Cinemeta data, enrich with Kitsu where possible, and return the enriched meta.
 *
 * @param {Object} args - Stremio meta request args
 * @param {string} args.id - The content id (e.g., "kitsu:123", "anilist:999", or "tt1234567")
 * @returns {Promise<{ meta: Object, cacheMaxAge: number }>}
 */
builder.defineMetaHandler((args) => {
  if (args.id.match(/^(?:kitsu|mal|anilist|anidb):\d+$/)) {
    return getKitsuIdMetadata(args.id);
  }

  if (args.id.match(/^tt\d+$/)) {
    const id = args.id;
    if (!hasImdbMapping(id)) {
      return Promise.reject(`No imdb mapping for: ${id}`);
    }
    return getImdbIdMetadata(id);
  }

  return Promise.reject(`Invalid id: ${args.id}`);
});

/**
 * Subtitles handler
 * -----------------
 * Produces a redirect URL to OpenSubtitles (or returns an empty list on failure).
 *
 * Flow:
 *  1) Validate the id format for Kitsu/MAL/AniList/AniDB (optionally with episode suffix).
 *  2) Resolve metadata (via Kitsu id path).
 *  3) Ask OpenSubtitles module to compute a redirect URL based on the metadata and args.
 *
 * @param {Object} args - Stremio subtitles request args
 * @param {string} args.id - The content id, e.g., "kitsu:123:1" for episode 1
 * @returns {Promise<{ redirect: string } | { subtitles: [] }>}
 */
builder.defineSubtitlesHandler((args) => {
  if (!args.id.match(/^(?:kitsu|mal|anilist|anidb):\d+(?::\d+)?$/)) {
    return Promise.reject(`Invalid id: ${args.id}`);
  }

  return getKitsuIdMetadata(args.id)
    .then((metaResponse) => metaResponse.meta)
    .then((metadata) => opensubtitles.getRedirectUrl(metadata, args))
    .then((url) => ({ redirect: url }))
    .catch(() => ({ subtitles: [] }));
});

/**
 * getKitsuIdMetadata
 * ------------------
 * Given an id that may be "kitsu:<id>" or a foreign id like "anilist:<id>" or "mal:<id>",
 * normalize/map it to a Kitsu id, fetch base metadata from Kitsu, enrich it (e.g., with Cinemeta),
 * and return a Stremio meta response object.
 *
 * Caching:
 *  - Uses cacheWrapMeta keyed by the resolved Kitsu id.
 *
 * @param {string} id - Input id ("kitsu:123", "anilist:456", "mal:789", "anidb:42")
 * @returns {Promise<{ meta: Object, cacheMaxAge: number }>}
 */
async function getKitsuIdMetadata(id) {
  return mapToKitsuId(id).then((kitsuId) =>
    cacheWrapMeta(kitsuId, () =>
      kitsu
        .animeData(kitsuId)
        .then((metadata) => enrichKitsuMetadata(metadata, cinemeta.getCinemetaMetadata))
        .then((meta) => ({ meta, cacheMaxAge: CACHE_MAX_AGE }))
    )
  );
}

/**
 * getImdbIdMetadata
 * -----------------
 * Given an IMDb id (e.g., "tt1234567"), fetch Cinemeta metadata first,
 * then enrich it using Kitsu data (to fill anime-specific or missing fields),
 * and return a Stremio meta response object.
 *
 * Caching:
 *  - Uses cacheWrapMeta keyed by the IMDb id.
 *
 * @param {string} id - IMDb id like "tt1234567"
 * @returns {Promise<{ meta: Object, cacheMaxAge: number }>}
 */
async function getImdbIdMetadata(id) {
  return cacheWrapMeta(id, () =>
    cinemeta
      .getCinemetaMetadata(id)
      .then((metadata) => enrichImdbMetadata(metadata, kitsu.animeData))
      .then((meta) => ({ meta, cacheMaxAge: CACHE_MAX_AGE }))
  );
}

module.exports = builder.getInterface();
