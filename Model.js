// Helpers for OpenWebTrack REST API v1 plugin.
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
var PERIODS = ["24h", "7d", "30d", "90d"]
var GRANULARITIES = ["hourly", "daily", "weekly", "monthly"]
var MAX_RESPONSE_BYTES = 1048576
var MAX_STRING_LEN = 256
var MAX_LABEL_LEN = 128

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
    if (s.length < 12 || s.length > 256) return false
    if (/[\x00-\x1f\x7f\s"'`\\]/.test(s)) return false
    return /^owt_[A-Za-z0-9_\-]+$/.test(s)
}

function isValidMcpKey(k) {
    var s = String(k || "").trim()
    if (s.length < 16 || s.length > 256) return false
    if (/[\x00-\x1f\x7f\s"'`\\]/.test(s)) return false
    return /^owt_mcp_[A-Za-z0-9_\-]+$/.test(s)
}

function isEncrypted(v) {
    return String(v || "").trim().indexOf("enc:") === 0
}
function stripEnc(v) {
    var s = String(v || "").trim()
    return s.indexOf("enc:") === 0 ? s.slice(4) : s
}

function shellEscapeSingle(s) {
    return String(s || "").replace(/'/g, "'\"'\"'")
}

function isLoopbackHost(host) {
    var h = String(host || "").trim().toLowerCase()
    if (h === "127.0.0.1") return true
    if (h === "localhost") return true
    if (h === "::1") return true
    if (h === "[::1]") return true
    return false
}

function validateInstanceUrl(baseUrl) {
    var raw = trimSlash(String(baseUrl || "").trim())
    if (!raw) {
        // Default secure localhost for callers that pass empty
        raw = "https://127.0.0.1:8424"
    }
    // Reject raw userinfo and fragment/query tricks before parsing
    // Do a quick raw check for @ before first / after scheme
    var schemeEnd = raw.indexOf("://")
    if (schemeEnd !== -1) {
        var afterScheme = raw.slice(schemeEnd + 3)
        var slashIdx = afterScheme.indexOf("/")
        var qIdx = afterScheme.indexOf("?")
        var hIdx = afterScheme.indexOf("#")
        var authEnd = afterScheme.length
        if (slashIdx !== -1) authEnd = Math.min(authEnd, slashIdx)
        if (qIdx !== -1) authEnd = Math.min(authEnd, qIdx)
        if (hIdx !== -1) authEnd = Math.min(authEnd, hIdx)
        var authority = afterScheme.slice(0, authEnd)
        if (authority.indexOf("@") !== -1) throw new Error("Credentials in URL not allowed")
        // Reject control characters in raw URL
        if (/[\x00-\x1f\x7f]/.test(raw)) throw new Error("Invalid instance URL")
    }
    var u
    try {
        u = new URL(raw)
    } catch (e) {
        throw new Error("Invalid instance URL")
    }
    var scheme = String(u.protocol || "").toLowerCase()
    if (scheme !== "http:" && scheme !== "https:") {
        throw new Error("Only http or https URLs are allowed")
    }
    // Reject userinfo
    if (u.username || u.password) {
        throw new Error("Credentials in URL not allowed")
    }
    var host = String(u.hostname || "").trim().toLowerCase()
    if (!host) throw new Error("Invalid instance URL: missing host")
    if (host.indexOf("@") !== -1) throw new Error("Invalid instance URL")
    if (scheme === "http:" && !isLoopbackHost(host)) {
        throw new Error("HTTP URL must use loopback address (127.0.0.1, localhost, ::1)")
    }
    // Rebuild canonical base without trailing slash, without userinfo, without search/hash, preserving port
    var port = u.port ? ":" + u.port : ""
    var isIPv6 = host.indexOf(":") !== -1
    var hostPart
    if (host.charAt(0) === "[") {
        hostPart = host
    } else if (isIPv6) {
        hostPart = "[" + host + "]"
    } else {
        hostPart = u.hostname
    }
    var canonical = scheme + "//" + hostPart + port
    // Preserve pathname if any beyond "/" (normally empty)
    if (u.pathname && u.pathname !== "/") {
        canonical += u.pathname.replace(/\/$/, "")
    }
    return canonical
}

function getKeyringPath() {
    return "$HOME/.config/omarchy/keyring"
}

function buildEncryptCommand(plain) {
    var p = String(plain || "")
    if (!p) throw new Error("Empty secret")
    var tmpIn = "/tmp/omarchy-enc-" + Math.random().toString(36).slice(2, 9)
    var escIn = shellEscapeSingle(tmpIn)
    var escSecret = shellEscapeSingle(p)
    // Keyring lives at $HOME/.config/omarchy/keyring — auto-create with 0600 if missing
    // Do NOT single-quote $HOME here (needs expansion). Bash will expand $HOME in double quotes.
    // Try GCM first, fallback to CBC for systems where openssl enc lacks AEAD support (e.g. Arch OpenSSL 3.6)
    var script = "umask 077; printf '%s' '" + escSecret + "' > '" + escIn + "'; chmod 600 '" + escIn + "' 2>/dev/null; " +
        "key=\"$HOME/.config/omarchy/keyring\"; mkdir -p \"$(dirname \"$key\")\" 2>/dev/null; " +
        "if [ ! -f \"$key\" ]; then openssl rand -hex 32 > \"$key\" 2>/dev/null; chmod 600 \"$key\" 2>/dev/null; fi; " +
        "if ! [ -r \"$key\" ]; then shred -u '" + escIn + "' 2>/dev/null || rm -f '" + escIn + "'; echo 'keyring not readable' >&2; exit 2; fi; " +
        "openssl enc -aes-256-gcm -pbkdf2 -pass file:\"$key\" -in '" + escIn + "' -a -A 2>/dev/null || " +
        "openssl enc -aes-256-cbc -pbkdf2 -pass file:\"$key\" -in '" + escIn + "' -a -A; " +
        "rc=$?; shred -u '" + escIn + "' 2>/dev/null || rm -f '" + escIn + "'; exit $rc"
    return ["bash", "-c", script]
}
function buildDecryptCommand(encValue) {
    var b64 = stripEnc(encValue)
    if (!b64) throw new Error("Empty encrypted value")
    // Basic base64 sanity - no newlines, length cap
    if (b64.length > 8192) throw new Error("Encrypted value too large")
    var tmpIn = "/tmp/omarchy-dec-" + Math.random().toString(36).slice(2, 9)
    var escIn = shellEscapeSingle(tmpIn)
    var escB64 = shellEscapeSingle(b64)
    // For decrypt, try GCM first, fallback to CBC only for migration of old values — then caller should re-encrypt to GCM
    // Do NOT single-quote $HOME (needs expansion)
    var script = "umask 077; printf '%s' '" + escB64 + "' > '" + escIn + "'; chmod 600 '" + escIn + "' 2>/dev/null; " +
        "key=\"$HOME/.config/omarchy/keyring\"; " +
        "if ! [ -r \"$key\" ]; then shred -u '" + escIn + "' 2>/dev/null || rm -f '" + escIn + "'; echo 'keyring not readable' >&2; exit 2; fi; " +
        "openssl enc -d -aes-256-gcm -pbkdf2 -pass file:\"$key\" -in '" + escIn + "' -a -A 2>/dev/null || " +
        "openssl enc -d -aes-256-cbc -pbkdf2 -pass file:\"$key\" -in '" + escIn + "' -a -A; " +
        "rc=$?; shred -u '" + escIn + "' 2>/dev/null || rm -f '" + escIn + "'; exit $rc"
    return ["bash", "-c", script]
}

function escapeForCurlConfig(s) {
    return String(s || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, "")
}

function sanitizeString(s, maxLen) {
    var str = String(s || "")
    if (str.length > (maxLen || MAX_STRING_LEN)) str = str.slice(0, maxLen || MAX_STRING_LEN)
    return str
}

function sanitizeDomain(s) {
    var str = sanitizeString(s, MAX_LABEL_LEN).trim()
    // Allow only printable, no control
    str = str.replace(/[\x00-\x1f\x7f]/g, "")
    return str
}

function toFiniteNumber(v, defVal) {
    var n = Number(v)
    if (!isFinite(n)) return typeof defVal !== "undefined" ? defVal : 0
    return n
}

function parseSites(jsonText) {
    var raw = String(jsonText || "").trim()
    if (!raw) return []
    if (raw.length > MAX_RESPONSE_BYTES) return []
    try {
        var arr = JSON.parse(raw)
        if (!Array.isArray(arr)) return []
        if (arr.length > 200) arr = arr.slice(0, 200)
        var out = []
        for (var i = 0; i < arr.length; i++) {
            var o = arr[i]
            if (!o || typeof o !== "object") continue
            var id = sanitizeString(o.id || o.websiteId || "").trim()
            var name = sanitizeString(o.name || o.domain || o.label || id, MAX_LABEL_LEN).trim()
            var key = sanitizeString(o.apiKey || o.key || o.token || "").trim()
            if (!isValidUUID(id)) continue
            if (!name) name = id.slice(0, 8)
            name = sanitizeDomain(name)
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
        opts.push({ value: sanitizeString(list[i].id, 64), label: sanitizeDomain(list[i].name) })
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
    var base = validateInstanceUrl(baseUrl)
    var id = String(websiteId || "").trim()
    if (!isValidUUID(id)) return ""
    var gran = normalizeGranularity(granularity)
    var range = periodToDateRange(period)
    var qs = "startDate=" + encodeURIComponent(range.startIso) +
             "&endDate=" + encodeURIComponent(range.endIso) +
             "&granularity=" + encodeURIComponent(gran)
    return base + "/api/v1/" + encodeURIComponent(id) + "/stats?" + qs
}

function buildCurlCommand(baseUrl, websiteId, apiKey, period, granularity) {
    var url = buildStatsUrl(baseUrl, websiteId, period, granularity)
    if (!url) return null
    var key = String(apiKey || "").trim()
    if (!isValidApiKey(key)) return null
    var cfg = "/tmp/omarchy-curl-" + Math.random().toString(36).slice(2, 9)
    var hdr = 'header = "Authorization: Bearer ' + escapeForCurlConfig(key) + '"'
    var escCfg = shellEscapeSingle(cfg)
    var escHdr = shellEscapeSingle(hdr)
    var escUrl = shellEscapeSingle(url)
    // Use -K config, --max-filesize caps producer bytes, --max-time, --proto to enforce https/http only
    var script = "umask 077; printf '%s' '" + escHdr + "' > '" + escCfg + "'; chmod 600 '" + escCfg + "' 2>/dev/null; " +
        "curl -sS --max-time 15 --max-filesize " + MAX_RESPONSE_BYTES + " --proto =https,http --proto-redir =https,http -K '" + escCfg + "' '" + escUrl + "'; " +
        "rc=$?; shred -u '" + escCfg + "' 2>/dev/null || rm -f '" + escCfg + "'; exit $rc"
    return ["bash", "-c", script]
}

function buildMcpCurlCommand(baseUrl, mcpKey, toolName, args) {
    var base = validateInstanceUrl(baseUrl)
    var url = base + "/api/mcp"
    var key = String(mcpKey || "").trim()
    if (!isValidMcpKey(key)) return null
    var tn = sanitizeString(toolName || "", 64)
    if (!tn) return null
    // Bound args size
    var argsStr = ""
    try {
        var a = args || {}
        var jsonArgs = JSON.stringify(a)
        if (jsonArgs.length > 8192) return null
        argsStr = jsonArgs
    } catch (e) { return null }
    var payload = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tn, arguments: args || {} }
    }
    var json = JSON.stringify(payload)
    if (json.length > 16384) return null
    var cfg = "/tmp/omarchy-mcp-cfg-" + Math.random().toString(36).slice(2, 9)
    var payloadFile = "/tmp/omarchy-mcp-payload-" + Math.random().toString(36).slice(2, 9)
    var hdr = 'header = "Authorization: Bearer ' + escapeForCurlConfig(key) + '"\n' +
              'header = "Content-Type: application/json"\n' +
              'header = "Accept: application/json, text/event-stream"'
    var escCfg2 = shellEscapeSingle(cfg)
    var escHdr2 = shellEscapeSingle(hdr)
    var escPayload = shellEscapeSingle(payloadFile)
    var escJson = shellEscapeSingle(json)
    var escUrl2 = shellEscapeSingle(url)
    var script2 = "umask 077; printf '%s' '" + escHdr2 + "' > '" + escCfg2 + "'; printf '%s' '" + escJson + "' > '" + escPayload + "'; chmod 600 '" + escCfg2 + "' '" + escPayload + "' 2>/dev/null; " +
        "curl -sS --max-time 15 --max-filesize " + MAX_RESPONSE_BYTES + " --proto =https,http --proto-redir =https,http -K '" + escCfg2 + "' -d @'" + escPayload + "' '" + escUrl2 + "'; " +
        "rc=$?; shred -u '" + escCfg2 + "' '" + escPayload + "' 2>/dev/null || rm -f '" + escCfg2 + "' '" + escPayload + "'; exit $rc"
    return ["bash", "-c", script2]
}

function parseMcpSse(text) {
    var raw = String(text || "").trim()
    if (!raw) return { ok: false, error: "Empty MCP response" }
    if (raw.length > MAX_RESPONSE_BYTES) return { ok: false, error: "MCP response too large" }
    var dataLine = ""
    var lines = raw.split("\n")
    if (lines.length > 5000) return { ok: false, error: "MCP response too many lines" }
    for (var i = 0; i < lines.length; i++) {
        var line = String(lines[i] || "").trim()
        if (line.length > 8192) continue
        if (line.indexOf("data: ") === 0) { dataLine = line.slice(6); break }
        if (line.charAt(0) === "{" ) { dataLine = raw; break }
    }
    if (!dataLine) dataLine = raw
    if (dataLine.length > MAX_RESPONSE_BYTES) return { ok: false, error: "MCP data too large" }
    try {
        var outer = JSON.parse(dataLine)
        if (outer && outer.error) return { ok: false, error: sanitizeString(String(outer.error.message || outer.error), 400) }
        if (outer && outer.result && outer.result.isError) {
            var errContent = outer.result.content && outer.result.content[0] ? outer.result.content[0].text : ""
            try { var parsedErr = JSON.parse(errContent); return { ok: false, error: sanitizeString(String(parsedErr.error || errContent),400) } } catch(e2) { return { ok: false, error: sanitizeString(String(errContent),400) } }
        }
        if (!outer || !outer.result || !outer.result.content || !outer.result.content[0]) return { ok: false, error: "Invalid MCP envelope" }
        var innerText = String(outer.result.content[0].text || "").trim()
        if (!innerText) return { ok: false, error: "Empty MCP content" }
        if (innerText.length > MAX_RESPONSE_BYTES) return { ok: false, error: "MCP content too large" }
        return { ok: true, innerText: innerText, envelope: outer }
    } catch (e) {
        return { ok: false, error: "Invalid MCP JSON: " + sanitizeString(String(e.message || e),200) }
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
            var id = sanitizeString(o.id || "", 64).trim()
            var domain = sanitizeDomain(o.domain || o.name || id)
            if (!isValidUUID(id)) continue
            if (!domain) domain = id.slice(0, 8)
            out.push({ id: id, name: domain, domain: domain, timezone: sanitizeString(o.timezone || "", 64), currency: sanitizeString(o.currency || "USD", 16), access: sanitizeString(o.access || "owner", 32) })
        }
        return { ok: true, sites: out }
    } catch (e) {
        return { ok: false, error: "Invalid list_websites JSON: " + sanitizeString(String(e.message || e),200) }
    }
}

function parseMcpAnalyticsOverview(text) {
    var sse = parseMcpSse(text)
    if (!sse.ok) return sse
    try {
        var data = JSON.parse(sse.innerText)
        if (data && data.error) return { ok: false, error: sanitizeString(String(data.error),400) }
        if (!data || typeof data.pageviews === "undefined") return { ok: false, error: "Missing pageviews in MCP overview" }
        var tp = Array.isArray(data.topPages) ? data.topPages.slice(0, 100) : []
        // Sanitize topPages entries
        var cleanPages = []
        for (var i=0;i<tp.length;i++) {
            var p = tp[i]
            if (!p || typeof p !== "object") continue
            cleanPages.push({
                pathname: sanitizeString(p.pathname || p.path || "/", 256),
                views: toFiniteNumber(p.views ?? p.pageviews ?? p.value, 0),
                value: toFiniteNumber(p.value ?? p.views ?? 0, 0)
            })
        }
        return {
            ok: true,
            summary: {
                pageviews: toFiniteNumber(data.pageviews, 0),
                sessions: toFiniteNumber(data.sessions, 0),
                visitors: toFiniteNumber(data.uniqueVisitors, 0),
                bounceRate: toFiniteNumber(data.bounceRate, 0),
                revenue: toFiniteNumber(data.revenue, 0),
                currency: sanitizeString(data.currency || "USD", 16),
                dateRange: data.dateRange || null
            },
            topPages: cleanPages
        }
    } catch (e) {
        return { ok: false, error: "Invalid MCP overview JSON: " + sanitizeString(String(e.message || e),200) }
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
    if (raw.length > MAX_RESPONSE_BYTES) return { ok: false, error: "Response too large" }
    try {
        var data = JSON.parse(raw)
        if (data && data.error) {
            return { ok: false, error: sanitizeString(String(data.error),400) }
        }
        if (!data || !data.summary) return { ok: false, error: "Missing summary in response" }
        var summary = data.summary
        var ts = Array.isArray(data.timeSeries) ? data.timeSeries.slice(0, 1000) : []
        var pages = Array.isArray(data.topPages) ? data.topPages.slice(0, 100) : []
        var refs = Array.isArray(data.topReferrers) ? data.topReferrers.slice(0, 100) : []
        // Sanitize timeSeries numbers finite and string lengths
        var cleanTs = []
        for (var i=0;i<ts.length;i++) {
            var t = ts[i]
            if (!t || typeof t !== "object") continue
            cleanTs.push({
                date: sanitizeString(t.date || "", 32),
                pageviews: toFiniteNumber(t.pageviews, 0),
                visitors: toFiniteNumber(t.visitors ?? t.pageviews, 0),
                sessions: toFiniteNumber(t.sessions, 0),
                revenue: toFiniteNumber(t.revenue, 0)
            })
        }
        var cleanPages = []
        for (var j=0;j<pages.length;j++) {
            var pp = pages[j]
            if (!pp || typeof pp !== "object") continue
            cleanPages.push({
                pathname: sanitizeString(pp.pathname || "/", 256),
                views: toFiniteNumber(pp.views ?? pp.pageviews ?? pp.value, 0),
                pageviews: toFiniteNumber(pp.pageviews, 0),
                value: toFiniteNumber(pp.value, 0)
            })
        }
        var cleanRefs = []
        for (var k=0;k<refs.length;k++) {
            var r = refs[k]
            if (!r || typeof r !== "object") continue
            cleanRefs.push({
                referrer: sanitizeString(r.referrer || "Direct", 256),
                sessions: toFiniteNumber(r.sessions, 0),
                count: toFiniteNumber(r.count ?? r.sessions, 0)
            })
        }
        return {
            ok: true,
            summary: {
                pageviews: toFiniteNumber(summary.pageviews, 0),
                sessions: toFiniteNumber(summary.sessions, 0),
                visitors: toFiniteNumber(summary.visitors, 0),
                bounceRate: toFiniteNumber(summary.bounceRate, 0),
                dateRange: summary.dateRange || null
            },
            timeSeries: cleanTs,
            topPages: cleanPages,
            topReferrers: cleanRefs
        }
    } catch (e) {
        return { ok: false, error: "Invalid JSON: " + sanitizeString(String(e.message || e),200) }
    }
}

function summaryLabel(stats) {
    if (!stats || !stats.ok) return "—"
    return formatNumber(stats.summary.visitors) + " visitors · " + formatNumber(stats.summary.pageviews) + " views"
}

function barLabelForSite(site, stats) {
    var name = site ? sanitizeDomain(site.name) : "OpenWebTrack"
    if (!stats) return name
    if (!stats.ok) return name + " · error"
    return name + " · " + formatNumber(stats.summary.visitors) + " · " + formatNumber(stats.summary.pageviews)
}

function maxTimeSeriesValue(ts) {
    var max = 0
    for (var i = 0; i < (ts || []).length; i++) {
        var v = toFiniteNumber(ts[i].pageviews, 0)
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
        validateInstanceUrl: validateInstanceUrl,
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
