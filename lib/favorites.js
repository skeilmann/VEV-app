/**
 * Favorites data helpers.
 *
 * Stored in customer metafield custom.fav_prod (type json), the same field the
 * theme reads in layout/theme.liquid:  { "saved": [ { "id": 123, "handle": "x" } ] }
 */

const MAX_FAVORITES = 200;
const HANDLE_RE = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,254}$/u;

/**
 * Validate and clean a list sent by the browser.
 * @returns {Array<{id:number, handle:string}>|null} null when the input is invalid
 */
function normalizeFavorites(list) {
  if (!Array.isArray(list) || list.length > MAX_FAVORITES) return null;

  const seen = new Set();
  const result = [];

  for (const item of list) {
    if (!item || typeof item !== 'object') return null;

    const id = typeof item.id === 'number' ? item.id : Number.parseInt(item.id, 10);
    if (!Number.isSafeInteger(id) || id <= 0) return null;

    const handle = typeof item.handle === 'string' ? item.handle : '';
    if (handle && !HANDLE_RE.test(handle)) return null;

    if (seen.has(id)) continue;
    seen.add(id);
    result.push({ id, handle });
  }

  return result;
}

/**
 * Read the "saved" list out of a stored metafield value, tolerating bad data.
 */
function readSaved(value) {
  try {
    const data = typeof value === 'string' ? JSON.parse(value) : value;
    return normalizeFavorites(data && data.saved) || [];
  } catch (error) {
    return [];
  }
}

/** Existing favorites first, then new ones not already present. */
function mergeFavorites(existing, incoming) {
  const ids = new Set(existing.map((f) => f.id));
  const merged = existing.concat(incoming.filter((f) => !ids.has(f.id)));
  return merged.slice(0, MAX_FAVORITES);
}

module.exports = { normalizeFavorites, readSaved, mergeFavorites, MAX_FAVORITES };
