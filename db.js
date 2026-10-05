/** Strips the #fragment (a scroll anchor) but keeps the query string, so "the same page" merges into one card. */
function normalizeUrlKey(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    u.hash = "";

    // DeepL is a SPA: ?tab=... is UI state, not a new destination, so drop it to avoid duplicate nodes.
    if (/(^|\.)deepl\.com$/i.test(u.hostname)) {
      u.searchParams.delete("tab");
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
