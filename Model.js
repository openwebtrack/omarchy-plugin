// Helpers for OpenWebTrack REST API v1 plugin.
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
var PERIODS = ["24h", "7d", "30d", "90d"]
var GRANULARITIES = ["hourly", "daily", "weekly", "monthly"]

function trimSlash(url) {
    var s = String(url || "").trim()
    while (s.length > 1 && s.charAt(s.length - 1) === "/") s = s.slice(0, -1)
    return s
}

function isValidUUID(v) {
    return UUID_RE.test(String(v || "").trim())
}

function isValidApiKey(k) {
    var s = String(k || "").trim()
    return s.indexOf("owt_") === 0 && s.length >= 12
}

function isValidMcpKey(k) {
    var s = String(k || "").trim()
    return s.indexOf("owt_mcp_") === 0 && s.length >= 16
}

function isEncrypted(v) {
    return String(v || "").trim().indexOf("enc:") === 0
}
function stripEnc(v) {
    var s = String(v || "").trim()
    return s.indexOf("enc:") === 0 ? s.slice(4) : s
}
function buildEncryptCommand(plain) {
    var p = String(plain || "");
    // Use a proper secret key stored in a protected file (keyring)
    var keyPath = "$HOME/.config/omarchy/keyring";
    var keyFile = new File(keyPath);
    if (!keyFile || !keyFile.isReadable()) {
        throw new Error("Encryption key not available");
    }
    var key = keyFile.read(); // read the passphrase
    var esc = p.replace(/'/g, "'\"'\"'");
    var cmd = "echo -n '" + esc + "' | openssl enc -aes-256-cbc -pbkdf2 -pass file:" + keyPath + " -a -A";
    return ["bash", "-c", cmd];
}
function buildDecryptCommand(encValue) {
    var b64 = stripEnc(encValue)
    var esc = b64.replace(/'/g, "'\"'\"'")
    var keyPath = "$HOME/.config/omarchy/keyring";
    var keyFile = new File(keyPath);
    if (!keyFile || !keyFile.isReadable()) {
        throw new Error("Decryption key not available");
    }
    var key = keyFile.read(); // read the passphrase
    var cmd = "echo -n '" + esc + "' | openssl enc -d -aes-256-cbc -pbkdf2 -pass file:" + keyPath + " -a -A";
    return ["bash", "-c", cmd];
}

function parseSites(jsonText) {
    var raw = String(jsonText || "").trim()
    if (!raw) return []
    try {
        var arr = JSON.parse(raw)
        if (!Array.isArray(arr)) return []
        var out = []
        for (var i = 0; i < arr.length; i++) {
            var o = arr[i]
            if (!o || typeof o !== "object") continue
            var id = String(o.id || o.websiteId || "").trim()
            var name = String(o.name || o.domain || o.label || id).trim()
            var key = String(o.apiKey || o.key || o.token || "").trim()
            if (!isValidUUID(id)) continue
            if (!name) name = id.slice(0, 8)
            if (!isValidApiKey(key)) continue
            out.push({ id: id, name: name, apiKey: key })
        }
        return out
    } catch (e) {
        return []
    }
}

function sitesOptions(sites) {
    var list = sites || []
    var opts = []
    for (var i = 0; i < list.length; i++) {
        opts.push({ value: list[i].id, label: list[i].name })
    }
    return opts
}

function getSiteById(sites, id) {
    var target = String(id || "").trim()
    for (var i = 0; i < (sites || []).length; i++) {
        if (sites[i].id === target) return sites[i]
    }
    return null
}

function effectiveSelectedId(sites, configuredId) {
    if (isValidUUID(configuredId) && getSiteById(sites, configuredId)) return String(configuredId).trim()
    if (sites && sites.length > 0) return sites[0].id
    return ""
}

function normalizePeriod(p) {
    var s = String(p || "").trim()
    return PERIODS.indexOf(s) !== -1 ? s : "7d"
}

function normalizeGranularity(g) {
    var s = String(g || "").trim().toLowerCase()
    return GRANULARITIES.indexOf(s) !== -1 ? s : "daily"
}

function periodToDateRange(period) {
    var p = normalizePeriod(period)
    var now = new Date()
    var start = new Date(now)
    if (p === "24h") start = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    else if (p === "7d") start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    else if (p === "30d") start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    else if (p === "90d") start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
    return { start: start, end: now, startIso: start.toISOString(), endIso: now.toISOString() }
}

function buildStatsUrl(baseUrl, websiteId, period, granularity) {
    var base = trimSlash(baseUrl);
    if (!base) {
        // Default to secure localhost
        base = "https://127.0.0.1:8424";
    }
    // Validate scheme and host
    var lower = base.toLowerCase();
    if (lower.startsWith("http://")) {
        var hostPart = lower.split("://")[1];
        var host = hostPart.split(":")[0];
        if (host !== "127.0.0.1" && host !== "localhost") {
            throw new Error("HTTP URL must use loopback address");
        }
    } else if (lower.startsWith("https://")) {
        // https is allowed for any host (maybe internal)
    } else {
        throw new Error("Only http or https URLs are allowed");
    }
    var id = String(websiteId || "").trim();
    if (!isValidUUID(id)) return "";
    var gran = normalizeGranularity(granularity);
    var range = periodToDateRange(period);
    var qs = "startDate=" + encodeURIComponent(range.startIso) +
             "&endDate=" + encodeURIComponent(range.endIso) +
             "&granularity=" + encodeURIComponent(gran);
    return base + "/api/v1/" + encodeURIComponent(id) + "/stats?" + qs;
}

function buildCurlCommand(baseUrl, websiteId, apiKey, period, granularity) {
    var url = buildStatsUrl(baseUrl, websiteId, period, granularity);
    if (!url) return null;
    // Write API key to a temporary file (non-argv channel)
    var tmpPath = "/tmp/omarchy_api_key_" + Math.random().toString(36).substr(2, 9);
    try {
        var fs = new File(tmpPath);
        fs.write(apiKey);
        fs.close();
        var keyFile = tmpPath;
        return ["curl", "-sS", "--max-time", "15", "-H", "Authorization: Bearer $(cat " + keyFile + ")", url];
    } catch (e) {
        return null;
    }
}

function buildMcpCurlCommand(baseUrl, mcpKey, toolName, args) {
    var base = trimSlash(baseUrl);
    if (!base) base = "http://localhost:8424";
    var url = base + "/api/mcp";
    // Write MCP key to a temporary file (non-argv channel)
    var tmpPath = "/tmp/omarchy_mcp_key_" + Math.random().toString(36).substr(2, 9);
    try {
        var fs = new File(tmpPath);
        fs.write(mcpKey);
        fs.close();
        var keyFile = tmpPath;
        var payload = {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: toolName, arguments: args || {} }
        };
        var json = JSON.stringify(payload);
        return ["curl", "-sS", "--max-time", "15",
                "-H", "Authorization: Bearer $(cat " + keyFile + ")",
                "-H", "Content-Type: application/json",
                "-H", "Accept: application/json, text/event-stream",
                "-d", json, url];
    } catch (e) {
        return null;
    }
}

function parseMcpSse(text) {
    var raw = String(text || "").trim()
    if (!raw) return { ok: false, error: "Empty MCP response" }
    // SSE format: "event: message\ndata: {...}"
    var dataLine = ""
    var lines = raw.split("\n")
    for (var i = 0; i < lines.length; i++) {
        var line = String(lines[i] || "").trim()
        if (line.indexOf("data: ") === 0) { dataLine = line.slice(6); break }
        // fallback: if no SSE prefix, treat whole body as JSON
        if (line.charAt(0) === "{" ) { dataLine = raw; break }
    }
    if (!dataLine) dataLine = raw
    try {
        var outer = JSON.parse(dataLine)
        if (outer && outer.error) return { ok: false, error: String(outer.error.message || outer.error) }
        if (outer && outer.result && outer.result.isError) {
            var errContent = outer.result.content && outer.result.content[0] ? outer.result.content[0].text : ""
            try { var parsedErr = JSON.parse(errContent); return { ok: false, error: String(parsedErr.error || errContent).slice(0,400) } } catch(e2) { return { ok: false, error: String(errContent).slice(0,400) } }
        }
        if (!outer || !outer.result || !outer.result.content || !outer.result.content[0]) return { ok: false, error: "Invalid MCP envelope" }
        var innerText = String(outer.result.content[0].text || "").trim()
        if (!innerText) return { ok: false, error: "Empty MCP content" }
        return { ok: true, innerText: innerText, envelope: outer }
    } catch (e) {
        return { ok: false, error: "Invalid MCP JSON: " + String(e.message || e) }
    }
}

function parseMcpListWebsites(text) {
    var sse = parseMcpSse(text)
    if (!sse.ok) return sse
    try {
        var arr = JSON.parse(sse.innerText)
        if (!Array.isArray(arr)) return { ok: false, error: "MCP list_websites not an array" }
        if (arr.length > 200) return { ok: false, error: "Too many sites" }
        var out = []
        for (var i = 0; i < arr.length; i++) {
            var o = arr[i]
            if (!o || typeof o !== "object") continue
            var id = String(o.id || "").trim()
            var domain = String(o.domain || o.name || id).trim()
            if (!isValidUUID(id)) continue
            out.push({ id: id, name: domain, domain: domain, timezone: o.timezone || "", currency: o.currency || "USD", access: o.access || "owner" })
        }
        return { ok: true, sites: out, raw: arr }
    } catch (e) {
        return { ok: false, error: "Invalid list_websites JSON: " + String(e.message || e) }
    }
}

function parseMcpAnalyticsOverview(text) {
    var sse = parseMcpSse(text)
    if (!sse.ok) return sse
    try {
        var data = JSON.parse(sse.innerText)
        if (data && data.error) return { ok: false, error: String(data.error) }
        // shape: { website:{id,domain}, dateRange, pageviews, sessions, uniqueVisitors, revenue, currency, topPages }
        if (!data || typeof data.pageviews === "undefined") return { ok: false, error: "Missing pageviews in MCP overview" }
        return {
            ok: true,
            summary: {
                pageviews: Number(data.pageviews || 0),
                sessions: Number(data.sessions || 0),
                visitors: Number(data.uniqueVisitors || 0),
                bounceRate: Number(data.bounceRate || 0),
                revenue: Number(data.revenue || 0),
                currency: String(data.currency || "USD"),
                dateRange: data.dateRange || null
            },
            topPages: Array.isArray(data.topPages) ? data.topPages.slice(0, 100) : [],
            raw: data
        }
    } catch (e) {
        return { ok: false, error: "Invalid MCP overview JSON: " + String(e.message || e) }
    }
}
    } catch (e) {
        return { ok: false, error: "Invalid MCP overview JSON: " + String(e.message || e) }
    }
}

function formatNumber(n) {
    var num = Number(n)
    if (!isFinite(num)) return "—"
    if (num >= 1000000) return (num / 1000000).toFixed(num >= 10000000 ? 1 : 2).replace(/\.0+$/, "") + "M"
    if (num >= 1000) return (num / 1000).toFixed(num >= 10000 ? 1 : 1).replace(/\.0$/, "") + "k"
    return String(Math.round(num))
}

function formatPercent(n) {
    var num = Number(n)
    if (!isFinite(num)) return "—"
    return num.toFixed(1) + "%"
}

function parseStatsResponse(text) {
    var raw = String(text || "").trim()
    if (!raw) return { ok: false, error: "Empty response" }
    try {
        var data = JSON.parse(raw)
        if (data && data.error) {
            return { ok: false, error: String(data.error) }
        }
        // v1 shape: { summary: {pageviews,sessions,visitors,bounceRate,dateRange}, timeSeries, topPages, topReferrers }
        if (!data || !data.summary) return { ok: false, error: "Missing summary in response" }
        var summary = data.summary
        var ts = Array.isArray(data.timeSeries) ? data.timeSeries.slice(0, 1000) : []
        var pages = Array.isArray(data.topPages) ? data.topPages.slice(0, 100) : []
        var refs = Array.isArray(data.topReferrers) ? data.topReferrers.slice(0, 100) : []
        // Normalize numbers
        return {
            ok: true,
            summary: {
                pageviews: Number(summary.pageviews || 0),
                sessions: Number(summary.sessions || 0),
                visitors: Number(summary.visitors || 0),
                bounceRate: Number(summary.bounceRate || 0),
                dateRange: summary.dateRange || null
            },
            timeSeries: ts,
            topPages: pages,
            topReferrers: refs,
            raw: data
        }
    } catch (e) {
        return { ok: false, error: "Invalid JSON: " + String(e.message || e) }
    }
}

function summaryLabel(stats) {
    if (!stats || !stats.ok) return "—"
    return formatNumber(stats.summary.visitors) + " visitors · " + formatNumber(stats.summary.pageviews) + " views"
}

function barLabelForSite(site, stats) {
    var name = site ? site.name : "OpenWebTrack"
    if (!stats) return name
    if (!stats.ok) return name + " · error"
    return name + " · " + formatNumber(stats.summary.visitors) + " · " + formatNumber(stats.summary.pageviews)
}

function maxTimeSeriesValue(ts) {
    var max = 0
    for (var i = 0; i < (ts || []).length; i++) {
        var v = Number(ts[i].pageviews || 0)
        if (v > max) max = v
    }
    return max || 1
}

function clampInterval(sec) {
    var n = Math.round(Number(sec))
    if (!isFinite(n)) return 300
    return Math.max(30, Math.min(3600, n))
}

if (typeof module !== "undefined") {
    module.exports = {
        trimSlash: trimSlash,
        isValidUUID: isValidUUID,
        isValidApiKey: isValidApiKey,
        isValidMcpKey: isValidMcpKey,
        isEncrypted: isEncrypted,
        stripEnc: stripEnc,
        buildEncryptCommand: buildEncryptCommand,
        buildDecryptCommand: buildDecryptCommand,
        parseSites: parseSites,
        sitesOptions: sitesOptions,
        getSiteById: getSiteById,
        effectiveSelectedId: effectiveSelectedId,
        normalizePeriod: normalizePeriod,
        normalizeGranularity: normalizeGranularity,
        periodToDateRange: periodToDateRange,
        buildStatsUrl: buildStatsUrl,
        buildCurlCommand: buildCurlCommand,
        buildMcpCurlCommand: buildMcpCurlCommand,
        parseMcpSse: parseMcpSse,
        parseMcpListWebsites: parseMcpListWebsites,
        parseMcpAnalyticsOverview: parseMcpAnalyticsOverview,
        formatNumber: formatNumber,
        formatPercent: formatPercent,
        parseStatsResponse: parseStatsResponse,
        summaryLabel: summaryLabel,
        barLabelForSite: barLabelForSite,
        maxTimeSeriesValue: maxTimeSeriesValue,
        clampInterval: clampInterval
    }
}
