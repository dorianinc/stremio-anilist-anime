const { addonBuilder } = require("stremio-addon-sdk");
const genres = require("./static/data/genres");
const {
  enrichKitsuMetadata,
  enrichImdbMetadata,
  hasImdbMapping,
} = require("./lib/metadataEnrich");
const { cacheWrapMeta, cacheWrapCatalog } = require("./lib/cache");
const { mapToKitsuId } = require("./lib/id_convert");
const kitsu = require("./lib/kitsu_api");
const cinemeta = require("./lib/cinemeta_api");
const opensubtitles = require("./lib/opensubtitles_api");
const anilistCatalog = require("./lib/anilist_catalog");

const CACHE_MAX_AGE = parseInt(process.env.CACHE_MAX_AGE) || 12 * 60 * 60; // 12 hour
// const CACHE_MAX_AGE = 0; // disable cache

const manifest = {
  id: "community.anime.dattebayo",
  version: "0.0.12",
  name: "Dattebayo",
  description:
    "Anime Kitsu-based meta/subtitles with AniList-powered Trending & Popular This Season catalogs.",
  logo: "https://i.ibb.co/pBknMb80/dattebayo-logo.png",
  background: "https://i.ibb.co/BJ0xMpX/dattebayo-background.png",
  resources: ["catalog", "meta", "subtitles"],
  types: ["anime", "movie", "series"],
  catalogs: [
    {
      id: "anilist-anime-trending",
      name: "Anilist Trending Now",
      type: "anime",
    },
    {
      id: "anilist-anime-airing-season",
      name: "Anilist Airing This Season",
      type: "anime",
    },
    // {
    //   id: "kitsu-anime-airing",
    //   name: "Kitsu Top Airing",
    //   type: "anime",
    //   extra: [{ name: "genre", options: genres }, { name: "skip" }],
    //   genres: genres,
    // },
    {
      id: "kitsu-anime-list",
      name: "Kitsu",
      type: "anime",
      extra: [
        { name: "search", isRequired: true },
        { name: "lastVideosIds", isRequired: false, optionsLimit: 20 },
        { name: "skip" },
      ],
    },
  ],
  idPrefixes: ["kitsu", "mal", "anilist", "anidb"],
};

const builder = new addonBuilder(manifest);

const sortValue = {
  "kitsu-anime-list": "createdAt",
  "kitsu-anime-rating": "-average_rating",
  "kitsu-anime-popular": "-user_count",
  "kitsu-anime-airing": "-average_rating",
};
const statusValue = { "kitsu-anime-airing": "current" };

// ----- CATALOG HANDLER -----
builder.defineCatalogHandler((args) => {
  console.log("catalog handler started");

  const skip = (args.extra && args.extra.skip) || 0;
  const idKey = `${args.id}|${(args.extra && args.extra.genre) || "All"}|${skip}`;

  if (args.id === "anilist-anime-trending") {
    console.log("anilist trending path");
    return cacheWrapCatalog(idKey, () =>
      anilistCatalog.trendingEntries({ offset: skip, limit: 20 }).then((metas) => {
        console.log("anilist trending finished");
        return { metas, cacheMaxAge: CACHE_MAX_AGE };
      }).catch((e) => {
        console.log("anilist trending error");
        throw e;
      })
    );
  }

  if (args.id === "anilist-anime-airing-season") {
    console.log("anilist popular season path");
    return cacheWrapCatalog(idKey, () =>
      anilistCatalog.airingThisSeasonEntries({ offset: skip, limit: 20 }).then((metas) => {
        console.log("anilist popular season finished");
        return { metas, cacheMaxAge: CACHE_MAX_AGE };
      }).catch((e) => {
        console.log("anilist popular season error");
        throw e;
      })
    );
  }

  if (args.extra?.search) {
    console.log("kitsu search path");
    if (args.extra.search.match(/(?:https?|stremio):\/\//)) {
      console.log("invalid search term");
      return Promise.reject(`Invalid search term: ${args.extra.search}`);
    }
    return kitsu.search(args.extra.search).then((metas) => {
      console.log("kitsu search finished");
      return { metas, cacheMaxAge: CACHE_MAX_AGE };
    }).catch((e) => {
      console.log("kitsu search error");
      throw e;
    });
  }

  if (args.extra?.lastVideosIds) {
    console.log("kitsu list path");
    return kitsu.list(args.extra.lastVideosIds).then((metas) => {
      console.log("kitsu list finished");
      return { metas, cacheMaxAge: CACHE_MAX_AGE };
    }).catch((e) => {
      console.log("kitsu list error");
      throw e;
    });
  }

  console.log("kitsu general entries path");
  const options = {
    offset: skip,
    genre: args.extra?.genre,
    sort: sortValue[args.id],
    status: statusValue[args.id],
    trending: args.id === "kitsu-anime-trending",
  };

  return cacheWrapCatalog(idKey, () =>
    kitsu.animeEntries(options).then((metas) => {
      console.log("kitsu entries finished");
      return { metas, cacheMaxAge: CACHE_MAX_AGE };
    }).catch((e) => {
      console.log("kitsu entries error");
      throw e;
    })
  );
});

// ----- META HANDLER -----
builder.defineMetaHandler((args) => {
  console.log("🖥️ ~ args: ", args)
  console.log("meta handler started");
  if (args.id.match(/^(?:kitsu|mal|anilist|anidb):\d+$/)) {
    console.log("meta kitsu path");
    return getKitsuIdMetadata(args.id).then((res) => {
      console.log("meta kitsu finished");
      return res;
    }).catch((e) => {
      console.log("meta kitsu error");
      throw e;
    });
  }

  if (args.id.match(/^tt\d+$/)) {
    console.log("meta imdb path");
    if (!hasImdbMapping(args.id)) {
      console.log("meta imdb missing mapping");
      return Promise.reject(`No imdb mapping for: ${args.id}`);
    }
    return getImdbIdMetadata(args.id).then((res) => {
      console.log("meta imdb finished");
      return res;
    }).catch((e) => {
      console.log("meta imdb error");
      throw e;
    });
  }

  console.log("meta invalid id");
  return Promise.reject(`Invalid id: ${args.id}`);
});

// ----- SUBTITLES HANDLER -----
builder.defineSubtitlesHandler((args) => {
  console.log("subtitles handler started");

  if (!args.id.match(/^(?:kitsu|mal|anilist|anidb):\d+(?::\d+)?$/)) {
    console.log("subtitles invalid id");
    return Promise.reject(`Invalid id: ${args.id}`);
  }

  return getKitsuIdMetadata(args.id)
    .then((metaResponse) => {
      console.log("subtitles meta ok");
      return metaResponse.meta;
    })
    .then((metadata) => opensubtitles.getRedirectUrl(metadata, args))
    .then((url) => {
      console.log("subtitles redirect ok");
      return { redirect: url };
    })
    .catch((e) => {
      console.log("subtitles error")
      throw e
      return { subtitles: [] };
    });
});

// ----- INTERNAL HELPERS -----
async function getKitsuIdMetadata(id) {
  console.log("getKitsuIdMetadata start");

  return mapToKitsuId(id).then((kitsuId) => {
    console.log("mapped to kitsu id");
    return cacheWrapMeta(kitsuId, () =>
      kitsu.animeData(kitsuId).then((metadata) => {
        // console.log("🖥️ ~ metadata: ", metadata)
        console.log("kitsu.animeData finished");
        return enrichKitsuMetadata(metadata, cinemeta.getCinemetaMetadata);
      }).then((meta) => {
        console.log("enrich kitsu finished");
        return { meta, cacheMaxAge: CACHE_MAX_AGE };
      })
    );
  }).catch((e) => {
    console.log("getKitsuIdMetadata error");
    throw e;
  });
}

async function getImdbIdMetadata(id) {
  console.log("getImdbIdMetadata start");

  return cacheWrapMeta(id, () =>
    cinemeta.getCinemetaMetadata(id).then((metadata) => {
      console.log("cinemeta finished");
      return enrichImdbMetadata(metadata, kitsu.animeData);
    }).then((meta) => {
      console.log("enrich imdb finished");
      return { meta, cacheMaxAge: CACHE_MAX_AGE };
    })
  ).catch((e) => {
    console.log("getImdbIdMetadata error");
    throw e;
  });
}

module.exports = builder.getInterface();
