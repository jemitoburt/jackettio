import showdown from "showdown";
import compression from "compression";
import express from "express";
import localtunnel from "localtunnel";
import { rateLimit } from "express-rate-limit";
import { readFileSync } from "fs";
import config from "./lib/config.js";
import cache, {
    vacuum as vacuumCache,
    clean as cleanCache,
} from "./lib/cache.js";
import path from "path";
import * as meta from "./lib/meta.js";
import * as icon from "./lib/icon.js";
import * as debrid from "./lib/debrid.js";
import { getIndexers, searchAllTorrents } from "./lib/jackett.js";
import * as jackettio from "./lib/jackettio.js";
import {
    cleanTorrentFolder,
    createTorrentFolder,
    get as getTorrentInfos,
    getById as getTorrentInfoById,
} from "./lib/torrentInfos.js";
import { bytesToSize } from "./lib/util.js";

const converter = new showdown.Converter();
const welcomeMessageHtml = config.welcomeMessage
    ? `${converter.makeHtml(
          config.welcomeMessage
      )}<div class="my-4 border-top border-secondary-subtle"></div>`
    : "";
const addon = JSON.parse(readFileSync(`./package.json`));
const app = express();

const respond = (res, data) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Content-Type", "application/json");
    res.send(data);
};

// Store torrents for meta endpoint
const torrentMetaStore = new Map();

const convertToMetas = (torrents, type, publicUrl) => {
    const metas = [];
    const seenIds = new Set();

    for (const torrent of torrents) {
        let id = torrent.imdb;

        // If no IMDB ID, create a unique ID from the torrent name
        if (!id || id === "null" || id === "") {
            // Use first 9 chars of torrent ID as unique identifier
            id = `jkt${torrent.id.substring(0, 9)}`;
        }

        // Clean up IMDB ID if it exists
        if (id.startsWith("tt")) {
            id = id.toLowerCase();
        }

        // Skip if we've already added this ID
        if (seenIds.has(id)) {
            continue;
        }
        seenIds.add(id);

        // Determine type from category or use provided type
        let metaType = type;
        if (torrent.type && torrent.type.toLowerCase().includes("movie")) {
            metaType = "movie";
        } else if (
            torrent.type &&
            (torrent.type.toLowerCase().includes("tv") ||
                torrent.type.toLowerCase().includes("series"))
        ) {
            metaType = "series";
        }

        // Fix poster URL - proxy through our server for external access
        let posterUrl = null;
        if (torrent.poster && torrent.poster.startsWith("http")) {
            // Parse original Jackett URL
            // Example: http://192.168.1.110:9117/img/sktorrent/?jackett_apikey=xxx&path=yyy&file=poster
            const urlMatch = torrent.poster.match(/\/img\/([^/]+)\/\?(.+)/);
            if (urlMatch && publicUrl) {
                const indexer = urlMatch[1];
                const params = urlMatch[2];
                // Proxy through our server so it works from anywhere
                posterUrl = `${publicUrl}/jackett-proxy/img/${indexer}/?${params}`;
            } else {
                // Fallback to original URL if pattern doesn't match
                posterUrl = torrent.poster.replace(
                    /http:\/\/jackett:9117/g,
                    config.jackettUrl
                );
            }
        }

        const meta = {
            id: id,
            type: metaType,
            name: `[${torrent.indexerId}] ${torrent.name}`,
        };

        if (posterUrl) {
            meta.poster = posterUrl;
        }

        if (torrent.year && torrent.year > 1900) {
            meta.releaseInfo = torrent.year.toString();
        }

        if (torrent.genres && torrent.genres.length > 0) {
            meta.genres = torrent.genres;
        }

        // Store full torrent data for meta and stream endpoints
        torrentMetaStore.set(id, {
            ...meta,
            description: torrent.genres ? torrent.genres.join(", ") : "",
            background: posterUrl,
            // Add stream info
            size: torrent.size,
            seeders: torrent.seeders,
            indexerId: torrent.indexerId,
            quality: torrent.quality,
            languages: torrent.languages || [],
            // Store original torrent data and link for streaming
            _torrent: torrent,
            _torrentId: torrent.id, // Explicitly store torrent ID (SHA1 hash of GUID)
            _torrentName: torrent.name, // Store raw torrent name (includes extension like .mkv)
            _link: torrent.link, // Original Jackett download link
            _guid: torrent.guid,
            _infoHash: torrent.infoHash,
            _magnetUrl: torrent.magneturl,
            publishDate: torrent.publishDate || 0, // Store publish date for sorting
        });

        // Add publishDate to meta for sorting
        meta.publishDate = torrent.publishDate || 0;
        metas.push(meta);
    }

    return metas;
};

const limiter = rateLimit({
    windowMs: config.rateLimitWindow * 1000,
    max: config.rateLimitRequest,
    legacyHeaders: false,
    standardHeaders: "draft-7",
    keyGenerator: (req) => req.clientIp || req.ip,
    handler: (req, res, next, options) => {
        if (req.route.path == "/:userConfig/stream/:type/:id.json") {
            const resetInMs = new Date(req.rateLimit.resetTime) - new Date();
            return res.json({
                streams: [
                    {
                        name: `${config.addonName}`,
                        title: `🛑 Too many requests, please try in ${Math.ceil(
                            resetInMs / 1000 / 60
                        )} minute(s).`,
                        url: "#",
                    },
                ],
            });
        } else {
            return res.status(options.statusCode).send(options.message);
        }
    },
});

app.set("trust proxy", config.trustProxy);

// Middleware: Extract and set client IP address from request
// Handles Cloudflare proxy by checking CF-Connecting-IP header
app.use((req, res, next) => {
    req.clientIp = req.ip;
    if (req.get("CF-Connecting-IP")) {
        req.clientIp = req.get("CF-Connecting-IP");
    }
    next();
});

// Middleware: Enable gzip/deflate compression for all responses
app.use(compression());

// Middleware: Serve static files from the 'static' directory (CSS, images, videos, etc.)
// Files are cached for 24 hours (86400e3 ms) to improve performance
app.use(
    express.static(path.join(import.meta.dirname, "static"), {
        maxAge: 86400e3,
    })
);

app.get("/", (req, res) => {
    res.redirect("/configure");
    res.end();
});

app.get("/icon", async (req, res) => {
    const filePath = await icon.getLocation();
    res.contentType(path.basename(filePath));
    res.setHeader("Cache-Control", `public, max-age=${3600}`);
    return res.sendFile(filePath);
});

// Proxy endpoint for Jackett images (posters)
app.get("/jackett-proxy/img/:indexer/", async (req, res) => {
    try {
        const jackettApiKey = req.query.jackett_apikey;
        const path = req.query.path;
        const file = req.query.file;

        if (!jackettApiKey || !path || !file) {
            return res.status(400).send("Missing parameters");
        }

        const url = `${config.jackettUrl}/img/${req.params.indexer}/?jackett_apikey=${jackettApiKey}&path=${path}&file=${file}`;

        const response = await fetch(url);
        if (!response.ok) {
            return res.status(response.status).send("Failed to fetch image");
        }

        const imageBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(imageBuffer);

        res.setHeader(
            "Content-Type",
            response.headers.get("content-type") || "image/jpeg"
        );
        res.setHeader("Cache-Control", "public, max-age=86400");
        res.send(buffer);
    } catch (err) {
        console.error("Jackett proxy error:", err);
        res.status(500).send("Error fetching image");
    }
});

// Middleware: Log all incoming requests to console
// Masks base64-encoded user config in URLs for security (replaces with asterisks)
app.use((req, res, next) => {
    console.log(
        `${req.method} ${req.path.replace(
            /\/eyJ[\w\=]+/g,
            "/*******************"
        )}`
    );
    next();
});

app.get("/:userConfig?/configure", async (req, res) => {
    let indexers = (await getIndexers().catch(() => [])).map((indexer) => ({
        value: indexer.id,
        label: indexer.title,
        types: ["movie", "series"].filter(
            (type) => indexer.searching[type].available
        ),
    }));
    const templateConfig = {
        debrids: await debrid.list(),
        addon: {
            version: addon.version,
            name: config.addonName,
        },
        userConfig: req.params.userConfig || "",
        defaultUserConfig: config.defaultUserConfig,
        qualities: config.qualities,
        languages: config.languages
            .map((l) => ({ value: l.value, label: l.label }))
            .filter((v) => v.value != "multi"),
        metaLanguages: await meta.getLanguages(),
        sorts: config.sorts,
        indexers,
        passkey: { enabled: false },
        immulatableUserConfigKeys: config.immulatableUserConfigKeys,
    };
    if (config.replacePasskey) {
        templateConfig.passkey = {
            enabled: true,
            infoUrl: config.replacePasskeyInfoUrl,
            pattern: config.replacePasskeyPattern,
        };
    }
    let template = readFileSync(`./src/template/configure.html`)
        .toString()
        .replace(
            "/** import-config */",
            `const config = ${JSON.stringify(templateConfig, null, 2)}`
        )
        .replace("<!-- welcome-message -->", welcomeMessageHtml);
    return res.send(template);
});

// https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/advanced.md#using-user-data-in-addons
app.get("/:userConfig?/manifest.json", async (req, res) => {
    const manifest = {
        id: config.addonId,
        version: addon.version,
        name: config.addonName,
        description: config.addonDescription,
        icon: `${req.hostname == "localhost" ? "http" : "https"}://${
            req.hostname
        }/icon`,
        resources: ["stream", "catalog", "meta"],
        types: ["movie", "series"],
        idPrefixes: ["tt", "jkt"],
        catalogs: [
            {
                type: "movie",
                id: "jackett-search",
                name: "Jackett Search",
                extra: [{ name: "search", isRequired: true }],
            },
            {
                type: "series",
                id: "jackett-search",
                name: "Jackett Search",
                extra: [{ name: "search", isRequired: true }],
            },
        ],
        behaviorHints: { configurable: true },
    };
    if (req.params.userConfig) {
        const userConfig = JSON.parse(atob(req.params.userConfig));
        const debridInstance = debrid.instance(userConfig);
        manifest.name += ` ${debridInstance.shortName}`;
    }
    respond(res, manifest);
});

// Catalog endpoint with extra parameters in path (Stremio format)
app.get("/:userConfig?/catalog/:type/:id/:extra.json", async (req, res) => {
    try {
        // Parse extra parameters from path (e.g., "search=Bachelor")
        const extraParams = req.params.extra.split("&").reduce((acc, param) => {
            const [key, value] = param.split("=");
            if (key && value) acc[key] = decodeURIComponent(value);
            return acc;
        }, {});

        const searchQuery = extraParams.search || req.query.search;

        console.log(
            `Catalog request: type=${req.params.type}, id=${req.params.id}, search=${searchQuery}`
        );

        if (!searchQuery) {
            return respond(res, { metas: [] });
        }

        let userConfig = config.defaultUserConfig;
        if (req.params.userConfig) {
            userConfig = {
                ...userConfig,
                ...JSON.parse(atob(req.params.userConfig)),
            };
        }

        const indexers = userConfig.indexers || ["all"];
        const qualities = userConfig.qualities || [0, 720, 1080, 2160];

        // Search through configured indexers
        const searchPromises = indexers.map((indexer) =>
            searchAllTorrents({ indexer, query: searchQuery }).catch(() => [])
        );

        const results = await Promise.all(searchPromises);
        const allTorrents = [].concat(...results);

        // Filter by quality preferences
        const filteredTorrents = allTorrents.filter((torrent) =>
            qualities.includes(torrent.quality)
        );

        // Build public URL for proxying posters
        const publicUrl = `${
            req.hostname == "localhost" ? "http" : "https"
        }://${req.hostname}`;

        // Convert to Stremio meta objects
        const metas = convertToMetas(
            filteredTorrents,
            req.params.type,
            publicUrl
        );

        // Filter by catalog type (movie or series)
        const typedMetas = metas.filter(
            (meta) => meta.type === req.params.type
        );

        // Remove duplicates by ID while preserving order (keep first occurrence)
        const seenIds = new Set();
        const uniqueMetas = typedMetas
            .filter((meta) => {
                if (seenIds.has(meta.id)) {
                    return false;
                }
                seenIds.add(meta.id);
                return true;
            })
            // Sort by PublishDate (newest first)
            .sort((a, b) => (b.publishDate || 0) - (a.publishDate || 0))
            .slice(0, 100);

        console.log(
            `Catalog results: found ${uniqueMetas.length} metas for "${searchQuery}"`
        );
        respond(res, { metas: uniqueMetas });
    } catch (err) {
        console.log("Catalog error:", err);
        respond(res, { metas: [] });
    }
});

// Fallback catalog endpoint with query parameters
app.get("/:userConfig?/catalog/:type/:id.json", async (req, res) => {
    try {
        const searchQuery = req.query.search;

        console.log(
            `Catalog request (query): type=${req.params.type}, id=${req.params.id}, search=${searchQuery}`
        );

        if (!searchQuery) {
            return respond(res, { metas: [] });
        }

        let userConfig = config.defaultUserConfig;
        if (req.params.userConfig) {
            userConfig = {
                ...userConfig,
                ...JSON.parse(atob(req.params.userConfig)),
            };
        }

        const indexers = userConfig.indexers || ["all"];
        const qualities = userConfig.qualities || [0, 720, 1080, 2160];

        // Search through configured indexers
        const searchPromises = indexers.map((indexer) =>
            searchAllTorrents({ indexer, query: searchQuery }).catch(() => [])
        );

        const results = await Promise.all(searchPromises);
        const allTorrents = [].concat(...results);

        // Filter by quality preferences
        const filteredTorrents = allTorrents.filter((torrent) =>
            qualities.includes(torrent.quality)
        );

        // Build public URL for proxying posters
        const publicUrl = `${
            req.hostname == "localhost" ? "http" : "https"
        }://${req.hostname}`;

        // Convert to Stremio meta objects
        const metas = convertToMetas(
            filteredTorrents,
            req.params.type,
            publicUrl
        );

        // Filter by catalog type (movie or series)
        const typedMetas = metas.filter(
            (meta) => meta.type === req.params.type
        );

        // Remove duplicates by ID while preserving order (keep first occurrence)
        const seenIds = new Set();
        const uniqueMetas = typedMetas
            .filter((meta) => {
                if (seenIds.has(meta.id)) {
                    return false;
                }
                seenIds.add(meta.id);
                return true;
            })
            // Sort by PublishDate (newest first)
            .sort((a, b) => (b.publishDate || 0) - (a.publishDate || 0))
            .slice(0, 100);

        console.log(
            `Catalog results: found ${uniqueMetas.length} metas for "${searchQuery}"`
        );
        respond(res, { metas: uniqueMetas });
    } catch (err) {
        console.log("Catalog error:", err);
        respond(res, { metas: [] });
    }
});

// Meta endpoint - provide metadata for items from catalog
app.get("/:userConfig?/meta/:type/:id.json", async (req, res) => {
    try {
        const id = req.params.id;

        console.log(`Meta request: type=${req.params.type}, id=${id}`);

        // Check if we have this meta in store
        const storedMeta = torrentMetaStore.get(id);

        if (storedMeta) {
            console.log(`Meta found in store for ${id}`);

            // Build description with torrent info
            const infoLines = [];
            if (storedMeta.description) {
                infoLines.push(storedMeta.description);
            }

            // Add stream-like info
            const streamInfo = [
                `💾${bytesToSize(storedMeta.size || 0)}`,
                `👥${storedMeta.seeders || 0}`,
                `⚙️${storedMeta.indexerId || "unknown"}`,
                ...(storedMeta.languages || []).map(
                    (language) => language.emoji
                ),
            ].join(" ");
            infoLines.push(streamInfo);

            const metaWithInfo = {
                ...storedMeta,
                description: infoLines.join("\n"),
            };

            // Remove internal fields
            delete metaWithInfo._torrent;
            delete metaWithInfo.size;
            delete metaWithInfo.seeders;
            delete metaWithInfo.indexerId;
            delete metaWithInfo.quality;
            delete metaWithInfo.languages;
            delete metaWithInfo.torrentId;

            return respond(res, { meta: metaWithInfo });
        }

        // If not in store, return basic meta structure
        console.log(`Meta not found in store for ${id}`);
        respond(res, {
            meta: {
                id: id,
                type: req.params.type,
                name: id,
            },
        });
    } catch (err) {
        console.log("Meta error:", err);
        respond(res, {
            meta: {
                id: req.params.id,
                type: req.params.type,
                name: req.params.id,
            },
        });
    }
});

app.get("/:userConfig/stream/:type/:id.json", limiter, async (req, res) => {
    try {
        const id = req.params.id;

        // Check if this is a jkt ID (from our catalog search)
        if (id.startsWith("jkt")) {
            console.log(`Stream request for catalog item: ${id}`);

            const storedMeta = torrentMetaStore.get(id);
            if (storedMeta && storedMeta._link) {
                const userConfig = JSON.parse(atob(req.params.userConfig));
                const debridInstance = debrid.instance(userConfig);
                const publicUrl = `${
                    req.hostname == "localhost" ? "http" : "https"
                }://${req.hostname}`;

                // Build quality label
                const quality =
                    storedMeta.quality > 0
                        ? config.qualities.find(
                              (q) => q.value == storedMeta.quality
                          )?.label || ""
                        : "";

                // Build stream info
                const streamInfo = [
                    `💾${bytesToSize(storedMeta.size || 0)}`,
                    `👥${storedMeta.seeders || 0}`,
                    `⚙️${storedMeta.indexerId || "unknown"}`,
                    ...(storedMeta.languages || []).map(
                        (language) => language.emoji
                    ),
                ].join(" ");

                // Generate download URL using torrent ID (same format as IMDB flow)
                const torrentId =
                    storedMeta._torrentId || storedMeta._torrent?.id;
                if (!torrentId) {
                    console.error(`No torrent ID found for custom meta ${id}`);
                    return respond(res, { streams: [] });
                }

                // Use raw torrent name (includes extension) instead of formatted meta name
                const fileName =
                    storedMeta._torrentName ||
                    storedMeta._torrent?.name ||
                    storedMeta.name;

                const stream = {
                    name: `[${debridInstance.shortName}] ${config.addonName} ${quality}`,
                    title: `${storedMeta.name}\n${streamInfo}`,
                    url: `${publicUrl}/${btoa(
                        JSON.stringify(userConfig)
                    )}/download/${
                        req.params.type
                    }/${id}/${torrentId}/${encodeURIComponent(fileName)}`,
                };

                return respond(res, { streams: [stream] });
            } else {
                console.log(`Torrent not found in store for ${id}`);
                return respond(res, { streams: [] });
            }
        }

        // Standard flow for IMDB IDs
        const streams = await jackettio.getStreams(
            Object.assign(JSON.parse(atob(req.params.userConfig)), {
                ip: req.clientIp,
            }),
            req.params.type,
            req.params.id,
            `${req.hostname == "localhost" ? "http" : "https"}://${
                req.hostname
            }`
        );

        return respond(res, { streams });
    } catch (err) {
        console.log(req.params.id, err);
        return respond(res, { streams: [] });
    }
});

app.get("/stream/:type/:id.json", async (req, res) => {
    return respond(res, {
        streams: [
            {
                name: config.addonName,
                title: `ℹ Kindly configure this addon to access streams.`,
                url: "#",
            },
        ],
    });
});

// Route handler: Process download requests for torrents
// Handles both IMDB IDs (tt*) and custom meta IDs (jkt*)
// Creates torrent infos if needed, then generates RealDebrid download links
// Redirects to the final download URL or error video on failure
app.use(
    "/:userConfig/download/:type/:id/:torrentId/:name?",
    async (req, res, next) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
            return next();
        }

        try {
            const stremioId = req.params.id;
            let actualStremioId = stremioId;

            // For jkt IDs from catalog, create torrent infos first if meta is available
            if (stremioId.startsWith("jkt")) {
                const storedMeta = torrentMetaStore.get(stremioId);

                if (storedMeta && storedMeta._link) {
                    console.log(
                        `${stremioId} : Creating torrent infos for catalog item`
                    );

                    // Create/cache torrent infos from stored data
                    await getTorrentInfos({
                        link: storedMeta._link,
                        id: req.params.torrentId,
                        magnetUrl: storedMeta._magnetUrl || "",
                        infoHash: storedMeta._infoHash || "",
                        name: storedMeta.name,
                        size: storedMeta.size,
                    });

                    // Use dummy stremio ID for movie/series without specific episode
                    actualStremioId = `jkt:0:0`;
                } else {
                    console.log(
                        `${stremioId} : Meta not found in store, checking if torrent info exists`
                    );
                    // Meta not found, but torrent info might already exist from previous request
                    // Try to get torrent info - if it doesn't exist, getDownload will handle the error
                    try {
                        await getTorrentInfoById(req.params.torrentId);
                        console.log(
                            `${stremioId} : Torrent info found, proceeding with download`
                        );
                    } catch (err) {
                        console.log(
                            `${stremioId} : Torrent info not found, cannot proceed without meta`
                        );
                        return res
                            .status(404)
                            .send(
                                "Torrent meta not found. Please search again from catalog."
                            );
                    }
                    actualStremioId = `jkt:0:0`;
                }
            }

            const url = await jackettio.getDownload(
                Object.assign(JSON.parse(atob(req.params.userConfig)), {
                    ip: req.clientIp,
                }),
                req.params.type,
                actualStremioId,
                req.params.torrentId
            );

            const parsed = new URL(url);
            const cut = (value) =>
                value ? `${value.substr(0, 5)}******${value.substr(-5)}` : "";
            console.log(
                `${req.params.id} : Redirect: ${parsed.protocol}//${
                    parsed.host
                }${cut(parsed.pathname)}${cut(parsed.search)}`
            );

            res.status(302);
            res.set("location", url);
            res.send("");
        } catch (err) {
            console.log(req.params.id, err);

            switch (err.message) {
                case debrid.ERROR.NOT_READY:
                    res.status(302);
                    res.set("location", `/videos/not_ready.mp4`);
                    res.send("");
                    break;
                case debrid.ERROR.EXPIRED_API_KEY:
                    res.status(302);
                    res.set("location", `/videos/expired_api_key.mp4`);
                    res.send("");
                    break;
                case debrid.ERROR.NOT_PREMIUM:
                    res.status(302);
                    res.set("location", `/videos/not_premium.mp4`);
                    res.send("");
                    break;
                case debrid.ERROR.ACCESS_DENIED:
                    res.status(302);
                    res.set("location", `/videos/access_denied.mp4`);
                    res.send("");
                    break;
                case debrid.ERROR.TWO_FACTOR_AUTH:
                    res.status(302);
                    res.set("location", `/videos/two_factor_auth.mp4`);
                    res.send("");
                    break;
                default:
                    res.status(302);
                    res.set("location", `/videos/error.mp4`);
                    res.send("");
            }
        }
    }
);

// Middleware: Handle 404 errors for unmatched routes
// Returns JSON error for AJAX requests, plain text for regular requests
app.use((req, res) => {
    if (req.xhr) {
        res.status(404).send({ error: "Page not found!" });
    } else {
        res.status(404).send("Page not found!");
    }
});

// Middleware: Global error handler for unhandled exceptions
// Logs error stack trace to console and returns 500 error
// Returns JSON error for AJAX requests, plain text for regular requests
app.use((err, req, res, next) => {
    console.error(err.stack);
    if (req.xhr) {
        res.status(500).send({ error: "Something broke!" });
    } else {
        res.status(500).send("Something broke!");
    }
});

const server = app.listen(config.port, async () => {
    console.log("───────────────────────────────────────");
    console.log(`Started addon ${addon.name} v${addon.version}`);
    console.log(`Server listen at: http://localhost:${config.port}`);
    console.log("───────────────────────────────────────");

    let tunnel;
    let isRestarting = false;
    let isShuttingDown = false;
    let retryDelay = 5000; // Start with 5 seconds delay

    async function createTunnel() {
        if (isRestarting || isShuttingDown) return; // Prevent multiple simultaneous restarts or restarts during shutdown

        try {
            let subdomain = await cache.get("localtunnel:subdomain");
            const newTunnel = await localtunnel({
                port: config.port,
                subdomain,
            });

            await cache.set("localtunnel:subdomain", newTunnel.clientId, {
                ttl: 86400 * 365,
            });

            console.log(
                `Your addon is available on the following address: ${newTunnel.url}/configure`
            );

            // Reset retry delay on successful connection
            retryDelay = 5000;

            newTunnel.on("close", () => {
                console.log("Localtunnel closed, attempting to reconnect...");
                if (tunnel === newTunnel && !isShuttingDown) {
                    tunnel = null;
                    setTimeout(() => createTunnel(), retryDelay);
                }
            });

            newTunnel.on("error", (err) => {
                console.error("Localtunnel error:", err.message);

                // Close the tunnel if it's still open
                if (tunnel === newTunnel) {
                    tunnel = null;
                    try {
                        newTunnel.close();
                    } catch (e) {
                        // Ignore errors when closing
                    }
                }

                // Don't restart if shutting down
                if (isShuttingDown) {
                    return;
                }

                console.log(
                    `Attempting to restart tunnel in ${
                        retryDelay / 1000
                    } seconds...`
                );

                // Restart with exponential backoff (max 60 seconds)
                isRestarting = true;
                setTimeout(() => {
                    isRestarting = false;
                    if (!isShuttingDown) {
                        createTunnel();
                    }
                }, retryDelay);

                // Increase retry delay for next attempt (exponential backoff, capped at 60s)
                retryDelay = Math.min(retryDelay * 1.5, 60000);
            });

            tunnel = newTunnel;
        } catch (err) {
            console.error("Failed to create localtunnel:", err.message);

            // Don't retry if shutting down
            if (isShuttingDown) {
                return;
            }

            console.log(`Retrying in ${retryDelay / 1000} seconds...`);

            isRestarting = true;
            setTimeout(() => {
                isRestarting = false;
                if (!isShuttingDown) {
                    createTunnel();
                }
            }, retryDelay);

            // Increase retry delay for next attempt
            retryDelay = Math.min(retryDelay * 1.5, 60000);
        }
    }

    if (config.localtunnel) {
        await createTunnel();
    }

    icon.download().catch((err) =>
        console.log(`Failed to download icon: ${err}`)
    );

    const intervals = [];
    createTorrentFolder();
    intervals.push(setInterval(cleanTorrentFolder, 3600e3));

    vacuumCache().catch((err) => console.log(`Failed to vacuum cache: ${err}`));
    intervals.push(setInterval(() => vacuumCache(), 86400e3 * 7));

    cleanCache().catch((err) => console.log(`Failed to clean cache: ${err}`));
    intervals.push(setInterval(() => cleanCache(), 3600e3));

    function closeGracefully(signal) {
        console.log(`Received signal to terminate: ${signal}`);
        isShuttingDown = true; // Prevent tunnel restarts during shutdown
        if (tunnel) {
            try {
                tunnel.close();
            } catch (e) {
                // Ignore errors when closing
            }
        }
        intervals.forEach((interval) => clearInterval(interval));
        server.close(() => {
            console.log("Server closed");
            process.kill(process.pid, signal);
        });
    }
    process.once("SIGINT", closeGracefully);
    process.once("SIGTERM", closeGracefully);
});
