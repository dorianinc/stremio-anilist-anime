const axios = require('axios');
const { cacheWrapIdMapping } = require('./cache');

/**
 * Map a "source:id" (e.g., "anilist:1535", "mal:20", "kitsu:123")
 * to a Kitsu numeric id string. If already kitsu, return it directly.
 *
 * Cached via cacheWrapIdMapping to avoid repeated network calls.
 *
 * @param {string} fullId - "source:id"
 * @returns {Promise<string>} - Kitsu id
 */
async function mapToKitsuId(fullId) {
  const [idType, id] = fullId.split(':');
  if (idType === 'kitsu') return id;
  return cacheWrapIdMapping(fullId, () => queryIdMapping(idType, id));
}

/**
 * Query Yuna Relations API to convert a given id to a Kitsu id.
 * Includes small retry/backoff for transient failures.
 *
 * @param {string} idType - anilist | mal | anidb | kitsu
 * @param {string} id - numeric id string
 * @returns {Promise<string>} - Kitsu id
 */
async function queryIdMapping(idType, id) {
  const yunaType = idType === 'mal' ? 'myanimelist' : idType;
  const url = `https://relations.yuna.moe/api/v2/ids?source=${yunaType}&id=${id}&include=kitsu`;

  const attempt = async (i) => {
    try {
      const { data } = await axios.get(url, { timeout: 10000 });
      const kitsuId = data?.kitsu;
      if (!kitsuId) throw new Error('No kitsu id in response');
      return kitsuId;
    } catch (err) {
      if (i < 2) {
        const delay = 300 * Math.pow(2, i); // 300ms, 600ms
        await new Promise((r) => setTimeout(r, delay));
        return attempt(i + 1);
      }
      throw new Error(`Yuna mapping failed for ${idType}:${id} -> ${err?.message || err}`);
    }
  };

  return attempt(0);
}

module.exports = { mapToKitsuId, queryIdMapping };
