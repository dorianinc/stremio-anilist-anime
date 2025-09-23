// lib/logger.js
function stamp() {
  return new Date().toISOString();
}
function scope(label) {
  return (...args) => console.log(`[${stamp()}] ${label}:`, ...args);
}
module.exports = { scope };
