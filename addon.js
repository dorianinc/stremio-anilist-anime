const { addonBuilder } = require('stremio-addon-sdk');
const genres = require('./static/data/genres');
const { enrichKitsuMetadata, enrichImdbMetadata, hasImdbMapping } = require('./lib/metadataEnrich');
const { cacheWrapMeta, cacheWrapCatalog } = require('./lib/cache');
const { mapToKitsuId } = require('./lib/id_convert');
const kitsu = require('./lib/kitsu_api');
const cinemeta = require('./lib/cinemeta_api');
const opensubtitles = require('./lib/opensubtitles_api');
// Lightweight AniList catalogs (Trending, Popular This Season)
const anilistCatalog = require('./lib/anilist_catalog');

// const CACHE_MAX_AGE = parseInt(process.env.CACHE_MAX_AGE) || 12 * 60 * 60; // 12 hours
const CACHE_MAX_AGE = 0;

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
      type: 'series'
    },
    // {
    //   id: 'anilist-anime-popular-season',
    //   name: 'Anilist Popular This Season',
    //   type: 'series'
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
 * Catalog sort mapping used by Kitsu client.
 */
const sortValue = {
  'kitsu-anime-list': 'createdAt',
  'kitsu-anime-rating': '-average_rating',
  'kitsu-anime-popular': '-user_count',
  'kitsu-anime-airing': '-average_rating'
};

/**
 * Catalog status mapping used by Kitsu client.
 */
const statusValue = {
  'kitsu-anime-airing': 'current'
};

/**
 * Fire-and-forget cache warmup: for AniList metas, pre-map to Kitsu id.
 * This reduces latency when the client opens the detail page (meta route),
 * which helps avoid mobile timeouts.
 *
 * @param {Array<Object>} metas
 */
function prewarmMappings(metas) {
  metas
    .filter((m) => /^anilist:\d+$/.test(m.id))
    .forEach((m) => {
      // ignore errors; meta route will retry anyway
      mapToKitsuId(m.id).catch(() => {});
    });
}

builder.defineCatalogHandler((args) => {
  const skip = (args.extra && args.extra.skip) || 0;
  const idKey = `${args.id}|${(args.extra && args.extra.genre) || 'All'}|${skip}`;

  // AniList: Trending
  if (args.id === 'anilist-anime-trending') {
    return cacheWrapCatalog(idKey, () =>
      anilistCatalog
        .trendingEntries({ offset: skip, limit: 20 })
        .then((metas) => {
          prewarmMappings(metas);
          return { metas, cacheMaxAge: CACHE_MAX_AGE };
        })
    );
  }

  // AniList: Popular this season (if re-enabled)
  if (args.id === 'anilist-anime-popular-season') {
    return cacheWrapCatalog(idKey, () =>
      anilistCatalog
        .popularThisSeasonEntries({ offset: skip, limit: 20 })
        .then((metas) => {
          prewarmMappings(metas);
          return { metas, cacheMaxAge: CACHE_MAX_AGE };
        })
    );
  }

  // Kitsu: search-by-text flow
  if (args.extra?.search) {
    if (args.extra.search.match(/(?:https?|stremio):\/\//)) {
      return Promise.reject(`Invalid search term: ${args.extra.search}`);
    }
    return kitsu
      .search(args.extra.search)
      .then((metas) => ({ metas, cacheMaxAge: CACHE_MAX_AGE }));
  }

  // Kitsu: list by explicit ids flow
  if (args.extra?.lastVideosIds) {
    return kitsu
      .list(args.extra.lastVideosIds)
      .then((metas) => ({ metas, cacheMaxAge: CACHE_MAX_AGE }));
  }

  // Kitsu: general catalog flow
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
 * Meta handler:
 *  - Accept "<source>:<id>" and also "<source>:<id>:<episode>" (mobile sometimes asks with episode)
 *  - IMDb branch unchanged (guarded by hasImdbMapping)
 *  - Graceful fallback on mapping failure to avoid hard "error" on mobile
 */
builder.defineMetaHandler((args) => {
  // Accept optional :episode suffix like the subtitles handler does
  if (args.id.match(/^(?:kitsu|mal|anilist|anidb):\d+(?::\d+)?$/)) {
    return getKitsuIdMetadata(args.id).catch(() => {
      // Safety net: return a minimal meta so the client doesn’t blow up
      return {
        meta: {
          id: args.id,
          name: 'Temporarily unavailable',
          type: 'series',
          videos: []
        },
        cacheMaxAge: 60 // retry soon
      };
    });
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
 * Subtitles handler: unchanged behavior, validates id (allows :episode),
 * fetches meta via kitsu-id path, asks OpenSubtitles for redirect URL.
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
 * Normalize to Kitsu id and build enriched meta.
 * Also strips optional :episode suffix before mapping.
 *
 * @param {string} id - "<source>:<num>" or "<source>:<num>:<episode>"
 * @returns {Promise<{ meta: Object, cacheMaxAge: number }>}
 */
async function getKitsuIdMetadata(id) {
  const baseId = id.replace(/:\d+$/, ''); // drop :episode if present
  return mapToKitsuId(baseId).then((kitsuId) =>
    cacheWrapMeta(kitsuId, () =>
      kitsu
        .animeData(kitsuId)
        .then((metadata) => enrichKitsuMetadata(metadata, cinemeta.getCinemetaMetadata))
        .then((meta) => ({ meta, cacheMaxAge: CACHE_MAX_AGE }))
    )
  );
}

/**
 * IMDb meta path: fetch Cinemeta, enrich with Kitsu hints, return.
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
