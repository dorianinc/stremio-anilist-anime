const { getImages } = require('./fanart')
const { getGenreUrl } = require('./config')
const { getImdbMapping } = require("./metadataEnrich");

const allowedRelationships = [ 'prequel', 'sequel' ]

async function toStremioCatalogMeta(animeData) {
  console.log("🖥️ [toStremioCatalogMeta] raw animeData:", JSON.stringify(animeData, null, 2))
  const meta = await _toStremioMeta(animeData);
  console.log("✅ [toStremioCatalogMeta] meta built:", JSON.stringify(meta, null, 2))
  const imdbId = getImdbMapping(meta.kitsu_id)?.imdb_id
  console.log("🎬 [toStremioCatalogMeta] imdbId mapped:", imdbId)
  return {
    id: meta.id,
    kitsu_id: meta.kitsu_id,
    imdb_id: imdbId,
    type: meta.type,
    animeType: meta.animeType,
    name: meta.name,           // English preferred now
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
  }
}

async function toStremioEntryMeta(animeData, includes) {
  console.log("🖥️ [toStremioEntryMeta] animeData:", animeData)
  console.log("🖥️ [toStremioEntryMeta] includes:", includes)
  return _toStremioMeta(animeData, includes);
}

async function _toStremioMeta(animeData) {
  console.log("🖥️ [_toStremioMeta] starting with:", animeData.id)

  const type = getType(animeData);
  console.log("📌 [_toStremioMeta] type:", type)

  let releaseInfo = animeData.startDate && `${animeData.startDate.match(/^\d+/)[0]}`;
  if (animeData.endDate && !animeData.endDate.startsWith(releaseInfo)) {
    releaseInfo = releaseInfo && releaseInfo.concat(`-${animeData.endDate.match(/^\d+/)[0]}`);
    console.log("📅 [_toStremioMeta] releaseInfo range:", releaseInfo)
  } else if (animeData.status === 'current') {
    releaseInfo = releaseInfo && releaseInfo.concat('-');
    console.log("📅 [_toStremioMeta] ongoing releaseInfo:", releaseInfo)
  }

  const genres = animeData.genres.data?.map(genre => genre.name);
  console.log("🏷️ [_toStremioMeta] genres:", genres)

  const fanartImages = await getImages(animeData.id).catch((err) => {
    console.log("⚠️ [_toStremioMeta] getImages failed:", err)
    return {}
  });
  console.log("🖼️ [_toStremioMeta] fanartImages:", fanartImages)

  let videos;
  if (animeData.subtype !== 'movie' || animeData.episodes.data?.length || animeData.episodeCount > 1) {
    console.log("🎞️ [_toStremioMeta] building videos...")
    const seriesStartTime = new Date(animeData.startDate).getTime();
    if (animeData.episodes.data?.length) {
      console.log("🎞️ [_toStremioMeta] building from episodes.data:", animeData.episodes.data.length)
      let lastReleaseDate = new Date(seriesStartTime)
      videos = animeData.episodes.data
          .map((ep, index, self) => {
            const built = {
              id: `kitsu:${animeData.id}:${ep.number}`,
              title: ep.titles.en_us ||
                  ep.titles.en ||
                  ep.titles.en_jp ||
                  ep.canonicalTitle ||
                  `Episode ${ep.number}`,
              released: episodeReleased(ep, self[index + 1], lastReleaseDate),
              season: 1,
              episode: ep.number,
              thumbnail: ep.thumbnail?.original,
              overview: cleanDescription(ep.synopsis),
            }
            console.log("🎞️ [_toStremioMeta] built episode:", built)
            return built
          })
          .sort((a, b) => a.episode - b.episode);
    } else if (animeData.episodeCount) {
      console.log("🎞️ [_toStremioMeta] building by episodeCount:", animeData.episodeCount)
      videos = [...Array(animeData.episodeCount).keys()]
          .map((ep) => ep + 1)
          .map((ep) => {
            const built = {
              id: `kitsu:${animeData.id}:${ep}`,
              title: `Episode ${ep}`,
              released: new Date(seriesStartTime),
              season: 1,
              episode: ep,
            }
            console.log("🎞️ [_toStremioMeta] built episode placeholder:", built)
            return built
          })
    }
    if (videos && videos.length === 1 && ['movie', 'special', 'OVA', 'ONA'].includes(animeData.subtype)) {
      console.log("🎥 [_toStremioMeta] adjusting single-video ID for subtype:", animeData.subtype)
      videos[0].id = `kitsu:${animeData.id}`;
    }
  }

  const titlesArray = [
    animeData.titles?.en_us,
    animeData.titles?.en,
    animeData.titles?.en_jp,
    animeData.titles?.ja_jp,
    animeData.canonicalTitle
  ]
  .concat(animeData.abbreviatedTitles || [])
  .filter(Boolean);

  console.log("📝 [_toStremioMeta] titlesArray raw:", titlesArray)

  const titles = titlesArray.reduce((acc, cur) => {
    const lower = cur.toLowerCase();
    if (!acc.some(v => v.toLowerCase() === lower)) acc.push(cur);
    return acc;
  }, []);
  console.log("📝 [_toStremioMeta] deduped titles:", titles)

  const displayName =
    animeData.titles?.en_us ||
    animeData.titles?.en ||
    animeData.titles?.en_jp ||
    animeData.titles?.ja_jp ||
    animeData.canonicalTitle ||
    titles[0] ||
    'Unknown Title';
  console.log("🏷️ [_toStremioMeta] displayName chosen:", displayName)

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
    background: fanartImages.background || animeData.coverImage && animeData.coverImage.original,
    description: cleanDescription(animeData.synopsis),
    releaseInfo: releaseInfo,
    year: releaseInfo,
    imdbRating: roundedRating(animeData.averageRating)?.toString(),
    userCount: animeData.userCount,
    status: animeData.status,
    runtime: Number.isInteger(animeData.episodeLength) && `${animeData.episodeLength} min` || null,
    trailers: animeData.youtubeVideoId && [{ source: animeData.youtubeVideoId, type: 'Trailer' }] || [],
    videos: videos,
    links: kitsuLinks(animeData, type)
  });

  console.log("✅ [_toStremioMeta] final meta output:", JSON.stringify(output, null, 2))
  return output
}

function getType(animeData) {
  const type = (animeData.subtype === 'movie') ? 'movie' : 'series'
  console.log("🖥️ [getType] subtype:", animeData.subtype, "=> type:", type)
  return type
}

function roundedRating(rating) {
  const val = rating && (Math.round(((rating / 10.0) + Number.EPSILON) * 10.0) / 10.0).toFixed(1);
  console.log("⭐ [roundedRating] rating:", rating, "=>", val)
  return val
}

function kitsuLinks(animeData, type) {
  console.log("🖥️ [kitsuLinks] building links for:", animeData.id, "type:", type)
  const imdbRating = roundedRating(animeData.averageRating)
  const rating = imdbRating && [{
    name: `${imdbRating}`,
    category: 'imdb',
    url: `https://kitsu.io/anime/${animeData.slug}`
  }] || [];
  console.log("🔗 [kitsuLinks] rating links:", rating)

  const franchise = (animeData.mediaRelationships.data || [])
      .filter(relationship => allowedRelationships.includes(relationship.role))
      .map(relationship => {
        const built = {
          name: `${capitalize(relationship.role)}: ${relationship.destination.data.titles?.en}`,
          category: 'Franchise',
          url: `stremio:///detail/${type}/kitsu:${relationship.destination.data.id}`
        }
        console.log("🔗 [kitsuLinks] franchise link:", built)
        return built
      });

  const genres = (animeData.genres.data || [])
      .map(genre => genre.name)
      .map(genre => {
        const built = {
          name: genre,
          category: 'Genres',
          url: getGenreUrl(genre)
        }
        console.log("🔗 [kitsuLinks] genre link:", built)
        return built
      });

  const result = rating.concat(franchise).concat(genres);
  console.log("✅ [kitsuLinks] final links:", result)
  return result;
}

function episodeReleased(ep, nextEp, lastReleaseDate) {
  console.log("🖥️ [episodeReleased] ep:", ep.number, "airdate:", ep.airdate)
  const airDate = ep.airdate && new Date(ep.airdate);
  const nextAirDate = nextEp && nextEp.airdate && new Date(nextEp.airdate) || airDate;
  const released = airDate && airDate.getTime() > lastReleaseDate.getTime() && airDate.getTime() <= nextAirDate.getTime()
      ? airDate
      : new Date(lastReleaseDate.getTime());
  lastReleaseDate.setTime(released.getTime());
  console.log("📅 [episodeReleased] final released date:", released)
  return released;
}

function capitalize(input) {
  const val = input.charAt(0).toUpperCase() + input.slice(1);
  console.log("🖥️ [capitalize] input:", input, "=>", val)
  return val
}

function cleanDescription(description) {
  const val = description?.replace(/\n+(?:[([].+[)\]\n]|Source:.*)?(?:\n+Note(.|\n)+)?$/, '');
  console.log("🖥️ [cleanDescription] cleaned:", val)
  return val
}

function cleanOutputObject(object) {
  const val = Object.fromEntries(Object.entries(object).filter(([_, v]) => v != null));
  console.log("🖥️ [cleanOutputObject] pruned output keys:", Object.keys(val))
  return val;
}

module.exports = { toStremioCatalogMeta, toStremioEntryMeta };
