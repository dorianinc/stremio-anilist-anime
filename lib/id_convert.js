const axios = require('axios');
const { cacheWrapIdMapping } = require('./cache');

/**
 * Maps a given "source:id" (e.g., "anilist:1535", "mal:20") to a Kitsu ID.
 * Uses cache wrapper to minimize Yuna API calls.
 *
 * @param {string} fullId - "source:id"
 * @returns {Promise<string>} - Kitsu ID
 */
async function mapToKitsuId(fullId) {
  console.log("mapToKitsuId started");

  const [idType, id] = fullId.split(':');
  if (idType === 'kitsu') {
    console.log("mapToKitsuId already kitsu id");
    return id;
  }

  console.log("mapToKitsuId calling queryIdMapping");
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
  console.log("queryIdMapping started");

  const yunaType = idType === 'mal' ? 'myanimelist' : idType;
  const url = `https://relations.yuna.moe/api/v2/ids?source=${yunaType}&id=${id}&include=kitsu`;

  try {
    console.log("queryIdMapping calling Yuna API");
    const res = await axios.get(url, { timeout: 30000 });

    console.log("queryIdMapping Yuna response ok");
    const kitsuId = res.data?.kitsu;

    if (!kitsuId) {
      console.log("queryIdMapping no kitsu id found");
      throw new Error(`No kitsu id for ${idType}:${id}`);
    }

    console.log("queryIdMapping finished successfully");
    return kitsuId;
  } catch (e) {
    console.log("queryIdMapping error");
    throw e;
  }
}

module.exports = { mapToKitsuId, queryIdMapping };
