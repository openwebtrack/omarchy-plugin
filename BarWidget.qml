import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model


// BarWidget for OpenWebTrack - shows selected website's visitors/pageviews
// Polls via MCP owt_mcp_... (encrypted with OS machine-id) or fallback /api/v1 owt_...
BarWidget {
  id: root
  moduleName: "openwebtrack.omarchy-plugin"

  // ---- settings from shell.json / manifest — mcpKey stored as enc:... (machine-id)
  readonly property string instanceUrl: String(setting("instanceUrl", "http://localhost:8424"))
  readonly property string mcpKeyEnc: String(setting("mcpKey", ""))
  property string mcpKeyPlain: Model.isEncrypted(mcpKeyEnc) ? "" : mcpKeyEnc
  readonly property string mcpKey: mcpKeyPlain !== "" ? mcpKeyPlain : (Model.isEncrypted(mcpKeyEnc) ? "" : mcpKeyEnc)
  readonly property string sitesJson: String(setting("sitesJson", "[]"))
  readonly property string configuredSelectedId: String(setting("selectedId", ""))
  readonly property string period: Model.normalizePeriod(setting("period", "7d"))
  readonly property string granularity: Model.normalizeGranularity(setting("granularity", "daily"))
  readonly property int refreshIntervalSec: Model.clampInterval(setting("refreshIntervalSec", 300))

  readonly property var sites: Model.parseSites(sitesJson)
  readonly property string effectiveId: Model.effectiveSelectedId(sites, configuredSelectedId)
  readonly property var activeSite: Model.getSiteById(sites, effectiveId)

  // MCP — one key for all sites, no manual Website ID needed
  property var mcpSites: []
  property bool mcpLoading: false
  readonly property bool useMcp: Model.isValidMcpKey(mcpKey)
  readonly property var effectiveSites: useMcp ? mcpSites : sites
  readonly property string effectiveMcpId: useMcp ? Model.effectiveSelectedId(mcpSites, configuredSelectedId) : effectiveId
  readonly property var effectiveActiveSite: useMcp ? Model.getSiteById(mcpSites, effectiveMcpId) : activeSite
  readonly property string displayEffectiveId: useMcp ? effectiveMcpId : effectiveId
  readonly property string displaySiteName: effectiveActiveSite ? effectiveActiveSite.name : (useMcp ? "OpenWebTrack" : "OpenWebTrack")

  onMcpKeyEncChanged: {
    if (Model.isEncrypted(mcpKeyEnc)) {
      if (mcpKeyPlain === "") {
        var cmd = Model.buildDecryptCommand(mcpKeyEnc)
        cryptoDec.command = cmd
        cryptoDec.running = true
      }
    } else {
      if (mcpKeyPlain !== mcpKeyEnc) mcpKeyPlain = mcpKeyEnc
    }
  }

  Process {
    id: cryptoDec
    stdout: StdioCollector { id: decOut; waitForEnd: true }
    stderr: StdioCollector { id: decErr; waitForEnd: true }
    onExited: function(code) {
      if (code !== 0) { console.log("Bar decrypt failed", String(decErr.text||decOut.text).slice(0,80)); return }
      var plain = String(decOut.text || "").trim()
      if (plain && Model.isValidMcpKey(plain)) {
        root.mcpKeyPlain = plain
        if (root.mcpSites.length === 0) Qt.callLater(root.fetchMcpSites)
      }
    }
  }

  // ---- live stats (from v1)
  property var lastStats: null   // {ok, summary, ...} or null
  property string lastError: ""
  property string lastUpdatedLabel: ""
  property bool loading: false

  // Bar text — logo-only pill shows visitor count, tooltip has details. MCP needs no manual ID.
  readonly property string barText: {
    var site = effectiveActiveSite
    var es = effectiveSites
    if (useMcp && mcpLoading && es.length === 0) return "…"
    if (es.length === 0) return useMcp ? "OpenWebTrack — no sites" : "OpenWebTrack — no sites"
    if (!site) return "OpenWebTrack — select site"
    if (loading && !lastStats) return site.name + " · …"
    if (lastError !== "" && (!lastStats || !lastStats.ok)) return site.name + " · error"
    if (!lastStats || !lastStats.ok) return site.name + " · —"
    var s = lastStats.summary
    return site.name + "  " + Model.formatNumber(s.visitors) + " / " + Model.formatNumber(s.pageviews)
  }

  readonly property string verticalText: {
    var site = effectiveActiveSite
    var es = effectiveSites
    if (es.length === 0) return "—"
    if (!site) return "?"
    if (loading && !lastStats) return "…"
    if (!lastStats || !lastStats.ok) return "—"
    return Model.formatNumber(lastStats.summary.visitors)
  }

  readonly property real iconSize: vertical ? Math.round(Style.bar.iconSlot * 0.72) : Style.space(18)

  readonly property string barTooltip: {
    var site = effectiveActiveSite
    var es = effectiveSites
    if (useMcp && es.length === 0 && mcpLoading) return "Loading websites via MCP…"
    if (es.length === 0) return useMcp ? "Configure MCP key owt_mcp_... in panel" : "Configure sitesJson in panel or shell.json"
    if (!site) return "Select a website in the panel"
    if (loading && !lastStats) return "Loading " + site.name + " …"
    if (lastError !== "") return lastError
    if (!lastStats || !lastStats.ok) return "No data yet — click to open panel"
    var s = lastStats.summary
    return site.name + "\n" +
           "Visitors: " + s.visitors + "  Pageviews: " + s.pageviews + "  Sessions: " + s.sessions + "\n" +
           (s.revenue !== undefined ? "Revenue: " + s.revenue + " " + (s.currency||"") + "\n" : "") +
           "Bounce: " + s.bounceRate + "%\n" +
           (lastUpdatedLabel ? "Updated " + lastUpdatedLabel : "")
  }

  function fetchMcpSites() {
    if (!Model.isValidMcpKey(mcpKey)) { lastError = "Configure MCP key owt_mcp_... in panel"; return }
    var cmd = Model.buildMcpCurlCommand(instanceUrl, mcpKey, "list_websites", {})
    if (!cmd) { lastError = "Failed to build MCP command"; return }
    mcpListFetcher.command = cmd
    mcpListFetcher.running = true
    mcpLoading = true
    lastError = ""
  }

  function refresh() {
    if (useMcp) {
      if (mcpSites.length === 0) { fetchMcpSites(); return }
      if (!effectiveActiveSite) { lastError = "No website selected"; return }
      var range = Model.periodToDateRange(period)
      var cmd = Model.buildMcpCurlCommand(instanceUrl, mcpKey, "analytics_overview",
        { websiteId: effectiveActiveSite.id, startDate: range.startIso, endDate: range.endIso })
      if (!cmd) { lastError = "Failed to build MCP command"; return }
      mcpFetcher.command = cmd
      mcpFetcher.running = true
      loading = true
      lastError = ""
      return
    }
    if (sites.length === 0) { lastError = "No websites configured"; return }
    if (!activeSite) { lastError = "No website selected"; return }
    var key = String(activeSite.apiKey || "").trim()
    if (!Model.isValidApiKey(key)) { lastError = "Invalid API key for " + activeSite.name; return }
    var cmd2 = Model.buildCurlCommand(instanceUrl, activeSite.id, key, period, granularity)
    if (!cmd2) { lastError = "Failed to build v1 URL"; return }
    fetcher.command = cmd2
    fetcher.running = true
    loading = true
  }

  function openDashboard() {
    var base = Model.trimSlash(instanceUrl)
    if (!base) base = "http://localhost:8424"
    var url = base + "/dashboard"
    if (bar) bar.run("xdg-open " + Util.shellQuote(url))
    else Util.execDetached("xdg-open " + Util.shellQuote(url))
  }
  function openSiteDashboard() {
    var siteId = displayEffectiveId
    if (!siteId) return openDashboard()
    var base = Model.trimSlash(instanceUrl)
    var url = base + "/dashboard/" + siteId
    if (bar) bar.run("xdg-open " + Util.shellQuote(url))
    else Util.execDetached("xdg-open " + Util.shellQuote(url))
  }

  // ---- panel plumbing (copied from clock template, adapted)
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  function open() { if (panelLoader.item) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function togglePanel() { if (panelLoader.item) panelLoader.item.toggle() }
  function closeForPopoutSwitch() { if (panelLoader.item) panelLoader.item.closeForPopoutSwitch() }
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false
  function injectPanel() {
    var t = panelLoader.item
    if (!t) return
    if ("bar" in t) t.bar = root.bar
    if ("settings" in t) t.settings = root.settings
    if ("anchorItem" in t) t.anchorItem = button
    if ("hostWidget" in t) t.hostWidget = root
    if ("mcpSites" in t) t.mcpSites = root.mcpSites
  }

  onMcpSitesChanged: {
    if (panelLoader.item && "mcpSites" in panelLoader.item) panelLoader.item.mcpSites = mcpSites
  }
  readonly property real openPanelIndicatorWidth: Math.max(Style.space(10), Math.round(Style.bar.iconSlot * 0.55))
  readonly property real openPanelIndicatorHeight: Math.max(Style.space(10), Math.round(Style.bar.iconSlot * 0.55))

  // Logo-only: icon centered in a square slot like other icon widgets.
  implicitWidth: barSize
  implicitHeight: barSize

  onBarChanged: injectPanel()
  onSettingsChanged: {
    injectPanel()
    fetchDebounce.restart()
  }

  onMcpKeyChanged: {
    if (Model.isValidMcpKey(mcpKey) && mcpSites.length === 0) Qt.callLater(fetchMcpSites)
  }

  onEffectiveIdChanged: {
    if (useMcp) return
    lastStats = null
    lastError = ""
    lastUpdatedLabel = ""
    if (effectiveId) Qt.callLater(refresh)
  }

  onEffectiveMcpIdChanged: {
    if (!useMcp) return
    lastStats = null
    lastError = ""
    lastUpdatedLabel = ""
    if (effectiveMcpId) Qt.callLater(refresh)
  }

  onEffectiveSitesChanged: {
    if (useMcp && mcpSites.length > 0 && effectiveMcpId) Qt.callLater(refresh)
  }

  Component.onCompleted: {
    if (useMcp) {
      if (Model.isValidMcpKey(mcpKey)) Qt.callLater(fetchMcpSites)
    } else if (effectiveId) Qt.callLater(refresh)
  }

  Timer {
    id: pollTimer
    interval: Math.max(30000, root.refreshIntervalSec * 1000)
    running: root.displayEffectiveId !== "" && root.effectiveSites.length > 0 && !root.mcpLoading
    repeat: true
    onTriggered: root.refresh()
    onRunningChanged: if (running) interval = Math.max(30000, root.refreshIntervalSec * 1000)
  }

  Timer {
    id: fetchDebounce
    interval: 650
    onTriggered: {
      if (useMcp && mcpSites.length === 0 && Model.isValidMcpKey(mcpKey)) fetchMcpSites()
      else refresh()
    }
  }

Process {
     id: fetcher
     stdout: StdioCollector { id: out; waitForEnd: true }
     stderr: StdioCollector { id: err; waitForEnd: true }
     onExited: function(code) {
       root.loading = false
       if (code !== 0) {
         var msg = String(err.text || out.text || "").trim()
         if (!msg) msg = "curl exited " + code
         root.lastError = msg.slice(0, 220)
         if (panelLoader.item && panelLoader.item.onFetchResult) panelLoader.item.onFetchResult({ ok:false, error: root.lastError })
         return
       }
       // Limit response size to 1 MB to prevent memory exhaustion
       if (out.text.length > 1048576) {
         root.lastError = "Response too large ( > 1 MB )"
         if (panelLoader.item && panelLoader.item.onFetchResult) panelLoader.item.onFetchResult({ ok:false, error: root.lastError })
         return
       }
       var text = String(out.text || "")
       var parsed = Model.parseStatsResponse(text)
       if (!parsed.ok) {
         root.lastError = String(parsed.error || "Parse error").slice(0, 220)
         root.lastStats = parsed
       } else {
         root.lastError = ""
         root.lastStats = parsed
         root.lastUpdatedLabel = Qt.formatDateTime(new Date(), "hh:mm:ss")
       }
       if (panelLoader.item && panelLoader.item.onFetchResult) panelLoader.item.onFetchResult(parsed)
     }
   }

  Process {
    id: mcpListFetcher
    stdout: StdioCollector { id: mcpListOut; waitForEnd: true }
    stderr: StdioCollector { id: mcpListErr; waitForEnd: true }
    onExited: function(code) {
      root.mcpLoading = false
      if (code !== 0) {
        var msg = String(mcpListErr.text || mcpListOut.text || "").trim() || ("curl exited " + code)
        root.lastError = msg.slice(0,220)
        return
      }
      var parsed = Model.parseMcpListWebsites(String(mcpListOut.text || ""))
      if (!parsed.ok) { root.lastError = String(parsed.error||"MCP error").slice(0,220); return }
      root.mcpSites = parsed.sites
      root.lastError = ""
      if (root.effectiveActiveSite) Qt.callLater(refresh)
      // sync to panel if open
      if (panelLoader.item && "mcpSites" in panelLoader.item) panelLoader.item.mcpSites = parsed.sites
    }
  }

  Process {
    id: mcpFetcher
    stdout: StdioCollector { id: mcpOut; waitForEnd: true }
    stderr: StdioCollector { id: mcpErr; waitForEnd: true }
    onExited: function(code) {
      root.loading = false
      if (code !== 0) {
        var msg = String(mcpErr.text || mcpOut.text || "").trim() || ("curl exited " + code)
        root.lastError = msg.slice(0,220)
        if (panelLoader.item && panelLoader.item.onFetchResult) panelLoader.item.onFetchResult({ ok:false, error: root.lastError })
        return
      }
      var parsed = Model.parseMcpAnalyticsOverview(String(mcpOut.text || ""))
      if (!parsed.ok) {
        root.lastError = String(parsed.error||"Parse error").slice(0,220)
        var fail = { ok:false, error: root.lastError }
        root.lastStats = fail
        if (panelLoader.item && panelLoader.item.onFetchResult) panelLoader.item.onFetchResult(fail)
        return
      }
      var mapped = {
        ok: true,
        summary: {
          pageviews: parsed.summary.pageviews,
          sessions: parsed.summary.sessions,
          visitors: parsed.summary.visitors,
          bounceRate: parsed.summary.bounceRate || 0,
          revenue: parsed.summary.revenue || 0,
          currency: parsed.summary.currency || "USD",
          dateRange: parsed.summary.dateRange || null
        },
        topPages: parsed.topPages || [],
        topReferrers: [],
        timeSeries: [],
        raw: parsed.raw
      }
      root.lastError = ""
      root.lastStats = mapped
      root.lastUpdatedLabel = Qt.formatDateTime(new Date(), "hh:mm:ss")
      if (panelLoader.item && panelLoader.item.onFetchResult) panelLoader.item.onFetchResult(mapped)
    }
  }

  // Keep panel in sync when hostWidget settings change (website switch)
  Connections {
    target: panelLoader.item
    ignoreUnknownSignals: true
    function onRequestRefresh() { root.refresh() }
    function onRequestSwitchSite(newId) {
      var es = root.effectiveSites
      var site = Model.getSiteById(es, newId)
      if (!site) site = Model.getSiteById(root.sites, newId)
      if (!site) site = Model.getSiteById(root.mcpSites, newId)
      if (!site) return
      var entry = { id: root.moduleName }
      for (var k in root.settings) if (k !== "id") entry[k] = root.settings[k]
      entry.selectedId = site.id
      root.settings = entry
      if (root.bar && root.bar.shell && typeof root.bar.shell.updateEntryInline === "function")
        root.bar.shell.updateEntryInline(root.moduleName, entry)
    }
  }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: { root.injectPanel(); Qt.callLater(root.injectPanel) }
  }

  IpcHandler {
    target: "openwebtrack.omarchy-plugin"
    function refresh(): void { root.broadcast("refresh") }
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.togglePanel() }
    function fetch(): void { root.refresh() }
  }

  // Background + click handling. Text is rendered by contentRow so the
  // icon can sit beside it; setting labelVisible false keeps WidgetButton
  // from painting its own Text. Tooltip is on the button so the whole
  // pill (icon + label) shows the stats on hover.
  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: ""
    labelVisible: false
    hasVisualContent: true
    tooltipText: root.barTooltip
    horizontalMargin: 10
    verticalPadding: 8.75
    onPressed: function(b) {
      if (b === Qt.RightButton) {
        root.openDashboard()
      } else {
        root.togglePanel()
      }
    }
  }

  // Visible content: logo only (icon.png). Sits on top of the button and
  // lets clicks fall through to the button below (no MouseArea here).
  Item {
    id: contentRow
    anchors.centerIn: parent
    implicitWidth: icon.width
    implicitHeight: icon.height

    Image {
      id: icon
      source: Qt.resolvedUrl("icon.png")
      width: root.iconSize
      height: root.iconSize
      sourceSize.width: width * 2
      sourceSize.height: height * 2
      fillMode: Image.PreserveAspectFit
      smooth: true
      mipmap: true
      anchors.centerIn: parent
      opacity: root.effectiveSites.length === 0 || !root.effectiveActiveSite ? 0.55 : 1.0
    }
  }


}
