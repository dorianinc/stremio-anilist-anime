const axios = require('axios');
const { cacheWrapIdMapping } = require('./cache');

/**
 * Maps a given ID from any supported source (AniList, MAL, AniDB, etc.)
 * to its corresponding Kitsu ID.
 *
 * @param {string} fullId - The full ID in the format "source:id"
 *                          e.g. "anilist:1535" or "mal:20"
 * @returns {Promise<string>} - Resolves with the Kitsu ID if found
 */
async function mapToKitsuId(fullId) {
  // Extract the source (idType) and numeric ID from "source:id"
  const idType = fullId.split(":")[0];
  const id = fullId.split(":")[1];

  // If the ID is already from Kitsu, just return it directly
  if (idType === 'kitsu') {
    return id;
  }

  // Otherwise, try to map the ID using cache (to avoid repeated API calls).
  // If not cached, it will call queryIdMapping() to fetch from Yuna API.
  return cacheWrapIdMapping(fullId, () => queryIdMapping(idType, id));
}

/**
 * Calls the Yuna Relations API to convert an ID from a given source
 * into a Kitsu ID.
 *
 * @param {string} idType - The source of the ID (e.g. "anilist", "mal", "anidb")
 * @param {string} id - The actual ID from that source
 * @returns {Promise<string>} - Resolves with the Kitsu ID if found,
 *                              rejects if no mapping exists
 */
async function queryIdMapping(idType, id) {
  // Yuna expects "myanimelist" instead of "mal", so we normalize the type
  const yunaType = idType === 'mal' ? 'myanimelist' : idType;

  // Build the Yuna API URL with the given source and id
  // include=kitsu ensures we always request the Kitsu ID mapping
  const url = `https://relations.yuna.moe/api/v2/ids?source=${yunaType}&id=${id}&include=kitsu`

  // Make the request with a 30-second timeout
  return axios.get(url, { timeout: 30000 })
    // Extract the `kitsu` property from the response
    .then(response => response.data?.kitsu)
    // If found, resolve with the Kitsu ID
    // If not found, reject with an error message
    .then(kitsuId => kitsuId
      ? Promise.resolve(kitsuId)
      : Promise.reject(`No kitsu id found for: ${idType}:${id}`))
}

// Export functions for use in other modules
module.exports = { mapToKitsuId, queryIdMapping };
