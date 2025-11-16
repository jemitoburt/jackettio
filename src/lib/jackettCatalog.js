import crypto from "crypto";
import config from "./config.js";
import cache from "./cache.js";
import { parseWords, promiseTimeout, bytesToSize } from "./util.js";
import { jackettApi } from "./jackett.js";

const CATEGORY = {
    MOVIE: 2000,
    SERIES: 5000,
};

// Timeout for catalog searches (7 seconds as specified)
const CATALOG_SEARCH_TIMEOUT = 7000;

// Maximum results to return for catalog
const MAX_CATALOG_RESULTS = 30;

/**
 * Search Jackett API for catalog items
 * @param {string} query - Search query string
 * @param {string} type - 'movie' or 'series'
 * @returns {Promise<Array>} Array of normalized catalog items
 */
export async function searchCatalog(query, type) {
    // Validate input: search must be at least 2 characters
    if (!query || query.trim().length < 2) {
        return [];
    }

    // API returns results together for both types, so we ignore type parameter
    // and return results for both movie and series
    const cacheKey = `jackettCatalog:all:${query.trim().toLowerCase()}`;

    // Check cache first
    let items = await cache.get(cacheKey);

    if (!items) {
        try {
            // Search with timeout - no category filter since API returns all results together
            const searchPromise = jackettCatalogApi(query.trim(), null);
            const res = await promiseTimeout(
                searchPromise,
                CATALOG_SEARCH_TIMEOUT
            );

            // Extract items from response
            // The results endpoint returns JSON with Results array, or XML with rss.channel.item
            let rawItems = [];
            if (Array.isArray(res?.Results)) {
                // JSON format from /api/v2.0/indexers/all/results
                rawItems = res.Results;
            } else if (Array.isArray(res?.rss?.channel?.item)) {
                // XML format from torznab API
                rawItems = res.rss.channel.item;
            } else if (res?.Results) {
                // Single item or other structure
                rawItems = forceArray(res.Results);
            }

            // Normalize items for catalog - filter by requested type but include both types
            // Since API returns results together, we filter by type only for display
            const allItems = normalizeCatalogItemsMixed(rawItems);

            // Filter by requested type if specified
            if (type) {
                items = allItems
                    .filter((item) => item.type === type)
                    .slice(0, MAX_CATALOG_RESULTS);
            } else {
                items = allItems.slice(0, MAX_CATALOG_RESULTS);
            }

            // Cache results (shorter TTL for search results - 1 hour)
            await cache.set(cacheKey, allItems, { ttl: 3600 });
        } catch (err) {
            console.log(`Catalog search failed for "${query}": ${err.message}`);
            // Return empty array on error (will show empty catalog)
            return [];
        }
    } else {
        // Filter cached results by type if specified
        if (type) {
            items = items
                .filter((item) => item.type === type)
                .slice(0, MAX_CATALOG_RESULTS);
        } else {
            items = items.slice(0, MAX_CATALOG_RESULTS);
        }
    }

    return items;
}

/**
 * Call Jackett API for catalog search
 * Uses the standard results endpoint: /api/v2.0/indexers/all/results
 * @param {string} query - Search query
 * @param {number|null} category - Category ID (MOVIE or SERIES) - ignored since API returns all results together
 * @returns {Promise<Object>} Parsed API response
 */
async function jackettCatalogApi(query, category) {
    // Use the standard results endpoint with Query parameter (capital Q)
    // API returns results for both movies and series together, so we don't filter by category
    // Reuse jackettApi function from jackett.js for consistent API handling
    const res = await jackettApi(
        "/api/v2.0/indexers/all/results",
        { Query: query } // Note: capital Q as per Jackett API
    );

    return res;
}

/**
 * Normalize Jackett results to Stremio catalog format for mixed types
 * Returns results for both movie and series, auto-detecting type
 * @param {Array} items - Raw items from Jackett API
 * @returns {Array} Array of Stremio catalog meta objects with type determined
 */
function normalizeCatalogItemsMixed(items) {
    const normalized = [];
    const seenIds = new Set(); // Deduplicate by ID

    for (const item of forceArray(items)) {
        try {
            // Try to determine if item is movie or series
            // First try as movie
            let normalizedItem = normalizeToMeta(item, "movie");
            let itemType = "movie";

            // If it looks like a series (has episode patterns), use series type
            if (
                normalizedItem &&
                (isSingleEpisode(normalizedItem.name) ||
                    looksLikeSeries(normalizedItem.name))
            ) {
                normalizedItem = normalizeToMeta(item, "series");
                itemType = "series";

                // Skip single episodes for series catalog
                if (isSingleEpisode(normalizedItem.name)) {
                    continue;
                }
            }

            // Skip if already seen or if item doesn't match type heuristics
            if (normalizedItem && !seenIds.has(normalizedItem.id)) {
                normalizedItem.type = itemType;
                seenIds.add(normalizedItem.id);
                normalized.push(normalizedItem);
            }
        } catch (err) {
            // Skip items that fail normalization
            console.log(`Failed to normalize catalog item: ${err.message}`);
            continue;
        }
    }

    // Sort by seeders (descending) to prioritize popular content
    return normalized.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
}

/**
 * Normalize Jackett results to Stremio catalog format
 * @param {Array} items - Raw items from Jackett API
 * @param {string} type - 'movie' or 'series'
 * @returns {Array} Array of Stremio catalog meta objects
 */
function normalizeCatalogItems(items, type) {
    const normalized = [];
    const seenIds = new Set(); // Deduplicate by ID

    for (const item of forceArray(items)) {
        try {
            const normalizedItem = normalizeToMeta(item, type);

            // Skip if already seen or if item doesn't match type heuristics
            if (normalizedItem && !seenIds.has(normalizedItem.id)) {
                // Basic type filtering: for series, skip items that look like single episodes
                if (type === "series" && isSingleEpisode(normalizedItem.name)) {
                    continue;
                }

                seenIds.add(normalizedItem.id);
                normalized.push(normalizedItem);
            }
        } catch (err) {
            // Skip items that fail normalization
            console.log(`Failed to normalize catalog item: ${err.message}`);
            continue;
        }
    }

    // Sort by seeders (descending) to prioritize popular content
    return normalized.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
}

/**
 * Normalize a single Jackett item to Stremio catalog meta format
 * @param {Object} item - Raw item from Jackett
 * @param {string} type - 'movie' or 'series'
 * @returns {Object|null} Stremio catalog meta object or null if invalid
 */
function normalizeToMeta(item, type) {
    // Merge dollar keys (XML attributes) - only needed for XML format
    item = mergeDollarKeys(item);

    // Extract attributes - handle both JSON and XML formats
    let attr = {};
    if (item["torznab:attr"]) {
        // XML format: extract from torznab:attr array
        attr = (item["torznab:attr"] || []).reduce((obj, attrItem) => {
            if (attrItem && attrItem.name) {
                obj[attrItem.name] = attrItem.value;
            }
            return obj;
        }, {});
    } else {
        // JSON format: attributes are directly on the object
        // Map common attributes from JSON structure
        if (item.Seeders !== undefined) attr.seeders = item.Seeders;
        if (item.Peers !== undefined) attr.peers = item.Peers;
        if (item.InfoHash !== undefined) attr.infohash = item.InfoHash;
        if (item.Imdb !== undefined) attr.imdbid = item.Imdb;
        if (item.MagnetUri !== undefined) attr.magneturl = item.MagnetUri;
    }

    // Get title - handle both JSON (Title) and XML (title) formats
    const title = item.Title || item.title || "";
    if (!title) return null;

    // Extract IMDb ID from title, attributes, or direct Imdb field
    // Pattern: tt followed by 7-8 digits
    let imdbId = null;
    const imdbSource = item.Imdb || attr.imdbid || title;
    const imdbMatch =
        typeof imdbSource === "string" ? imdbSource.match(/tt\d{7,8}/i) : null;
    if (imdbMatch) {
        imdbId = imdbMatch[0].toLowerCase();
    }

    // Extract year from title
    const yearMatch = title.match(/\b(19|20\d{2})\b/);
    const year = yearMatch ? parseInt(yearMatch[1]) : null;

    // Generate stable ID
    // Prefer IMDb ID if found, otherwise use namespaced hash
    const guid = item.Guid || item.guid || item.Link || item.link || title;
    const id =
        imdbId ||
        `jackett:${crypto
            .createHash("sha256")
            .update(guid)
            .digest("hex")
            .substring(0, 16)}`;

    // Clean title (remove quality indicators, years, etc. for cleaner display)
    let cleanTitle = title
        .replace(/\b(2160|1080|720|480|360)p\b/gi, "")
        .replace(/\b(19|20\d{2})\b/g, "")
        .replace(/[\[\]()]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    // Build description with tracker info
    // Handle both JSON (Tracker) and XML (jackettindexer) formats
    const trackerName =
        item.Tracker ||
        item.TrackerId ||
        item.jackettindexer?.title ||
        item.jackettindexer?.id ||
        "Unknown";
    const size = bytesToSize(parseInt(item.Size || item.size || 0));
    const seeders = parseInt(attr.seeders || 0);
    const peers = parseInt(attr.peers || item.Peers || 0);
    const leechers = peers - seeders;

    const descriptionParts = [];
    if (trackerName)
        descriptionParts.push(`Tracker: ${sanitizeString(trackerName)}`);
    if (size) descriptionParts.push(`Size: ${size}`);
    if (seeders > 0) descriptionParts.push(`Seeders: ${seeders}`);
    if (leechers > 0) descriptionParts.push(`Leechers: ${leechers}`);
    if (year) descriptionParts.push(`Year: ${year}`);

    const description =
        descriptionParts.length > 0
            ? descriptionParts.join(" • ")
            : `Found via Jackett search`;

    return {
        type,
        id,
        name: sanitizeString(cleanTitle || title),
        poster: null, // No poster available from Jackett
        background: null, // No background available from Jackett
        description: sanitizeString(description),
        // Store additional metadata for internal use
        _seeders: seeders,
        _year: year,
        _tracker: trackerName,
    };
}

/**
 * Check if a title looks like a series (not a movie)
 * @param {string} title - Item title
 * @returns {boolean} True if appears to be a series
 */
function looksLikeSeries(title) {
    const titleLower = title.toLowerCase();

    // Patterns that indicate series
    const seriesPatterns = [
        /\bS\d{1,2}\b/, // Season pattern (S01, S1, etc.)
        /\bSeason\s+\d+\b/i, // "Season X"
        /\bSeries\s+\d+\b/i, // "Series X"
        /\bComplete\s+Series\b/i, // "Complete Series"
        /\bBox\s+Set\b/i, // "Box Set"
        /\bComplete\s+Collection\b/i, // "Complete Collection"
    ];

    return seriesPatterns.some((pattern) => pattern.test(titleLower));
}

/**
 * Check if a title looks like a single episode (for series filtering)
 * @param {string} title - Item title
 * @returns {boolean} True if appears to be a single episode
 */
function isSingleEpisode(title) {
    const titleLower = title.toLowerCase();

    // Patterns that indicate single episodes
    const episodePatterns = [
        /\bS\d{1,2}E\d{1,2}\b/, // S01E01 format
        /\bS\d{1,2}\s*-\s*E\d{1,2}\b/, // S01 - E01 format
        /\bSeason\s+\d+\s+Episode\s+\d+\b/i, // Season X Episode Y
        /\bEpisode\s+\d+\b/i, // Just "Episode X"
    ];

    // If it has episode patterns AND no pack indicators, likely single episode
    const hasEpisodePattern = episodePatterns.some((pattern) =>
        pattern.test(titleLower)
    );
    const hasPackIndicators =
        /\b(Complete|Full\s+Season|Season\s+Pack|Box\s+Set)\b/i.test(
            titleLower
        );

    return hasEpisodePattern && !hasPackIndicators;
}

/**
 * Sanitize string to prevent header injection or HTML issues
 * @param {string} str - String to sanitize
 * @returns {string} Sanitized string
 */
function sanitizeString(str) {
    if (!str) return "";

    return String(str)
        .replace(/[\r\n]/g, " ") // Remove line breaks
        .replace(/[<>]/g, "") // Remove HTML brackets
        .trim()
        .substring(0, 500); // Limit length
}

/**
 * Merge XML dollar keys (attributes) into main object
 * @param {Object} item - Item with potential $ keys
 * @returns {Object} Merged item
 */
function mergeDollarKeys(item) {
    if (!item || typeof item !== "object") return item;

    if (item.$) {
        item = { ...item.$, ...item };
        delete item.$;
    }

    for (const key in item) {
        if (typeof item[key] === "object" && item[key] !== null) {
            item[key] = mergeDollarKeys(item[key]);
        }
    }

    return item;
}

/**
 * Force value to array
 * @param {*} value - Value to force to array
 * @returns {Array} Array value
 */
function forceArray(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}
