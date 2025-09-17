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

const manifest = {
  id: 'community.anime.kitsu',
  version: '0.0.11',
  name: 'Anime Kitsu + AniList',
  description: 'Kitsu-based meta/subtitles with AniList-powered Trending & Popular This Season catalogs.',
  logo: 'https://i.imgur.com/7N6XGoO.png',
  background: 'https://i.imgur.com/ym4n96o.png',
  resources: ['catalog', 'meta', 'subtitles'],
  types: ['anime', 'movie', 'series'],
  catalogs: [
    {
      id: 'anilist-anime-trending',
      name: 'Trending (AniList)',
      type: 'anime'
    },
    {
      id: 'anilist-anime-popular-season',
      name: 'Popular This Season (AniList)',
      type: 'anime'
    },
    // Keep original Kitsu catalogs if you want them too
    // {
    //   id: 'kitsu-anime-airing',
    //   name: 'Kitsu Top Airing',
    //   type: 'anime',
    //   extra: [{ name: 'genre', options: genres }, { name: 'skip' }],
    //   genres: genres
    // },
    // {
    //   id: 'kitsu-anime-popular',
    //   name: 'Kitsu Most Popular',
    //   type: 'anime',
    //   extra: [{ name: 'genre', options: genres }, { name: 'skip' }],
    //   genres: genres
    // },
    // {
    //   id: 'kitsu-anime-rating',
    //   name: 'Kitsu Highest Rated',
    //   type: 'anime',
    //   extra: [{ name: 'genre', options: genres }, { name: 'skip' }],
    //   genres: genres
    // },
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

const sortValue = {
  'kitsu-anime-list': 'createdAt',
  'kitsu-anime-rating': '-average_rating',
  'kitsu-anime-popular': '-user_count',
  'kitsu-anime-airing': '-average_rating'
};

const statusValue = {
  'kitsu-anime-airing': 'current'
};

builder.defineCatalogHandler((args) => {
  const skip = (args.extra && args.extra.skip) || 0;
  const idKey = `${args.id}|${(args.extra && args.extra.genre) || 'All'}|${skip}`;

  // --- AniList-powered catalogs (movies excluded inside the adapter) ---
  if (args.id === 'anilist-anime-trending') {
    console.log("loading trending animes from anilist")
    return cacheWrapCatalog(idKey, () =>
      anilistCatalog
        .trendingEntries({ offset: skip, limit: 20 })
        .then((metas) => ({ metas, cacheMaxAge: CACHE_MAX_AGE }))
    );
  }

  if (args.id === 'anilist-anime-popular-season') {
    console.log("loading popular this season from anilist")
    return cacheWrapCatalog(idKey, () =>
      anilistCatalog
        .popularThisSeasonEntries({ offset: skip, limit: 20 })
        .then((metas) => ({ metas, cacheMaxAge: CACHE_MAX_AGE }))
    );
  }

  // --- Original Kitsu flows (unchanged) ---
  if (args.extra?.search) {
    if (args.extra.search.match(/(?:https?|stremio):\/\//)) {
      return Promise.reject(`Invalid search term: ${args.extra.search}`);
    }
    // no need to cache search results
    return kitsu
      .search(args.extra.search)
      .then((metas) => ({ metas: metas, cacheMaxAge: CACHE_MAX_AGE }));
  }

  if (args.extra?.lastVideosIds) {
    return kitsu
      .list(args.extra.lastVideosIds)
      .then((metas) => ({ metas: metas, cacheMaxAge: CACHE_MAX_AGE }));
  }

  const options = {
    offset: skip,
    genre: args.extra?.genre,
    sort: sortValue[args.id],
    status: statusValue[args.id],
    trending: args.id === 'kitsu-anime-trending' // kept for backward compat if you later remove AniList override
  };

  return cacheWrapCatalog(idKey, () =>
    kitsu
      .animeEntries(options)
      .then((metas) => ({ metas: metas, cacheMaxAge: CACHE_MAX_AGE }))
  );
});

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

async function getKitsuIdMetadata(id) {
  return mapToKitsuId(id).then((kitsuId) =>
    cacheWrapMeta(kitsuId, () =>
      kitsu
        .animeData(kitsuId)
        .then((metadata) => enrichKitsuMetadata(metadata, cinemeta.getCinemetaMetadata))
        .then((meta) => ({ meta: meta, cacheMaxAge: CACHE_MAX_AGE }))
    )
  );
}

async function getImdbIdMetadata(id) {
  return cacheWrapMeta(id, () =>
    cinemeta
      .getCinemetaMetadata(id)
      .then((metadata) => enrichImdbMetadata(metadata, kitsu.animeData))
      .then((meta) => ({ meta: meta, cacheMaxAge: CACHE_MAX_AGE }))
  );
}

module.exports = builder.getInterface();
