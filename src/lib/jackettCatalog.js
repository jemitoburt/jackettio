import crypto from "crypto";
import { Parser } from "xml2js";
import config from "./config.js";
import cache from "./cache.js";
import { parseWords, promiseTimeout, bytesToSize } from "./util.js";

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

    const category = type === "movie" ? CATEGORY.MOVIE : CATEGORY.SERIES;
    const cacheKey = `jackettCatalog:${type}:${query.trim().toLowerCase()}`;

    // Check cache first
    let items = await cache.get(cacheKey);

    if (!items) {
        try {
            // Search with timeout
            const searchPromise = jackettCatalogApi(query.trim(), category);
            const res = await promiseTimeout(
                searchPromise,
                CATALOG_SEARCH_TIMEOUT
            );

            // Extract items from response
            const rawItems = res?.rss?.channel?.item || [];

            // Normalize items for catalog
            items = normalizeCatalogItems(rawItems, type).slice(
                0,
                MAX_CATALOG_RESULTS
            ); // Limit results

            // Cache results (shorter TTL for search results - 1 hour)
            await cache.set(cacheKey, items, { ttl: 3600 });
        } catch (err) {
            console.log(`Catalog search failed for "${query}": ${err.message}`);
            // Return empty array on error (will show empty catalog)
            return [];
        }
    }

    return items;
}

/**
 * Call Jackett API for catalog search
 * Uses the torznab API endpoint for consistency with existing code
 * @param {string} query - Search query
 * @param {number} category - Category ID (MOVIE or SERIES)
 * @returns {Promise<Object>} Parsed API response
 */
async function jackettCatalogApi(query, category) {
    const params = new URLSearchParams({
        t: "search",
        cat: category,
        q: query,
    });
    params.set("apikey", config.jackettApiKey);

    const url = `${
        config.jackettUrl
    }/api/v2.0/indexers/all/results/torznab/api?${params.toString()}`;

    const res = await fetch(url);

    if (!res.ok) {
        throw new Error(`Jackett API returned status ${res.status}`);
    }

    let data;
    const contentType = res.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
        data = await res.json();
    } else {
        // Parse XML response (most common for torznab API)
        const text = await res.text();
        const parser = new Parser({ explicitArray: false, ignoreAttrs: false });
        data = await parser.parseStringPromise(text);
    }

    if (data.error) {
        throw new Error(
            `Jackett API error: ${data.error?.$?.description || data.error}`
        );
    }

    return data;
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
    // Merge dollar keys (XML attributes)
    item = mergeDollarKeys(item);

    // Extract torznab attributes
    const attr = (item["torznab:attr"] || []).reduce((obj, attrItem) => {
        if (attrItem && attrItem.name) {
            obj[attrItem.name] = attrItem.value;
        }
        return obj;
    }, {});

    const title = item.title || "";
    if (!title) return null;

    // Extract IMDb ID from title or attributes if present
    // Pattern: tt followed by 7-8 digits
    let imdbId = null;
    const imdbMatch =
        title.match(/tt\d{7,8}/i) || attr.imdbid?.match(/tt\d{7,8}/i);
    if (imdbMatch) {
        imdbId = imdbMatch[0].toLowerCase();
    }

    // Extract year from title
    const yearMatch = title.match(/\b(19|20\d{2})\b/);
    const year = yearMatch ? parseInt(yearMatch[1]) : null;

    // Generate stable ID
    // Prefer IMDb ID if found, otherwise use namespaced hash
    const id =
        imdbId ||
        `jackett:${crypto
            .createHash("sha256")
            .update(item.guid || item.link || title)
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
    const trackerName =
        item.jackettindexer?.title || item.jackettindexer?.id || "Unknown";
    const size = bytesToSize(parseInt(item.size || 0));
    const seeders = parseInt(attr.seeders || 0);
    const leechers = parseInt(attr.peers || 0) - seeders;

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
