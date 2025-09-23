const axios = require('axios');
const { cacheWrapIdMapping } = require('./cache');
const { scope } = require('./logger');
const L = { MAP: scope('ID_MAP') };

/**
 * Maps a given "source:id" (e.g., "anilist:1535", "mal:20") to a Kitsu ID.
 * Uses cache wrapper to minimize Yuna API calls.
 *
 * @param {string} fullId - "source:id"
 * @returns {Promise<string>} - Kitsu ID
 */
async function mapToKitsuId(fullId) {
  L.MAP('mapToKitsuId input', fullId);

  const [idType, id] = fullId.split(':');
  if (idType === 'kitsu') {
    L.MAP('already kitsu id', id);
    return id;
  }

  return cacheWrapIdMapping(fullId, () => queryIdMapping(idType, id));
}

/**
 * Calls Yuna Relations API to map idType:id to Kitsu.
 *
 * @param {string} idType - "anilist", "mal", "anidb", etc.
 * @param {string} id - numeric id string
 * @returns {Promise<string>} - Kitsu ID
 */
async function queryIdMapping(idType, id) {
  console.log("we are in queryIdMapping")
  const yunaType = idType === 'mal' ? 'myanimelist' : idType;
  const url = `https://relations.yuna.moe/api/v2/ids?source=${yunaType}&id=${id}&include=kitsu`;
  L.MAP('query Yuna', url);

  try {
    const res = await axios.get(url, { timeout: 30000 });
    L.MAP('Yuna status', res.status);
    L.MAP('Yuna data', res.data);
    const kitsuId = res.data?.kitsu;
    if (!kitsuId) throw new Error(`No kitsu id for ${idType}:${id}`);
    L.MAP('mapped kitsu id', kitsuId);
    console.log("it looks like it went fine")
    return kitsuId;
  } catch (e) {
    console.log("there was an error")
    L.MAP('Yuna error', e?.message || e);
    throw e;
  }
}

module.exports = { mapToKitsuId, queryIdMapping };
