/** @file Background page: builds the navigation tree in IndexedDB and detects pivots (copied text later searched). */

/** How far back (15 minutes) to look for a matching selection. */
const PIVOT_WINDOW_MS = 15 * 60 * 1000;
const MIN_PIVOT_TEXT_LEN = 3;
/** Clips older than this (1 hour) are pruned from the buffer. */
const CLIP_RETENTION_MS = 60 * 60 * 1000;
/** In-memory: last node created for each tab (tabId -> nodeId). */
const tabLastNode = new Map();
/** In-memory: pending parent for freshly opened tabs (tabId -> parent nodeId, from the opener). */
const pendingParent = new Map();
/** Last recorded URL per tab (tabId -> URL); guards against exact repeats. */
const tabLastUrl = new Map();
/** Last search per tab (tabId -> {domain, query, timestamp}); guards against repeated searches. */
const tabLastSearch = new Map();
/** SPA search pages can fire several history updates per single search; repeats within this window are ignored. */
const SEARCH_DEDUPE_WINDOW_MS = 12000;
/** Same-URL reload/redirect chains (Cloudflare-style challenge pages) within this window count as one visit. */
const REVISIT_DEBOUNCE_MS = 20000;

let paused = false;
browser.storage.local.get("paused").then((r) => {
  paused = !!r.paused;
});
browser.storage.onChanged.addListener((changes) => {
  if (changes.paused) paused = !!changes.paused.newValue;
});

// ---------- Detection lists (config/*.json, editable; small built-in fallback if loading fails) ----------

const FALLBACK_ENGINES = [
  { name: "Google", host: "(^|\\.)google\\.[a-z.]+$", path: "^/search", param: "q" },
  { name: "Bing", host: "(^|\\.)bing\\.com$", path: "^/search", param: "q" },
  { name: "DuckDuckGo", host: "(^|\\.)duckduckgo\\.com$", path: ".*", param: "q" },
];
const FALLBACK_TRANSLATORS = [
  { name: "DeepL", host: "(^|\\.)deepl\\.com$" },
  { name: "Google Translate", host: "(^|\\.)translate\\.google\\.[a-z.]+$" },
];

let compiledEngines = [];
let compiledTranslators = [];

function compileEngine(e) {
  return {
    name: e.name,
    host: new RegExp(e.host, "i"),
    path: new RegExp(e.path || ".*", "i"),
    param: e.param,
  };
}
function compileTranslator(t) {
  return { name: t.name, host: new RegExp(t.host, "i"), pathPrefix: t.pathPrefix || null };
}

async function loadJsonConfig(filename) {
  const url = browser.runtime.getURL(filename);
  const res = await fetch(url);
  return res.json();
}

const configReady = (async () => {
  try {
    const data = await loadJsonConfig("config/search-engines.json");
    compiledEngines = (data.engines || []).map(compileEngine);
  } catch (e) {
    console.warn("Pivot Tracker: could not load config/search-engines.json, using fallback list", e);
    compiledEngines = FALLBACK_ENGINES.map(compileEngine);
  }
  try {
    const data = await loadJsonConfig("config/translators.json");
    compiledTranslators = (data.translators || []).map(compileTranslator);
  } catch (e) {
    console.warn("Pivot Tracker: could not load config/translators.json, using fallback list", e);
    compiledTranslators = FALLBACK_TRANSLATORS.map(compileTranslator);
  }
})();

function isTranslatorSite(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return false;
  }
  return compiledTranslators.some(
    (t) => t.host.test(u.hostname) && (!t.pathPrefix || u.pathname.startsWith(t.pathPrefix))
  );
}

function extractSearchQuery(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return null;
  }
  for (const engine of compiledEngines) {
    if (engine.host.test(u.hostname) && engine.path.test(u.pathname)) {
      const q = u.searchParams.get(engine.param);
      if (q) return q;
    }
  }
  return null;
}

function normalizeText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

async function addPivotEdgeIfMissing(sourceNodeId, targetNodeId, label, timestamp) {
  const edges = await PivotDB.getAllEdges();
  const normalizedLabel = normalizeText(label);
  const exists = edges.some(
    (edge) =>
      edge.type === "pivot" &&
      edge.source === sourceNodeId &&
      edge.target === targetNodeId &&
      normalizeText(edge.label || "") === normalizedLabel
  );
  if (exists) return false;

  await PivotDB.addEdge({
    source: sourceNodeId,
    target: targetNodeId,
    type: "pivot",
    label,
    timestamp,
  });
  return true;
}

async function checkForPivot(searchNodeId, query, timestamp) {
  const since = timestamp - PIVOT_WINDOW_MS;
  const clips = await PivotDB.getRecentClips(since);
  const normalizedQuery = normalizeText(query);
  // Clips aren't consumed by a pivot: one copied name can be searched on Google, then pasted into Wikipedia.
  let best = null;
  for (const c of clips) {
    if (c.usedForTranslationAt) continue;
    if (c.nodeId === searchNodeId) continue;
    const text = normalizeText(c.text);
    if (text.length < MIN_PIVOT_TEXT_LEN) continue;
    if (sameText(normalizedQuery, text)) {
      if (!best || text.length > best.text.length || c.timestamp > best.timestamp) {
        best = { ...c, text };
      }
    }
  }
  if (best && best.nodeId !== searchNodeId) {
    await addPivotEdgeIfMissing(best.nodeId, searchNodeId, best.text, timestamp);
    return true;
  }
  return false;
}

/** Matches copied text against the URL path only; query/fragment often hold UI or session state. */
function urlPathContainsText(urlStr, text) {
  const needle = normalizeText(text).toLowerCase();
  if (needle.length < MIN_PIVOT_TEXT_LEN) return false;

  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return false;
  }

  let path = u.pathname || "";
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the original pathname if a site uses malformed percent-encoding.
  }
  path = normalizeText(path).toLowerCase();

  // Match the copied text as a path substring, or a copied full URL whose path appears in the destination.
  if (path.includes(needle)) return true;

  try {
    const copiedUrl = new URL(normalizeText(text));
    let copiedPath = copiedUrl.pathname || "";
    try {
      copiedPath = decodeURIComponent(copiedPath);
    } catch {}
    copiedPath = normalizeText(copiedPath).toLowerCase();
    if (copiedPath.length >= MIN_PIVOT_TEXT_LEN && path.includes(copiedPath)) return true;
  } catch {
    // Copied text isn't a URL; the direct pathname test above already covered it.
  }

  return false;
}

async function checkForUrlPathPivot(targetNodeId, url, timestamp) {
  const since = timestamp - PIVOT_WINDOW_MS;
  const clips = await PivotDB.getRecentClips(since);
  const eligible = clips
    .filter((clip) => !clip.usedForTranslationAt)
    .filter((clip) => clip.nodeId !== targetNodeId)
    .sort((a, b) => b.timestamp - a.timestamp);

  // Uses only the newest clip, and isn't one-shot: the same text can pivot to several destinations.
  const latest = eligible[0];
  const best = latest && urlPathContainsText(url, latest.text)
    ? { ...latest, text: normalizeText(latest.text) }
    : null;

  if (!best) {
    return false;
  }

  await addPivotEdgeIfMissing(best.nodeId, targetNodeId, best.text, timestamp);
  return true;
}

/**
 * Clips are cut to 500 chars, so accept a prefix match once both sides are long enough (>=400) to rule out
 * chance.
 */
function sameText(a, b) {
  if (a === b) return true;
  return Math.min(a.length, b.length) >= 400 && (a.startsWith(b) || b.startsWith(a));
}

/**
 * Handles a paste into an open SPA translator: it causes no navigation, so link it and reuse the tab's tracked
 * translator node.
 */
async function handleTranslationPaste(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null || !msg.url) return;
  await initializationReady;
  if (!isTranslatorSite(msg.url)) return;

  const currentNodeId = tabLastNode.get(tabId);
  if (currentNodeId == null) {
    return;
  }

  const text = normalizeText(msg.text || "");
  if (text.length < MIN_PIVOT_TEXT_LEN) return;

  const now = Date.now();
  const clips = await PivotDB.getRecentClips(now - PIVOT_WINDOW_MS);

  // Newest unused clip matching the pasted text. Only a paste creates a translation edge, never a translator visit.
  const candidates = clips
    .filter((clip) => !clip.usedForTranslationAt)
    .filter((clip) => sameText(normalizeText(clip.text), text))
    .sort((a, b) => b.timestamp - a.timestamp);

  let match = null;
  for (const clip of candidates) {
    if (clip.nodeId === currentNodeId) continue;
    const srcNode = await PivotDB.getNode(clip.nodeId);
    if (!srcNode || srcNode.siteType === "translator") continue;
    match = clip;
    break;
  }

  if (!match) {
    return;
  }

  let targetNode = await PivotDB.getNode(currentNodeId);
  let msgHost = "";
  try {
    msgHost = new URL(msg.url).hostname.toLowerCase();
  } catch {
    /* validated above */
  }

  // Prefer this tab's tracked node: DeepL changes ?tab= without a real page change.
  if (
    !targetNode ||
    targetNode.siteType !== "translator" ||
    !msgHost ||
    (() => {
      try { return new URL(targetNode.url).hostname.toLowerCase() !== msgHost; }
      catch { return true; }
    })()
  ) {
    targetNode = await PivotDB.findNodeByUrl(msg.url);
  }

  if (!targetNode) {
    let title = "";
    try {
      const tab = await browser.tabs.get(tabId);
      title = tab.title || "";
    } catch {
      /* tab may already be gone */
    }

    const targetNodeId = await PivotDB.addNode({
      url: msg.url,
      urlKey: normalizeUrlKey(msg.url),
      title,
      domain: msgHost,
      timestamp: now,
      tabId,
      transitionType: "translation",
      siteType: "translator",
    });
    targetNode = await PivotDB.getNode(targetNodeId);
  } else if (targetNode.url !== msg.url) {
    // Keep the stable urlKey/node identity, but remember the latest SPA URL.
    await PivotDB.updateNode(targetNode.id, { url: msg.url, tabId });
  }

  const targetNodeId = targetNode.id;

  await PivotDB.addEdge({
    source: match.nodeId,
    target: targetNodeId,
    type: "translation",
    label: text,
    timestamp: now,
    clipId: match.id,
  });

  await PivotDB.updateClip(match.id, { usedForTranslationAt: now });
  tabLastNode.set(tabId, targetNodeId);

}

async function recordNavigation(details, { historyState = false } = {}) {
  if (paused) return;
  if (details.frameId !== 0) return; // main frame only
  if (!/^https?:/.test(details.url)) return;
  await initializationReady;

  // Guard 1: SPAs often fire repeated updates for the same URL; skip them.
  if (tabLastUrl.get(details.tabId) === details.url) return;
  tabLastUrl.set(details.tabId, details.url);

  let domain = "";
  try {
    domain = new URL(details.url).hostname;
  } catch {
    /* ignore */
  }

  const timestamp = Date.now();

  const isTranslator = isTranslatorSite(details.url);
  const searchQueryPreview = extractSearchQuery(details.url);

  // Translator SPA state changes (e.g. DeepL ?tab=) aren't new pages: keep the current node. Only a paste makes a translation.
  if (historyState && isTranslator && tabLastNode.has(details.tabId)) {
    const currentNode = await PivotDB.getNode(tabLastNode.get(details.tabId));
    if (currentNode && currentNode.siteType === "translator") {
      let currentUrl;
      let nextUrl;
      try {
        currentUrl = new URL(currentNode.url);
        nextUrl = new URL(details.url);
      } catch {
        currentUrl = null;
        nextUrl = null;
      }
      if (currentUrl && nextUrl && currentUrl.hostname === nextUrl.hostname) {
        return;
      }
    }
  }

  // Guard 2: search SPAs (DuckDuckGo) fire several history updates per search; dedupe by (domain, query) in a short window.
  if (searchQueryPreview) {
    const prev = tabLastSearch.get(details.tabId);
    if (
      prev &&
      prev.domain === domain &&
      prev.query === searchQueryPreview &&
      timestamp - prev.timestamp < SEARCH_DEDUPE_WINDOW_MS
    ) {
      tabLastSearch.set(details.tabId, { domain, query: searchQueryPreview, timestamp });
      return;
    }
    tabLastSearch.set(details.tabId, { domain, query: searchQueryPreview, timestamp });
  }

  let parentId = null;

  // Typing a URL/search or picking a bookmark starts a fresh root, like "Start here", instead of chaining on.
  const fromAddressBar =
    Array.isArray(details.transitionQualifiers) &&
    details.transitionQualifiers.includes("from_address_bar");

  if (!fromAddressBar && tabLastNode.has(details.tabId)) {
    parentId = tabLastNode.get(details.tabId);
  } else if (!fromAddressBar && pendingParent.has(details.tabId)) {
    parentId = pendingParent.get(details.tabId);
    pendingParent.delete(details.tabId);
  } else if (fromAddressBar) {
    pendingParent.delete(details.tabId);
  }

  const siteType = isTranslator ? "translator" : searchQueryPreview ? "search" : null;

  // Known URL: reuse the card and record a timestamped 'revisit' edge so the detail panel can show visit history.
  const existingNode = await PivotDB.findNodeByUrl(details.url);
  let nodeId;
  let isRevisit = false;
  let skipRevisitEdge = false;
  if (existingNode) {
    nodeId = existingNode.id;
    isRevisit = true;
    // Same-URL reloads/redirects within REVISIT_DEBOUNCE_MS (e.g. Cloudflare challenges) count as one visit.
    const recentEdges = await PivotDB.getEdgesByTarget(nodeId);
    const lastTs = recentEdges.reduce((max, e) => Math.max(max, e.timestamp), existingNode.timestamp);
    if (timestamp - lastTs < REVISIT_DEBOUNCE_MS) {
      skipRevisitEdge = true;
    }
  } else {
    nodeId = await PivotDB.addNode({
      url: details.url,
      urlKey: normalizeUrlKey(details.url),
      title: "",
      domain,
      timestamp,
      tabId: details.tabId,
      transitionType: details.transitionType || "unknown",
      siteType,
    });
  }

  if (parentId != null && !skipRevisitEdge) {
    let edgeType = isRevisit ? "revisit" : "navigation";
    let edgeLabel = "";
    // A clicked link that leaves the parent's website (different registrable domain, not a subdomain) is a pivot,
    // except from search results, where every link is external by nature and stays plain navigation.
    if (!isRevisit && details.transitionType === "link") {
      const parentNode = await PivotDB.getNode(parentId);
      if (
        parentNode &&
        parentNode.siteType !== "search" &&
        parentNode.domain &&
        domain &&
        registrableDomain(parentNode.domain) !== registrableDomain(domain)
      ) {
        edgeType = "pivot";
        edgeLabel = "external link";
      }
    }
    await PivotDB.addEdge({
      source: parentId,
      target: nodeId,
      type: edgeType,
      label: edgeLabel,
      timestamp,
    });
  }

  tabLastNode.set(details.tabId, nodeId);

  // A translator visit never creates a translation (only a paste does), so SPA URL changes can't consume a clip.
  if (searchQueryPreview) {
    checkForPivot(nodeId, searchQueryPreview, timestamp);
  } else {
    // A copied value appearing in the destination's URL path is a deterministic pivot (e.g. a copied identifier).
    checkForUrlPathPivot(nodeId, details.url, timestamp);
  }
}

async function migrateLegacyTranslationNodes() {
  const nodes = await PivotDB.getAllNodes();
  const edges = await PivotDB.getAllEdges();
  const legacy = nodes.filter((node) => {
    if (node.siteType !== "translator") return false;
    if (!/(^|\.)deepl\.com$/i.test(node.domain || "")) return false;
    return typeof node.urlKey === "string" && node.urlKey.includes("#translation-");
  });

  for (const oldNode of legacy) {
    const canonicalKey = normalizeUrlKey(oldNode.url);
    const canonical = nodes.find(
      (node) => node.id !== oldNode.id && node.siteType === "translator" && node.urlKey === canonicalKey
    );
    if (!canonical) continue;

    for (const edge of edges.filter((e) => e.source === oldNode.id || e.target === oldNode.id)) {
      const mappedSource = edge.source === oldNode.id ? canonical.id : edge.source;
      const mappedTarget = edge.target === oldNode.id ? canonical.id : edge.target;

      if (mappedSource === mappedTarget) {
        await PivotDB.deleteEdge(edge.id);
        continue;
      }

      const duplicate = edges.some((other) =>
        other.id !== edge.id &&
        other.source === mappedSource &&
        other.target === mappedTarget &&
        other.type === edge.type &&
        other.label === edge.label &&
        (other.clipId || null) === (edge.clipId || null)
      );
      if (duplicate) await PivotDB.deleteEdge(edge.id);
      else await PivotDB.updateEdge(edge.id, { source: mappedSource, target: mappedTarget });
    }

    for (const [tabId, nodeId] of tabLastNode.entries()) {
      if (nodeId === oldNode.id) tabLastNode.set(tabId, canonical.id);
    }
    await PivotDB.deleteNode(oldNode.id);
  }
}

const initializationReady = configReady.then(() => migrateLegacyTranslationNodes()).catch((err) => {
  console.warn("Pivot Tracker: legacy translation migration failed", err);
});

browser.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId != null && tabLastNode.has(tab.openerTabId)) {
    pendingParent.set(tab.id, tabLastNode.get(tab.openerTabId));
  }
});

/** Second-level labels that make a two-letter TLD a public suffix (bbc.co.uk, example.com.au). */
const SECOND_LEVEL_LABELS = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "or", "ne", "go"]);

/**
 * Approximates a hostname's registrable domain without a public-suffix list, so subdomains
 * collapse onto their site: a.b.example.com -> example.com, news.bbc.co.uk -> bbc.co.uk.
 */
function registrableDomain(hostname) {
  const host = (hostname || "").toLowerCase().replace(/\.$/, "");
  if (/^[\d.]+$/.test(host) || host.includes(":")) return host; // IP address
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  if (tld.length === 2 && SECOND_LEVEL_LABELS.has(sld)) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

/** Regular full-page navigations (clicking a link, typing a URL, etc.). */
browser.webNavigation.onCommitted.addListener(recordNavigation);

/** Engines like DuckDuckGo update the URL via history.pushState, which onCommitted never sees; catch those too. */
browser.webNavigation.onHistoryStateUpdated.addListener((details) => recordNavigation(details, { historyState: true }));

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (paused) return;
  if (changeInfo.title && tabLastNode.has(tabId)) {
    PivotDB.updateNode(tabLastNode.get(tabId), { title: changeInfo.title });
  }
  if (changeInfo.favIconUrl && tabLastNode.has(tabId)) {
    PivotDB.updateNode(tabLastNode.get(tabId), { favIconUrl: changeInfo.favIconUrl });
  }
});

/** Readable file name from a download item (path or URL). */
function downloadFileName(item) {
  const raw = item.filename || item.url || "";
  const base = raw.split(/[\\/]/).pop() || raw;
  try {
    return decodeURIComponent(base);
  } catch {
    return base;
  }
}

browser.downloads.onCreated.addListener(async (item) => {
  if (paused) return;
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab) return;
    const nodeId = tabLastNode.get(tab.id);
    if (nodeId == null) return;
    const node = await PivotDB.getNode(nodeId);
    if (!node) return;
    const filename = downloadFileName(item);
    const downloads = Array.isArray(node.downloads) ? node.downloads.slice() : [];
    downloads.push({ filename, timestamp: Date.now() });
    await PivotDB.updateNode(nodeId, { downloads });
  } catch (err) {
    console.warn("Pivot Tracker: could not record download", err);
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  tabLastNode.delete(tabId);
  pendingParent.delete(tabId);
  tabLastUrl.delete(tabId);
  tabLastSearch.delete(tabId);
});

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "startHere") {
    // Handled even while paused: "Start here" resumes tracking, ensures the page has a card, and makes it a new root.
    return handleStartHere(msg);
  }
  if (paused) return;
  if (msg.type === "translationPaste" && sender.tab) {
    return handleTranslationPaste(msg, sender);
  }
  if (msg.type === "selection" && sender.tab) {
    const nodeId = tabLastNode.get(sender.tab.id);
    if (nodeId == null) {
      return;
    }
    const text = (msg.text || "").trim().slice(0, 500);
    if (text.length < MIN_PIVOT_TEXT_LEN) return;
    PivotDB.addClip({
      text,
      nodeId,
      tabId: sender.tab.id,
      url: msg.url,
      timestamp: Date.now(),
    });
  }
});

async function handleStartHere(msg) {
  try {
    const tabId = msg.tabId;
    const url = msg.url;
    if (!url || !/^https?:/.test(url)) {
      return { ok: false, error: "unsupported-url" };
    }
    if (paused) {
      paused = false;
      await browser.storage.local.set({ paused: false });
    }
    await configReady;

    let domain = "";
    try {
      domain = new URL(url).hostname;
    } catch {
      /* ignore */
    }

    const existing = await PivotDB.findNodeByUrl(url);
    let nodeId;
    let created = false;
    if (existing) {
      nodeId = existing.id;
    } else {
      nodeId = await PivotDB.addNode({
        url,
        urlKey: normalizeUrlKey(url),
        title: msg.title || "",
        domain,
        timestamp: Date.now(),
        tabId,
        transitionType: "start-here",
        siteType: null,
      });
      created = true;
    }

    // Anchor this tab's future navigations under this node, dropping any inherited parent.
    tabLastNode.set(tabId, nodeId);
    tabLastUrl.set(tabId, url);
    pendingParent.delete(tabId);

    return { ok: true, nodeId, created };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** Periodically prunes the short-lived clipboard buffer. */
setInterval(() => {
  PivotDB.pruneClips(Date.now() - CLIP_RETENTION_MS);
}, 5 * 60 * 1000);
