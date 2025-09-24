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
const { scope } = require("./lib/logger");

const L = {
  CAT: scope("CATALOG"),
  META: scope("META"),
  SUB: scope("SUBTITLES"),
  FLOW: scope("FLOW"),
  ERR: scope("ERROR"),
};

// const CACHE_MAX_AGE = parseInt(process.env.CACHE_MAX_AGE) || 12 * 60 * 60; // 12 hours
const CACHE_MAX_AGE = 0;

const manifest = {
  id: "community.anime.dattebayo",
  version: "0.0.11",
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
      name: "Anilist Trending",
      type: "anime",
    },
    // {
    //   id: 'anilist-anime-popular-season',
    //   name: 'Anilist Popular This Season',
    //   type: 'series'
    // },
    {
      id: "kitsu-anime-airing",
      name: "Kitsu Top Airing",
      type: "anime",
      extra: [{ name: "genre", options: genres }, { name: "skip" }],
      genres: genres,
    },
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

const statusValue = {
  "kitsu-anime-airing": "current",
};

/**
 * Catalog handler with deep logging.
 */
builder.defineCatalogHandler((args) => {
  // L.CAT("incoming args", JSON.stringify(args, null, 2));

  const skip = (args.extra && args.extra.skip) || 0;
  const idKey = `${args.id}|${
    (args.extra && args.extra.genre) || "All"
  }|${skip}`;
  // L.CAT("computed key", idKey);

  // AniList: Trending
  if (args.id === "anilist-anime-trending") {
    // L.FLOW("AniList trending -> anilistCatalog.trendingEntries start", {
    //   skip,
    // });
    return cacheWrapCatalog(idKey, () =>
      anilistCatalog
        .trendingEntries({ offset: skip, limit: 20 })
        .then((metas) => {
          L.CAT("AniList trending metas count", metas?.length);
          if (metas?.length) {
            L.CAT("first meta sample", JSON.stringify(metas[0], null, 2));
          }
          return { metas, cacheMaxAge: CACHE_MAX_AGE };
        })
        .catch((e) => {
          L.ERR("AniList trending error", e?.message || e);
          throw e;
        })
    );
  }

  // AniList: Popular This Season (if re-enabled in manifest)
  if (args.id === "anilist-anime-popular-season") {
    // L.FLOW(
    //   "AniList popularThisSeason -> anilistCatalog.popularThisSeasonEntries start",
    //   { skip }
    // );
    return cacheWrapCatalog(idKey, () =>
      anilistCatalog
        .popularThisSeasonEntries({ offset: skip, limit: 20 })
        .then((metas) => {
          L.CAT("AniList popular season metas count", metas?.length);
          if (metas?.length) {
            L.CAT("first meta sample", JSON.stringify(metas[0], null, 2));
          }
          return { metas, cacheMaxAge: CACHE_MAX_AGE };
        })
        .catch((e) => {
          L.ERR("AniList popular season error", e?.message || e);
          throw e;
        })
    );
  }

  // Kitsu: search flow
  if (args.extra?.search) {
    // L.FLOW("Kitsu search flow", { search: args.extra.search });
    if (args.extra.search.match(/(?:https?|stremio):\/\//)) {
      // L.ERR("Invalid search term", args.extra.search);
      return Promise.reject(`Invalid search term: ${args.extra.search}`);
    }
    return kitsu
      .search(args.extra.search)
      .then((metas) => {
        // L.CAT("Kitsu search results", metas?.length);
        return { metas, cacheMaxAge: CACHE_MAX_AGE };
      })
      .catch((e) => {
        // L.ERR("Kitsu search error", e?.message || e);
        throw e;
      });
  }

  // Kitsu: list by explicit ids
  if (args.extra?.lastVideosIds) {
    // L.FLOW("Kitsu list flow (lastVideosIds)", args.extra.lastVideosIds);
    return kitsu
      .list(args.extra.lastVideosIds)
      .then((metas) => {
        // L.CAT("Kitsu list results", metas?.length);
        return { metas, cacheMaxAge: CACHE_MAX_AGE };
      })
      .catch((e) => {
        // L.ERR("Kitsu list error", e?.message || e);
        throw e;
      });
  }

  // Kitsu: general entries (airing/top/etc.)
  const options = {
    offset: skip,
    genre: args.extra?.genre,
    sort: sortValue[args.id],
    status: statusValue[args.id],
    trending: args.id === "kitsu-anime-trending",
  };
  L.FLOW("Kitsu general entries options", options);

  return cacheWrapCatalog(idKey, () =>
    kitsu
      .animeEntries(options)
      .then((metas) => {
        // L.CAT("kitsu.animeEntries results", metas?.length);
        return { metas, cacheMaxAge: CACHE_MAX_AGE };
      })
      .catch((e) => {
        // L.ERR("kitsu.animeEntries error", e?.message || e);
        throw e;
      })
  );
});

/**
 * Meta handler with deep logging.
 */
builder.defineMetaHandler((args) => {
  // L.META("incoming id", args.id);

  if (args.id.match(/^(?:kitsu|mal|anilist|anidb):\d+$/)) {
    // L.FLOW("meta route -> getKitsuIdMetadata");
    console.log("death cab for cutie")
    return getKitsuIdMetadata(args.id)
      .then((res) => {
        // L.META(
        //   "meta result (kitsu/anilist/mal/anidb) fields",
        //   Object.keys(res.meta || {})
        // );
        console.log("fall out boy")
        if (Array.isArray(res.meta?.videos))
          console.log("the story so far")
          // L.META("videos count", res.meta.videos.length);
        return res;
      })
      .catch((e) => {
        console.log("three days grace")
        // L.ERR("getKitsuIdMetadata error", e?.message || e);
        throw e;
      });
  }

  if (args.id.match(/^tt\d+$/)) {
    // L.FLOW("meta route -> IMDb");
    const id = args.id;
    if (!hasImdbMapping(id)) {
      // L.ERR("no imdb mapping", id);
      return Promise.reject(`No imdb mapping for: ${id}`);
    }
    return getImdbIdMetadata(id)
      .then((res) => {
        // L.META("meta result (imdb) fields", Object.keys(res.meta || {}));
        return res;
      })
      .catch((e) => {
        // L.ERR("getImdbIdMetadata error", e?.message || e);
        throw e;
      });
  }

  L.ERR("invalid id", args.id);
  return Promise.reject(`Invalid id: ${args.id}`);
});

/**
 * Subtitles handler with deep logging.
 */
builder.defineSubtitlesHandler((args) => {
  // L.SUB("incoming id", args.id);

  if (!args.id.match(/^(?:kitsu|mal|anilist|anidb):\d+(?::\d+)?$/)) {
    // L.ERR("invalid subtitle id", args.id);
    return Promise.reject(`Invalid id: ${args.id}`);
  }
  console.log("------> apple over here!");
  return getKitsuIdMetadata(args.id)
    .then((metaResponse) => {
      // L.SUB("meta ok?", !!metaResponse?.meta);
      console.log(" ---> banana");
      return metaResponse.meta;
    })
    .then((metadata) => opensubtitles.getRedirectUrl(metadata, args))
    .then((url) => {
      // L.SUB("opensubtitles redirect", url);
      console.log("taking back sunday")
      return { redirect: url };
    })
    .catch((err) => {
      console.log("jimmy eat world")
      L.ERR("subtitles handler failed", err?.message || err);
      return { subtitles: [] };
    });
});

/**
 * Fetch/enrich metadata via Kitsu path (supports kitsu/mal/anilist/anidb ids).
 */
async function getKitsuIdMetadata(id) {
  // L.FLOW("getKitsuIdMetadata -> mapToKitsuId start", id);
  console.log("corn")
  return mapToKitsuId(id)
    .then((kitsuId) => {
      // L.FLOW("mapped to kitsuId", kitsuId);
      console.log("cheese")
      return cacheWrapMeta(kitsuId, () =>
        kitsu
          .animeData(kitsuId)
          .then((metadata) => {
            console.log("potato")
            // L.META("kitsu.animeData keys", Object.keys(metadata || {}));
            return enrichKitsuMetadata(metadata, cinemeta.getCinemetaMetadata);
          })
          .then((meta) => {
            console.log("mango")
            // L.META("enriched meta fields", Object.keys(meta || {}));
            if (Array.isArray(meta?.videos))
              console.log("PUMPERNICKEL!!!!!")
              L.META("videos count", meta.videos.length);
            return { meta, cacheMaxAge: CACHE_MAX_AGE };
          })
      );
    })
    .catch((e) => {
      console.log("all time low")
      L.ERR("getKitsuIdMetadata error", e?.message || e);
      throw e;
    });
}

/**
 * Fetch/enrich metadata via IMDb path.
 */
async function getImdbIdMetadata(id) {
  // L.FLOW("getImdbIdMetadata start", id);
  return cacheWrapMeta(id, () =>
    cinemeta
      .getCinemetaMetadata(id)
      .then((metadata) => {
        // L.META("cinemeta keys", Object.keys(metadata || {}));
        return enrichImdbMetadata(metadata, kitsu.animeData);
      })
      .then((meta) => {
        // L.META("enriched imdb meta fields", Object.keys(meta || {}));
        return { meta, cacheMaxAge: CACHE_MAX_AGE };
      })
  ).catch((e) => {
    L.ERR("getImdbIdMetadata error", e?.message || e);
    throw e;
  });
}

module.exports = builder.getInterface();
