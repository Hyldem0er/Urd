/** True for known interactive map URLs whose viewport can change without changing the destination. */
function isMapUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.toLowerCase();
    return (
      (/(^|\.)google\.[a-z.]+$/.test(host) && /^\/maps(?:\/|$)/.test(path)) ||
      host === "openstreetmap.org" || host.endsWith(".openstreetmap.org") ||
      ((host === "bing.com" || host.endsWith(".bing.com")) && /\/maps(?:\/|$)/.test(path)) ||
      ((host === "waze.com" || host.endsWith(".waze.com")) && /\/live-map(?:\/|$)/.test(path)) ||
      host === "wego.here.com" || ((host === "here.com" || host.endsWith(".here.com")) && (/\/maps?(?:\/|$)/.test(path) || host === "wego.here.com")) ||
      host === "maps.apple.com" ||
      host === "mapy.cz" || host.endsWith(".mapy.cz") ||
      ((/^yandex\.[a-z.]+$/.test(host) || host === "yandex.com" || host.endsWith(".yandex.com")) && /^\/maps(?:\/|$)/.test(path)) ||
      host === "maps.me" || host.endsWith(".maps.me") ||
      ((host === "mapquest.com" || host.endsWith(".mapquest.com")) && /\/maps?(?:\/|$)/.test(path)) ||
      ((host === "arcgis.com" || host.endsWith(".arcgis.com")) && /\/(?:apps\/mapviewer|home\/webmap\/viewer)(?:\/|$)/.test(path))
    );
  } catch {
    return false;
  }
}

/**
 * Strip the page fragment and normalize map-only viewport state. Keep search terms,
 * place identifiers/names and route endpoints so different destinations remain distinct.
 */
function normalizeUrlKey(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    u.hash = "";

    // DeepL is a SPA: ?tab=... is UI state, not a new destination.
    if (/(^|\.)deepl\.com$/i.test(u.hostname)) {
      u.searchParams.delete("tab");
    }

    if (!isMapUrl(u.href)) return u.toString();

    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.toLowerCase();

    // Google Maps stores viewport position and zoom in the /@lat,lon,zoom path segment.
    if (/(^|\.)google\.[a-z.]+$/.test(host) && /^\/maps(?:\/|$)/.test(path)) {
      u.pathname = u.pathname.replace(
        /@-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?(?:,\d+(?:\.\d+)?(?:z|m)?)?/gi,
        "@<map-viewport>"
      );
      // Preserve legacy normalization for existing saved Google Maps URL keys.
      for (const key of ["center", "ll", "sll", "viewport"]) {
        if (u.searchParams.has(key)) u.searchParams.set(key, "<map-viewport>");
      }
      for (const key of ["zoom", "z"]) u.searchParams.delete(key);
    } else if (host === "bing.com" || host.endsWith(".bing.com")) {
      // Bing Maps: cp is the center point and lvl is viewport zoom. Keep rtp/sp and place data.
      u.searchParams.delete("cp");
      u.searchParams.delete("lvl");
    } else if (host === "waze.com" || host.endsWith(".waze.com")) {
      // Waze live map: ll/zoom describe the displayed map; `to` remains the destination.
      u.searchParams.delete("ll");
      u.searchParams.delete("zoom");
    } else if (host === "wego.here.com" || host === "here.com" || host.endsWith(".here.com")) {
      // HERE WeGo's map=lat,lon,zoom is viewport state; preserve from/to/q parameters.
      const mapState = u.searchParams.get("map");
      if (mapState && /^\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*$/.test(mapState)) {
        u.searchParams.delete("map");
      }
    } else if (host === "maps.apple.com") {
      // Apple Maps: z is viewport zoom. Only discard ll when another field identifies
      // the searched/selected place or route; a bare ll may itself be the destination.
      u.searchParams.delete("z");
      const hasPlaceOrRoute = ["q", "address", "name", "auid", "saddr", "daddr", "destination"].some((key) => u.searchParams.has(key));
      if (hasPlaceOrRoute) u.searchParams.delete("ll");
    } else if (host === "mapy.cz" || host.endsWith(".mapy.cz")) {
      // Mapy.cz uses x/y/z for viewport center and zoom; place IDs remain untouched.
      for (const key of ["x", "y", "z"]) u.searchParams.delete(key);
    } else if (/^yandex\.[a-z.]+$/.test(host) || host === "yandex.com" || host.endsWith(".yandex.com")) {
      // Yandex Maps: ll and z are viewport state; whatshere/route/search fields remain.
      u.searchParams.delete("ll");
      u.searchParams.delete("z");
    } else if (host === "mapquest.com" || host.endsWith(".mapquest.com")) {
      for (const key of ["center", "zoom", "map"] ) u.searchParams.delete(key);
    } else if ((host === "arcgis.com" || host.endsWith(".arcgis.com")) && /\/(?:apps\/mapviewer|home\/webmap\/viewer)(?:\/|$)/.test(path)) {
      for (const key of ["center", "extent", "level", "zoom", "scale"]) u.searchParams.delete(key);
    } else {
      // Generic map viewport parameters, only on recognized map sites. Do not strip raw
      // lat/lon or destination parameters: those may identify an actual place or route.
      for (const key of ["bbox", "bounds", "extent", "viewport", "zoom", "level", "scale"]) {
        u.searchParams.delete(key);
      }
    }

    return u.toString();
  } catch {
    return url;
  }
}

/** PivotDB: thin promise wrapper over IndexedDB, shared by background.js, viewer.js and popup.js. */
const PivotDB = (() => {
  const DB_NAME = "pivotTrackerDB";
  const DB_VERSION = 4;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        const txn = e.target.transaction;
        let nodes;
        if (!db.objectStoreNames.contains("nodes")) {
          nodes = db.createObjectStore("nodes", { keyPath: "id", autoIncrement: true });
          nodes.createIndex("tabId", "tabId");
          nodes.createIndex("timestamp", "timestamp");
          nodes.createIndex("domain", "domain");
        } else {
          nodes = txn.objectStore("nodes");
        }
        if (!nodes.indexNames.contains("urlKey")) {
          nodes.createIndex("urlKey", "urlKey");
        }
        if (!db.objectStoreNames.contains("edges")) {
          const edges = db.createObjectStore("edges", { keyPath: "id", autoIncrement: true });
          edges.createIndex("source", "source");
          edges.createIndex("target", "target");
        }
        if (!db.objectStoreNames.contains("clip")) {
          const clip = db.createObjectStore("clip", { keyPath: "id", autoIncrement: true });
          clip.createIndex("timestamp", "timestamp");
        }
        // The debug log was removed in v4; drop its store from older databases.
        if (db.objectStoreNames.contains("log")) db.deleteObjectStore("log");
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
    return dbPromise;
  }

  async function tx(storeName, mode) {
    const db = await open();
    return db.transaction(storeName, mode).objectStore(storeName);
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  return {
    async addNode(node) {
      const store = await tx("nodes", "readwrite");
      const id = await reqToPromise(store.add(node));
      return id;
    },
    async updateNode(id, patch) {
      const store = await tx("nodes", "readwrite");
      const existing = await reqToPromise(store.get(id));
      if (!existing) return;
      Object.assign(existing, patch);
      await reqToPromise(store.put(existing));
    },
    async findNodeByUrl(url) {
      const key = normalizeUrlKey(url);
      if (!key) return null;
      const store = await tx("nodes", "readonly");
      const idx = store.index("urlKey");
      const result = await reqToPromise(idx.get(key));
      return result || null;
    },
    async getNode(id) {
      const store = await tx("nodes", "readonly");
      const result = await reqToPromise(store.get(id));
      return result || null;
    },
    async getEdgesByTarget(nodeId) {
      const store = await tx("edges", "readonly");
      const idx = store.index("target");
      return reqToPromise(idx.getAll(nodeId));
    },
    async addEdge(edge) {
      const store = await tx("edges", "readwrite");
      return reqToPromise(store.add(edge));
    },
    async deleteEdge(id) {
      const store = await tx("edges", "readwrite");
      return reqToPromise(store.delete(id));
    },
    async updateEdge(id, patch) {
      const store = await tx("edges", "readwrite");
      const existing = await reqToPromise(store.get(id));
      if (!existing) return;
      await reqToPromise(store.put({ ...existing, ...patch, id }));
    },
    async deleteNode(id) {
      const nodeStore = await tx("nodes", "readwrite");
      await reqToPromise(nodeStore.delete(id));
      const edgeStore = await tx("edges", "readwrite");
      const all = await reqToPromise(edgeStore.getAll());
      for (const e of all) {
        if (e.source === id || e.target === id) edgeStore.delete(e.id);
      }
    },
    async addClip(entry) {
      const store = await tx("clip", "readwrite");
      return reqToPromise(store.add(entry));
    },
    async updateClip(id, patch) {
      const store = await tx("clip", "readwrite");
      const clip = await reqToPromise(store.get(id));
      if (!clip) return false;
      await reqToPromise(store.put({ ...clip, ...patch, id }));
      return true;
    },
    async getAllNodes() {
      const store = await tx("nodes", "readonly");
      return reqToPromise(store.getAll());
    },
    async getAllEdges() {
      const store = await tx("edges", "readonly");
      return reqToPromise(store.getAll());
    },
    async getRecentClips(sinceTs) {
      const store = await tx("clip", "readonly");
      const all = await reqToPromise(store.getAll());
      return all.filter((c) => c.timestamp >= sinceTs);
    },
    async getAllClips() {
      const store = await tx("clip", "readonly");
      const all = await reqToPromise(store.getAll());
      return all.sort((a, b) => b.timestamp - a.timestamp);
    },
    async pruneClips(beforeTs) {
      const store = await tx("clip", "readwrite");
      const all = await reqToPromise(store.getAll());
      for (const c of all) {
        if (c.timestamp < beforeTs) store.delete(c.id);
      }
    },
    async clearAll() {
      const db = await open();
      await Promise.all(
        ["nodes", "edges", "clip"].map(
          (name) =>
            new Promise((resolve, reject) => {
              const r = db.transaction(name, "readwrite").objectStore(name).clear();
              r.onsuccess = () => resolve();
              r.onerror = () => reject(r.error);
            })
        )
      );
    },
    async counts() {
      const [nodes, edges] = await Promise.all([this.getAllNodes(), this.getAllEdges()]);
      const pivots = edges.filter((e) => e.type === "pivot").length;
      return { nodes: nodes.length, edges: edges.length, pivots };
    },
  };
})();
