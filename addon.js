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

// const CACHE_MAX_AGE = parseInt(process.env.CACHE_MAX_AGE) || 12 * 60 * 60; // 12 hours
const CACHE_MAX_AGE = 0;

console.log("📦 Initializing Dattebayo addon...");

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
  console.log("🖥️ defineCatalogHandler called with args:", JSON.stringify(args, null, 2));
  const skip = (args.extra && args.extra.skip) || 0;
  const idKey = `${args.id}|${(args.extra && args.extra.genre) || 'All'}|${skip}`;
  console.log("📌 Computed idKey:", idKey);

  console.log("==> in A");
  if (args.id === 'anilist-anime-trending') {
    console.log("🔥 Loading AniList trending animes...");
    return cacheWrapCatalog(idKey, () =>
      anilistCatalog
        .trendingEntries({ offset: skip, limit: 20 })
        .then((metas) => {
          console.log("✅ AniList trending metas received:", metas?.length);
          return { metas, cacheMaxAge: CACHE_MAX_AGE };
        })
    );
  }

  if (args.id === 'anilist-anime-popular-season') {
    console.log("🔥 Loading AniList popular this season...");
    return cacheWrapCatalog(idKey, () =>
      anilistCatalog
        .popularThisSeasonEntries({ offset: skip, limit: 20 })
        .then((metas) => {
          console.log("✅ AniList popular season metas received:", metas?.length);
          return { metas, cacheMaxAge: CACHE_MAX_AGE };
        })
    );
  }

  console.log("==> ==> Avocado (fallback to Kitsu)");

  if (args.extra?.search) {
    console.log("==> in B (search flow)");
    if (args.extra.search.match(/(?:https?|stremio):\/\//)) {
      console.log("❌ Invalid search term:", args.extra.search);
      return Promise.reject(`Invalid search term: ${args.extra.search}`);
    }
    console.log("🔍 Searching kitsu for:", args.extra.search);
    return kitsu
      .search(args.extra.search)
      .then((metas) => {
        console.log("✅ Search results from kitsu:", metas?.length);
        return { metas: metas, cacheMaxAge: CACHE_MAX_AGE };
      });
  }

  if (args.extra?.lastVideosIds) {
    console.log("==> in E (list flow with lastVideosIds)");
    console.log("🎞️ lastVideosIds:", args.extra.lastVideosIds);
    return kitsu
      .list(args.extra.lastVideosIds)
      .then((metas) => {
        console.log("✅ List results from kitsu:", metas?.length);
        return { metas: metas, cacheMaxAge: CACHE_MAX_AGE };
      });
  }

  const options = {
    offset: skip,
    genre: args.extra?.genre,
    sort: sortValue[args.id],
    status: statusValue[args.id],
    trending: args.id === 'kitsu-anime-trending'
  };
  console.log("🛠️ Options for kitsu.animeEntries:", options);
  console.log("==> in F");
  return cacheWrapCatalog(idKey, () =>
    kitsu
      .animeEntries(options)
      .then((metas) => {
        console.log("✅ Anime entries from kitsu:", metas?.length);
        return { metas: metas, cacheMaxAge: CACHE_MAX_AGE };
      })
  );
});

builder.defineMetaHandler((args) => {
  console.log("🖥️ defineMetaHandler called with args:", JSON.stringify(args, null, 2));
  if (args.id.match(/^(?:kitsu|mal|anilist|anidb):\d+$/)) {
    console.log("==> in #1 (kitsu/mal/anilist/anidb id path)");
    return getKitsuIdMetadata(args.id);
  }
  if (args.id.match(/^tt\d+$/)) {
    console.log("==> in #2 (IMDb id path)");
    const id = args.id;
    if (!hasImdbMapping(id)) {
      console.log("❌ No imdb mapping for:", id);
      return Promise.reject(`No imdb mapping for: ${id}`);
    }
    console.log("==> in #4 (fetching IMDb metadata)");
    return getImdbIdMetadata(id);
  }
  console.log("❌ Invalid id received:", args.id);
  return Promise.reject(`Invalid id: ${args.id}`);
});

builder.defineSubtitlesHandler((args) => {
  console.log("🖥️ defineSubtitlesHandler called with args:", JSON.stringify(args, null, 2));
  console.log("==> in #5");
  if (!args.id.match(/^(?:kitsu|mal|anilist|anidb):\d+(?::\d+)?$/)) {
    console.log("❌ Invalid subtitle id:", args.id);
    console.log("==> in #6");
    return Promise.reject(`Invalid id: ${args.id}`);
  }

  console.log("📥 Fetching metadata for subtitles from:", args.id);
  return getKitsuIdMetadata(args.id)
    .then((metaResponse) => {
      console.log("✅ Metadata response in subtitles handler:", !!metaResponse?.meta);
      return metaResponse.meta;
    })
    .then((metadata) => {
      console.log("📡 Passing metadata to opensubtitles:", metadata?.name);
      return opensubtitles.getRedirectUrl(metadata, args);
    })
    .then((url) => {
      console.log("✅ Subtitle redirect url received:", url);
      return { redirect: url };
    })
    .catch((err) => {
      console.log("⚠️ Subtitle handler failed:", err?.message || err);
      return { subtitles: [] };
    });
});

async function getKitsuIdMetadata(id) {
  console.log("==> in #7 (getKitsuIdMetadata)");
  console.log("🆔 Raw id received:", id);
  return mapToKitsuId(id).then((kitsuId) => {
    console.log("🔄 Mapped id:", kitsuId);
    return cacheWrapMeta(kitsuId, () => {
      console.log("📡 Fetching animeData from kitsu for:", kitsuId);
      return kitsu
        .animeData(kitsuId)
        .then((metadata) => {
          console.log("✅ Raw metadata received from kitsu");
          return enrichKitsuMetadata(metadata, cinemeta.getCinemetaMetadata);
        })
        .then((meta) => {
          console.log("✅ Enriched kitsu metadata prepared");
          return { meta: meta, cacheMaxAge: CACHE_MAX_AGE };
        });
    });
  });
}

async function getImdbIdMetadata(id) {
  console.log("==> in #8 (getImdbIdMetadata)");
  console.log("🎬 IMDb id:", id);
  return cacheWrapMeta(id, () => {
    console.log("📡 Fetching Cinemeta metadata for IMDb id:", id);
    return cinemeta
      .getCinemetaMetadata(id)
      .then((metadata) => {
        console.log("✅ Raw metadata received from cinemeta");
        return enrichImdbMetadata(metadata, kitsu.animeData);
      })
      .then((meta) => {
        console.log("✅ Enriched IMDb metadata prepared");
        return { meta: meta, cacheMaxAge: CACHE_MAX_AGE };
      });
  });
}

console.log("✅ Dattebayo addon initialized");

module.exports = builder.getInterface();
