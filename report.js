/** @file Full browsing log: every search and every other browsing session as a tree, saved as a PDF or Markdown file. */

/** Project page shown at the top of the report (page, PDF and Markdown); replace with the real repository. */
const REPO_URL = "https://github.com/Hyldem0er/Urd";

/** List searches newest first instead of oldest first. */
const NEWEST_FIRST = false;

/** Used only if config/search-engines.json cannot be loaded; mirrors the fallback in background.js. */
const FALLBACK_ENGINES = [
  { name: "Google", host: "(^|\\.)google\\.[a-z.]+$", path: "^/search", param: "q" },
  { name: "Bing", host: "(^|\\.)bing\\.com$", path: "^/search", param: "q" },
  { name: "DuckDuckGo", host: "(^|\\.)duckduckgo\\.com$", path: ".*", param: "q" },
];

/** Edge types that mean "this page was reached from that one" (revisits are shown as references only). */
const CHILD_EDGE_TYPES = new Set(["navigation", "pivot", "translation", "manual"]);

/** Characters per printed row (prefix included); small enough to fit A4 in any common monospace font. */
const COLS = 96;

const pad2 = (n) => String(n).padStart(2, "0");

/** dd/mm/yyyy in UTC. */
function fmtDate(ts) {
  const d = new Date(ts || 0);
  return `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

/** hh:mm:ss in UTC. */
function fmtTime(ts) {
  const d = new Date(ts || 0);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** "dd/mm/yyyy hh:mm:ss UTC", the stamp printed after each result. */
const fmtStamp = (ts) => `${fmtDate(ts)} ${fmtTime(ts)} UTC`;

/** Shortens long free text (copied snippets can be 500 characters). */
function clip(text, max = 80) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** Loads the search-engine list the background page uses, compiled to regular expressions. */
async function loadEngines() {
  let list = FALLBACK_ENGINES;
  try {
    const res = await fetch(browser.runtime.getURL("config/search-engines.json"));
    const cfg = await res.json();
    if (Array.isArray(cfg.engines) && cfg.engines.length) list = cfg.engines;
  } catch {
    /* keep the fallback list */
  }
  return list.map((e) => ({ name: e.name, host: new RegExp(e.host, "i"), path: new RegExp(e.path, "i"), param: e.param }));
}

/** Returns { query, engine } when the card is a search results page, otherwise null. */
function searchInfo(node, engines) {
  let u = null;
  try {
    u = new URL(node.url);
  } catch {
    /* not a URL (manual lead) */
  }
  if (u) {
    for (const e of engines) {
      if (e.host.test(u.hostname) && e.path.test(u.pathname)) {
        const q = u.searchParams.get(e.param);
        if (q) return { query: q, engine: e.name };
      }
    }
  }
  if (node.siteType === "search") return { query: "(unknown)", engine: node.domain || "unknown" };
  return null;
}

/** Short tag describing how a page was reached when it wasn't a plain navigation. */
function edgeNote(e) {
  const label = clip(e.label);
  if (e.type === "pivot") {
    if (!label) return "[pivot]";
    return label === "external link" || label === "link" ? "[external link]" : `[pivot: "${label}"]`;
  }
  if (e.type === "translation") return label ? `[translation: "${label}"]` : "[translation]";
  if (e.type === "manual") return label ? `[manual link: "${label}"]` : "[manual link]";
  if (e.type === "revisit") return "[revisit]";
  return "";
}

/** Merges consecutive characters of the same source part back into { t, text, href? } segments. */
function regroup(chars, parts) {
  const out = [];
  for (const c of chars) {
    const last = out[out.length - 1];
    if (last && last.pi === c.pi) last.text += c.ch;
    else out.push({ pi: c.pi, t: parts[c.pi].t, text: c.ch, href: parts[c.pi].href });
  }
  return out.map(({ t, text, href }) => (href ? { t, text, href } : { t, text }));
}

/**
 * Wraps one logical line to COLS columns. The first row starts with `prefix`; continuation rows start
 * with `cont`, so the tree's vertical bars keep running down a wrapped line, as in a terminal.
 * Returns [{ prefix, parts }].
 */
function wrapRows(prefix, cont, parts, cols = COLS) {
  const chars = [];
  parts.forEach((p, pi) => {
    for (const ch of p.text) chars.push({ ch, pi });
  });
  const rows = [];
  let pos = 0;
  let first = true;
  while (first || pos < chars.length) {
    const pre = first ? prefix : cont;
    const room = Math.max(20, cols - pre.length);
    let end = Math.min(pos + room, chars.length);
    if (end < chars.length) {
      // Prefer breaking at a space, then after / ? & =, then after - _ . , ; :, else cut hard.
      let space = -1;
      let strong = -1;
      let weak = -1;
      for (let i = end; i > pos + room * 0.4; i--) {
        const c = chars[i - 1].ch;
        if (c === " " || chars[i].ch === " ") {
          space = i;
          break;
        }
        if (strong < 0 && "/?&=".includes(c)) strong = i;
        if (weak < 0 && "-_.,;:".includes(c)) weak = i;
      }
      end = space > 0 ? space : strong > 0 ? strong : weak > 0 ? weak : end;
    }
    const seg = chars.slice(pos, end);
    pos = end;
    while (pos < chars.length && chars[pos].ch === " ") pos++;
    while (seg.length && seg[seg.length - 1].ch === " ") seg.pop();
    rows.push({ prefix: pre, parts: regroup(seg, parts) });
    first = false;
  }
  return rows;
}

/**
 * Flattens a tree of { parts, children } into groups of wrapped rows drawn like the `tree` command
 * (├── └── │). One group is one logical line, so a page break can be kept from splitting it.
 */
function treeRows(items, base = "", cols = COLS) {
  const groups = [];
  items.forEach((item, i) => {
    const last = i === items.length - 1;
    const cont = base + (last ? "    " : "│   ");
    groups.push(wrapRows(base + (last ? "└── " : "├── "), cont, item.parts, cols));
    groups.push(...treeRows(item.children, cont, cols));
  });
  return groups;
}

/** The header line followed by the tree, as groups of rows wrapped to `cols` (Infinity = no wrapping). */
function entryGroups(entry, cols = COLS) {
  return [wrapRows("", "", entry.headParts, cols), ...treeRows(entry.items, "", cols)];
}

/**
 * Builds the full log as plain data, so every card is in it: one entry per search, plus one per browsing
 * session that did not start from a search (a typed URL, "Start here", a lead...). Entries are sorted by
 * time and have header parts and a tree of { parts: [{ t: "text" | "note" | "dim" | "link", text, href? }], children }.
 * A page reached from several places is expanded once; later mentions point back to it. A search found
 * inside another tree is only referenced there, because it has its own entry.
 */
function buildLog(nodes, edges, engines) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const info = new Map();
  for (const n of nodes) {
    const i = searchInfo(n, engines);
    if (i) info.set(n.id, i);
  }

  const children = new Map(); // source id -> edges, oldest first
  const hasParent = new Set(); // cards reached from another card
  const repeats = new Map(); // card id -> timestamps of later visits
  const ordered = edges.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0) || a.id - b.id);
  for (const e of ordered) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    if (e.type === "revisit") {
      if (!repeats.has(e.target)) repeats.set(e.target, []);
      repeats.get(e.target).push(e.timestamp);
      if (e.source !== e.target) {
        if (!children.has(e.source)) children.set(e.source, []);
        children.get(e.source).push(e); // shown under the source as a reference, never expanded
      }
    } else if (CHILD_EDGE_TYPES.has(e.type) && e.source !== e.target) {
      if (!children.has(e.source)) children.set(e.source, []);
      children.get(e.source).push(e);
      hasParent.add(e.target);
    }
  }

  const byTime = (a, b) => (a.timestamp || 0) - (b.timestamp || 0) || a.id - b.id;
  const expanded = new Set();

  const pageParts = (n, e) => {
    const parts = [];
    const note = edgeNote(e);
    if (note) parts.push({ t: "note", text: note + " " });
    const url = n.url || "";
    const title = (n.title || "").trim();
    if (title && title !== url) parts.push({ t: "text", text: title + " — " });
    parts.push(/^https?:/i.test(url) ? { t: "link", text: url, href: url } : { t: "text", text: url || n.domain || "(no address)" });
    parts.push({ t: "text", text: ` (${fmtStamp(e.timestamp || n.timestamp)})` });
    return parts;
  };

  const walk = (id) => {
    const items = [];
    const seen = new Set();
    const direct = new Set((children.get(id) || []).filter((e) => e.type !== "revisit").map((e) => e.target));
    for (const e of children.get(id) || []) {
      const revisit = e.type === "revisit";
      if (revisit && direct.has(e.target)) continue; // already shown as a normal child of this page
      if (!revisit) {
        if (seen.has(e.target)) continue;
        seen.add(e.target);
      }
      const n = byId.get(e.target);
      if (info.has(n.id)) {
        const i = info.get(n.id);
        const note = edgeNote(e);
        items.push({
          parts: [
            ...(note ? [{ t: "note", text: note + " " }] : []),
            { t: "text", text: `Searched for "${i.query}" on ${i.engine} search engine (${fmtStamp(e.timestamp || n.timestamp)}) ` },
            { t: "dim", text: "— see its own entry" },
          ],
          children: [],
        });
        continue;
      }
      const parts = pageParts(n, e);
      if (revisit) {
        parts.push({ t: "dim", text: " (listed elsewhere)" });
        items.push({ parts, children: [] });
        continue;
      }
      if (expanded.has(n.id)) {
        parts.push({ t: "dim", text: " (listed elsewhere)" });
        items.push({ parts, children: [] });
        continue;
      }
      expanded.add(n.id);
      const item = { parts, children: [] };
      items.push(item);
      item.children = walk(n.id);
    }
    return items;
  };

  const makeEntry = (n) => {
    const searchInf = info.get(n.id);
    const ts = n.timestamp;
    let headParts;
    if (searchInf) {
      const head = `Searched for "${searchInf.query}" on ${searchInf.engine} search engine at ${fmtTime(ts)} UTC on ${fmtDate(ts)}.`;
      headParts = [{ t: "text", text: head }];
    } else {
      expanded.add(n.id);
      const url = n.url || "";
      const title = (n.title || "").trim();
      headParts = [{ t: "text", text: n.manual ? "Added lead " : "Opened " }];
      if (title && title !== url) headParts.push({ t: "text", text: title + " — " });
      headParts.push(/^https?:/i.test(url) ? { t: "link", text: url, href: url } : { t: "text", text: url || n.domain || "(no address)" });
      headParts.push({ t: "text", text: ` at ${fmtTime(ts)} UTC on ${fmtDate(ts)}.` });
    }
    const again = (repeats.get(n.id) || []).map((when) => ({
      parts: [{ t: "dim", text: `${searchInf ? "searched" : "visited"} again (${fmtStamp(when)})` }],
      children: [],
    }));
    return { ts, isSearch: !!searchInf, headParts, items: [...again, ...walk(n.id)] };
  };

  // Every search, and every card nobody linked to, starts an entry; earlier stories claim shared pages first.
  const entries = [];
  for (const n of nodes.slice().sort(byTime)) {
    if (info.has(n.id) || !hasParent.has(n.id)) entries.push(makeEntry(n));
  }
  // Cards only reachable through a cycle would still be missing, so give each of those an entry too.
  for (const n of nodes.slice().sort(byTime)) {
    if (!info.has(n.id) && !expanded.has(n.id)) entries.push(makeEntry(n));
  }
  entries.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  if (NEWEST_FIRST) entries.reverse();
  const searchCount = entries.filter((e) => e.isSearch).length;
  return { entries, searchCount, sessionCount: entries.length - searchCount, pageCount: expanded.size };
}

/** Draws the log into #log. */
function renderLog(log) {
  const root = document.getElementById("log");
  root.textContent = "";
  if (!log.entries.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Nothing recorded yet.";
    root.appendChild(p);
    return;
  }
  const addRow = (block, row) => {
    const div = document.createElement("div");
    div.className = "row";
    if (row.prefix) {
      const tree = document.createElement("span");
      tree.className = "tree";
      tree.textContent = row.prefix;
      div.appendChild(tree);
    }
    for (const part of row.parts) {
      if (part.t === "link") {
        const a = document.createElement("a");
        a.href = part.href;
        a.textContent = part.text;
        div.appendChild(a);
      } else if (part.t === "text") {
        div.appendChild(document.createTextNode(part.text));
      } else {
        const span = document.createElement("span");
        span.className = part.t;
        span.textContent = part.text;
        div.appendChild(span);
      }
    }
    block.appendChild(div);
  };
  for (const entry of log.entries) {
    const section = document.createElement("section");
    section.className = "search";
    entryGroups(entry).forEach((rows, i) => {
      // One block per logical line, so the PDF never splits a page's description across two pages.
      const block = document.createElement("div");
      block.className = i === 0 ? "block head" : "block";
      rows.forEach((row) => addRow(block, row));
      section.appendChild(block);
    });
    root.appendChild(section);
  }
}

/** The report as Markdown: title, repository link, then one fenced tree per search. */
function toMarkdown(log, generated) {
  const out = ["# URD logs", "", `Repository: ${REPO_URL}`, "", generated, ""];
  if (!log.entries.length) out.push("Nothing recorded yet.", "");
  for (const entry of log.entries) {
    const text = entryGroups(entry, Infinity)
      .flat()
      .map((row) => row.prefix + row.parts.map((p) => p.text).join(""))
      .join("\n");
    const longest = Math.max(0, ...(text.match(/`+/g) || []).map((m) => m.length));
    const fence = "`".repeat(Math.max(3, longest + 1));
    out.push(fence + "text", text, fence, "");
  }
  return out.join("\n");
}

/** Downloads text as a file through a temporary link. */
function downloadText(name, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** "urd-logs-YYYYMMDD-HHMMSS" (UTC), the base name of both exports. */
function exportName() {
  const now = new Date();
  return `urd-logs-${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}-${fmtTime(now.getTime()).replace(/:/g, "")}`;
}

const statusEl = document.getElementById("status");

/**
 * Saves this page as a PDF through Firefox's own print engine (a save dialog opens). Falls back to
 * simpler settings, then to the print dialog, if the browser rejects the request.
 */
async function savePdf() {
  const name = exportName();
  document.title = name;
  const settings = {
    paperSizeUnit: 1,
    paperWidth: 210,
    paperHeight: 297,
    orientation: 0,
    shrinkToFit: true,
    showBackgroundColors: false,
    headerLeft: "",
    headerCenter: "",
    headerRight: "",
    footerLeft: "",
    footerCenter: "",
    footerRight: "&P / &PT",
    toFileName: name + ".pdf",
  };
  let status;
  try {
    status = await browser.tabs.saveAsPDF(settings);
  } catch {
    try {
      status = await browser.tabs.saveAsPDF({});
    } catch {
      window.print();
      status = "print";
    }
  }
  statusEl.textContent =
    status === "saved" || status === "replaced"
      ? "PDF saved."
      : status === "print"
        ? "Use the print dialog and choose “Save as PDF”."
        : status === "canceled"
          ? "Cancelled — press “Save as PDF” to try again."
          : "The PDF could not be saved — press “Save as PDF” to try again.";
}

let currentLog = { entries: [], searchCount: 0, sessionCount: 0, pageCount: 0 };
let generatedLine = "";

/** Saves the log as a Markdown file. */
function saveMarkdown() {
  downloadText(exportName() + ".md", toMarkdown(currentLog, generatedLine), "text/markdown");
  statusEl.textContent = "Markdown saved to your downloads.";
}

/**
 * Goes back to the tree tab that is already open and closes this report tab, so the tree is not opened
 * twice. If no tree tab is left, this tab becomes the tree instead.
 */
async function backToTree(event) {
  event.preventDefault();
  try {
    const viewerUrl = browser.runtime.getURL("viewer.html");
    const tabs = await browser.tabs.query({});
    const tree = tabs.find((t) => t.url && t.url.startsWith(viewerUrl));
    if (tree) {
      const me = await browser.tabs.getCurrent();
      await browser.tabs.update(tree.id, { active: true });
      await browser.tabs.remove(me.id);
      return;
    }
  } catch {
    /* fall through to a plain navigation */
  }
  location.href = "viewer.html";
}

document.getElementById("backLink").addEventListener("click", backToTree);
document.getElementById("btnPdf").addEventListener("click", savePdf);
document.getElementById("btnMd").addEventListener("click", saveMarkdown);

(async function init() {
  const repo = document.getElementById("repoLink");
  repo.href = REPO_URL;
  repo.textContent = REPO_URL;
  const [nodes, edges, engines] = await Promise.all([PivotDB.getAllNodes(), PivotDB.getAllEdges(), loadEngines()]);
  currentLog = buildLog(nodes, edges, engines);
  renderLog(currentLog);
  generatedLine =
    `Generated ${fmtDate(Date.now())} ${fmtTime(Date.now())} UTC · ${currentLog.searchCount} searches · ` +
    `${currentLog.sessionCount} other browsing sessions · ${currentLog.pageCount} pages · all times UTC`;
  document.getElementById("meta").textContent = generatedLine;
})();
