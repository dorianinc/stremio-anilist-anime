const { getImages } = require('./fanart');
const { getGenreUrl } = require('./config');
const { getImdbMapping } = require('./metadataEnrich');

const allowedRelationships = ['prequel', 'sequel'];

// Build catalog meta (lightweight version)
async function toStremioCatalogMeta(animeData) {
  console.log("toStremioCatalogMeta start");
  const meta = await _toStremioMeta(animeData);

  const imdbId = getImdbMapping(meta.kitsu_id)?.imdb_id;

  const out = {
    id: meta.id,
    kitsu_id: meta.kitsu_id,
    imdb_id: imdbId,
    type: meta.type,
    animeType: meta.animeType,
    name: meta.name,
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
    links: meta.links,
  };
  console.log("toStremioCatalogMeta done");
  return out;
}

// Build entry meta (full version)
async function toStremioEntryMeta(animeData, includes) {
  console.log("toStremioEntryMeta start");
  const meta = await _toStremioMeta(animeData);
  console.log("toStremioEntryMeta done");
  return meta;
}

// Core transformer
async function _toStremioMeta(animeData) {
  console.log("_toStremioMeta start");

  const type = getType(animeData);

  let releaseInfo = animeData.startDate && `${animeData.startDate.match(/^\d+/)[0]}`;
  if (animeData.endDate && !animeData.endDate.startsWith(releaseInfo)) {
    releaseInfo = releaseInfo && releaseInfo.concat(`-${animeData.endDate.match(/^\d+/)[0]}`);
  } else if (animeData.status === 'current') {
    releaseInfo = releaseInfo && releaseInfo.concat('-');
  }

  const genres = animeData.genres?.data?.map((g) => g.name) || [];

  let fanartImages = {};
  try {
    fanartImages = await getImages(animeData.id);
    console.log("_toStremioMeta fanart ok");
  } catch {
    console.log("_toStremioMeta fanart error");
  }

  let videos;
  const hasEpisodeData = Array.isArray(animeData.episodes?.data) && animeData.episodes.data.length > 0;
  const hasEpisodeCount = Number.isInteger(animeData.episodeCount) && animeData.episodeCount > 0;

  if (animeData.subtype !== 'movie' || hasEpisodeData || animeData.episodeCount > 1) {
    const seriesStartTime = animeData.startDate ? new Date(animeData.startDate).getTime() : Date.now();

    if (hasEpisodeData) {
      console.log("_toStremioMeta building videos from data");
      let lastReleaseDate = new Date(seriesStartTime);
      videos = animeData.episodes.data
        .map((ep, index, self) => ({
          id: `kitsu:${animeData.id}:${ep.number}`,
          title:
            ep.titles?.en_us ||
            ep.titles?.en ||
            ep.titles?.en_jp ||
            ep.canonicalTitle ||
            `Episode ${ep.number}`,
          released: episodeReleased(ep, self[index + 1], lastReleaseDate),
          season: 1,
          episode: ep.number,
          thumbnail: ep.thumbnail?.original,
          overview: cleanDescription(ep.synopsis),
        }))
        .sort((a, b) => a.episode - b.episode);
    } else if (hasEpisodeCount) {
      console.log("_toStremioMeta building videos from count");
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

    if (videos && videos.length === 1 && ['movie', 'special', 'OVA', 'ONA'].includes(animeData.subtype)) {
      console.log("_toStremioMeta single video special collapse");
      videos[0].id = `kitsu:${animeData.id}`;
    }
  } else {
    console.log("_toStremioMeta no episodes built");
  }

  const titlesArray = [
    animeData.titles?.en_us,
    animeData.titles?.en,
    animeData.titles?.en_jp,
    animeData.titles?.ja_jp,
    animeData.canonicalTitle,
    ...(animeData.abbreviatedTitles || []),
  ].filter(Boolean);

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

  const output = cleanOutputObject({
    id: `kitsu:${animeData.id}`,
    kitsu_id: animeData.id,
    type: type,
    animeType: animeData.subtype,
    name: displayName,
    slug: animeData.slug,
    aliases: titles,
    genres: genres,
    logo: fanartImages.logo,
    poster: animeData?.posterImage?.medium || fanartImages.poster,
    background: fanartImages.background || (animeData.coverImage && animeData.coverImage.original),
    description: cleanDescription(animeData.synopsis),
    releaseInfo: releaseInfo,
    year: releaseInfo,
    imdbRating: roundedRating(animeData.averageRating)?.toString(),
    userCount: animeData.userCount,
    status: animeData.status,
    runtime: (Number.isInteger(animeData.episodeLength) && `${animeData.episodeLength} min`) || null,
    trailers: (animeData.youtubeVideoId && [{ source: animeData.youtubeVideoId, type: 'Trailer' }]) || [],
    videos: videos,
    links: kitsuLinks(animeData, type),
  });

  console.log("_toStremioMeta done");
  return output;
}

function getType(animeData) {
  return animeData?.subtype === 'movie' ? 'movie' : 'series';
}

function roundedRating(rating) {
  const val = rating && (Math.round(((rating / 10.0) + Number.EPSILON) * 10.0) / 10.0).toFixed(1);
  return val;
}

function kitsuLinks(animeData, type) {
  console.log("kitsuLinks start");

  const imdbRating = roundedRating(animeData.averageRating);

  const rating =
    (imdbRating && [
      { name: `${imdbRating}`, category: 'imdb', url: `https://kitsu.io/anime/${animeData.slug}` },
    ]) || [];

  const franchise = (animeData.mediaRelationships?.data || [])
    .filter((relationship) => allowedRelationships.includes(relationship.role))
    .map((relationship) => ({
      name: `${capitalize(relationship.role)}: ${relationship.destination?.data?.titles?.en}`,
      category: 'Franchise',
      url: `stremio:///detail/${type}/kitsu:${relationship.destination?.data?.id}`,
    }));

  const genreNames = (animeData.genres?.data || []).map((g) => g.name);
  const genres = genreNames.map((genre) => ({
    name: genre,
    category: 'Genres',
    url: getGenreUrl(genre),
  }));

  console.log("kitsuLinks done");
  return rating.concat(franchise).concat(genres);
}

function episodeReleased(ep, nextEp, lastReleaseDate) {
  console.log("episodeReleased called");
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

function capitalize(input) {
  return input ? input.charAt(0).toUpperCase() + input.slice(1) : input;
}

function cleanDescription(description) {
  console.log("cleanDescription called");
  return description?.replace(/\n+(?:[([].+[)\]\n]|Source:.*)?(?:\n+Note(.|\n)+)?$/, '');
}

function cleanOutputObject(object) {
  console.log("cleanOutputObject called");
  return Object.fromEntries(Object.entries(object).filter(([_, v]) => v != null));
}

module.exports = { toStremioCatalogMeta, toStremioEntryMeta };
