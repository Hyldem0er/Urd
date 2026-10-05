const NODE_W = 190;
const NODE_H = 46;
const H_GAP = 34;
const V_GAP = 78;

const svg = document.getElementById("canvas");
const SVGNS = "http://www.w3.org/2000/svg";

/** Bundled graph icons. These files are supplied in the extension's assets/ folder. */
const ASSET_ICONS = {
  download: "assets/download.png",
  notes: "assets/notes.svg",
  translation: "assets/translation.svg",
  pivot: "assets/pivot.svg",
};

function svgIcon(src, x, y, size = 13, parent, className = "node-badge-icon") {
  return el("image", {
    href: src,
    x,
    y,
    width: size,
    height: size,
    preserveAspectRatio: "xMidYMid meet",
    class: className,
  }, parent);
}

function edgeLabelGroup(e, lx, ly, labelCls, parent) {
  const labelText = truncate(e.label || "", 26);
  const textWidth = labelText.length * 5.8;
  const iconSize = 30;
  const gap = 4;

  // Center the label text on its point; place the icon to the left of the centered text.
  const group = el("g", {
    class: labelCls,
    transform: `translate(${lx},${ly})`,
    "data-edge-id": e.id,
  }, parent);
  const iconName = e.type === "translation" ? "translation" : "pivot";
  svgIcon(ASSET_ICONS[iconName], -textWidth / 2 - gap - iconSize, -iconSize / 2, iconSize, group, "edge-label-icon");
  const text = el("text", {
    x: -textWidth / 2,
    y: 0,
    "dominant-baseline": "central",
    "text-anchor": "start",
  }, group);
  text.textContent = labelText;
  return group;
}

let allNodes = [];
let allEdges = [];
/** Card positions in board coordinates (id -> {x, y}). */
let layoutPositions = new Map();
/** The card shown in the detail sidebar. */
let selectedNodeId = null;
/** Marquee/multi-selection, used for group-dragging. */
let selectedNodeIds = new Set();
let viewTransform = { x: 40, y: 40, k: 1 };
/** Zoom floor used by both Fit view and wheel zoom; cards switch to favicon markers below FAVICON_ONLY_K. */
const MIN_ZOOM_K = 0.02;
const MAX_ZOOM_K = 2.5;

/** Draw-connection mode uses the next two node clicks as source and target, then asks for a label. */
let linkMode = false;
let linkFirstNodeId = null;

/** Cache of live node elements so dragging can update them without a full render (id -> { group, tilt }). */
let nodeEls = new Map();
/** Cache of live edge elements (edge id -> { path, label, type, source, target }). */
let edgeEls = new Map();
/** Routing offset per edge that keeps parallel strings apart (edge id -> offset). */
let edgeLanes = new Map();

/**
 * Node drag state: the selected ids and each node's starting position.
 * Shape: { ids, startPositions: Map<id,{x,y}>, originWorld: {x,y}, originScreen: {x,y}, moved }.
 */
let nodeDrag = null;
let suppressNextClick = false;

/** Marquee selection in screen space: { x0, y0, x1, y1 }, or null. */
let marquee = null;

/** Movement (px) required before a press counts as a drag; avoids click/double-click glitches. */
const DRAG_THRESHOLD_PX = 4;

/**
 * Double-clicks are tracked manually because selecting re-renders the target; native dblclick stays as
 * fallback.
 */
let lastClickNodeId = null;
let lastClickTime = 0;
const DBLCLICK_MS = 400;

/** Right-button drag pans; the context menu opens only when no drag occurred. */
let rightDragMoved = false;

/** The open right-click context menu element, or null. */
let contextMenuEl = null;

/** Undo/redo stores structural changes, not note keystrokes. */
let undoStack = [];
let redoStack = [];
const MAX_UNDO_HISTORY = 50;

function pushUndo(action) {
  undoStack.push(action);
  if (undoStack.length > MAX_UNDO_HISTORY) undoStack.shift();
  redoStack = []; // a fresh action invalidates whatever was available to redo
}

async function performUndo() {
  const action = undoStack.pop();
  if (!action) return;
  await action.undo();
  redoStack.push(action);
  await loadAndRender(true);
}

async function performRedo() {
  const action = redoStack.pop();
  if (!action) return;
  await action.redo();
  undoStack.push(action);
  await loadAndRender(true);
}

/** Snapshot deleted nodes and their touching edges so undo can restore the exact records. */
function snapshotNodesAndEdges(nodeIds) {
  const idSet = new Set(nodeIds);
  return {
    nodes: allNodes.filter((n) => idSet.has(n.id)).map((n) => ({ ...n })),
    edges: allEdges.filter((e) => idSet.has(e.source) || idSet.has(e.target)).map((e) => ({ ...e })),
  };
}
async function restoreSnapshot(snapshot) {
  for (const n of snapshot.nodes) await PivotDB.addNode(n);
  for (const e of snapshot.edges) await PivotDB.addEdge(e);
}

async function deleteEdgeWithUndo(edgeId) {
  const snapshot = allEdges.find((e) => e.id === edgeId);
  if (!snapshot) return;
  const edgeCopy = { ...snapshot };
  await PivotDB.deleteEdge(edgeId);
  pushUndo({
    label: "delete connection",
    undo: () => PivotDB.addEdge(edgeCopy),
    redo: () => PivotDB.deleteEdge(edgeId),
  });
  await loadAndRender(true);
}

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

/** Seed the card tilt from its node id so rerenders keep rotation stable. */
function seeded(id, salt) {
  let h = (id * 2654435761 + salt * 40503) >>> 0;
  h ^= h << 13; h >>>= 0;
  h ^= h >> 17;
  h ^= h << 5; h >>>= 0;
  return (h % 10000) / 10000;
}

/**
 * Resolves overlaps between positioned cards in the same column, moving them vertically without changing
 * columns.
 */
function preventNodeOverlaps(positions, nodes) {
  const byX = new Map();
  for (const n of nodes) {
    const p = positions.get(n.id);
    if (!p) continue;
    const key = Math.round(p.x * 100) / 100;
    if (!byX.has(key)) byX.set(key, []);
    byX.get(key).push(n.id);
  }

  const minGap = 18;
  for (const ids of byX.values()) {
    ids.sort((a, b) => {
      const ay = positions.get(a)?.y ?? 0;
      const by = positions.get(b)?.y ?? 0;
      return ay - by || a - b;
    });
    for (let i = 1; i < ids.length; i++) {
      const prev = positions.get(ids[i - 1]);
      const cur = positions.get(ids[i]);
      if (!prev || !cur) continue;
      const minY = prev.y + NODE_H + minGap;
      if (cur.y < minY) cur.y = minY;
    }
  }
  return positions;
}

/** Width of the horizontal bar of the date/time bracket above a card. */
const STAMP_W = 128;

/** Formats a timestamp as dd/mm/yyyy - HH:MM (24 h, local time), independent of the browser locale. */
function formatStamp(ts) {
  const d = new Date(ts || 0);
  const p = (x) => String(x).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} - ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Computes a position for every card: the layered layout, with manual positions persisting over it. */
function buildLayout(nodes, edges) {
  if (nodes.length === 0) return new Map();

  const positions = runAlignedLayout(nodes, edges);

  for (const n of nodes) {
    if (typeof n.posX === "number" && typeof n.posY === "number") {
      positions.set(n.id, { x: n.posX, y: n.posY });
    }
  }
  return preventNodeOverlaps(positions, nodes);
}


/** Phase 1 orders nodes with an iterative barycenter heuristic to reduce crossings. */
function computeCrossingReducedRank(nodes, edges) {
  const adjacency = new Map();
  nodes.forEach((n) => adjacency.set(n.id, []));
  edges.forEach((e) => {
    if (!adjacency.has(e.source) || !adjacency.has(e.target)) return;
    adjacency.get(e.source).push(e.target);
    adjacency.get(e.target).push(e.source);
  });
  const sorted = nodes.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  let rank = new Map(sorted.map((n, i) => [n.id, i]));
  for (let pass = 0; pass < 5; pass++) {
    const next = new Map();
    nodes.forEach((n) => {
      const neighbors = adjacency.get(n.id);
      if (!neighbors.length) {
        next.set(n.id, rank.get(n.id));
        return;
      }
      const avgNeighbor = neighbors.reduce((sum, id) => sum + rank.get(id), 0) / neighbors.length;
      next.set(n.id, (rank.get(n.id) + avgNeighbor) / 2);
    });
    rank = next;
  }
  return rank;
}

/** Phase 2 relaxes Y positions toward neighbors, then enforces minimum gaps with PAVA; order stays fixed. */
function centerOnConnections(domainOrder, byDomain, edges, rowStep) {
  const adjacency = new Map();
  domainOrder.forEach((d) => byDomain.get(d).forEach((n) => adjacency.set(n.id, [])));
  edges.forEach((e) => {
    if (!adjacency.has(e.source) || !adjacency.has(e.target)) return;
    adjacency.get(e.source).push(e.target);
    adjacency.get(e.target).push(e.source);
  });

  const y = new Map();
  domainOrder.forEach((d) => {
    byDomain.get(d).forEach((n, i) => y.set(n.id, i * rowStep));
  });

  for (let pass = 0; pass < 12; pass++) {
    const desired = new Map();
    y.forEach((curY, id) => {
      const neighbors = adjacency.get(id);
      if (!neighbors.length) {
        desired.set(id, curY);
        return;
      }
      const avg = neighbors.reduce((sum, nid) => sum + (y.has(nid) ? y.get(nid) : curY), 0) / neighbors.length;
      desired.set(id, curY * 0.4 + avg * 0.6); // damped, so it settles instead of oscillating
    });
    domainOrder.forEach((d) => {
      const rows = byDomain.get(d);
      const resolved = resolveColumnPositions(rows.map((n) => desired.get(n.id)), rowStep);
      rows.forEach((n, i) => y.set(n.id, resolved[i]));
    });
  }

  let minY = 0;
  y.forEach((v) => {
    if (v < minY) minY = v;
  });
  if (minY < 0) y.forEach((v, id) => y.set(id, v - minY));

  return y;
}

/** PAVA returns the closest Y positions that satisfy the minimum gap constraint. */
function resolveColumnPositions(desiredInOrder, gap) {
  const adjusted = desiredInOrder.map((v, i) => v - i * gap);
  const iso = isotonicNonDecreasing(adjusted);
  return iso.map((v, i) => v + i * gap);
}
function isotonicNonDecreasing(values) {
  const blocks = []; // stack of {sum, count, value}; value = sum/count
  for (const v of values) {
    let block = { sum: v, count: 1, value: v };
    blocks.push(block);
    while (blocks.length > 1 && blocks[blocks.length - 2].value > blocks[blocks.length - 1].value) {
      const b2 = blocks.pop();
      const b1 = blocks.pop();
      const sum = b1.sum + b2.sum, count = b1.count + b2.count;
      blocks.push({ sum, count, value: sum / count });
    }
  }
  const result = [];
  for (const b of blocks) for (let i = 0; i < b.count; i++) result.push(b.value);
  return result;
}

/**
 * Layered tree layout, one subtree per root (fresh search, typed URL, "Start here"...). stackVertically stacks
 * roots in rows (Vertical layout); otherwise they sit side by side.
 */
function runAlignedLayout(nodes, edges, { stackVertically = false } = {}) {
  if (!nodes.length) return new Map();

  const byId = new Map(nodes.map(n => [n.id, n]));
  const byTime = (a,b) => (a.timestamp || 0) - (b.timestamp || 0) || a.id - b.id;
  const incoming = new Map(nodes.map(n => [n.id, []]));

  // Navigation edges determine sibling vertical order; pivot/translation/manual edges do not.
  edges.filter(e => e.type !== "revisit" && byId.has(e.source) && byId.has(e.target) && e.source !== e.target)
    .forEach(e => incoming.get(e.target).push(e));

  const parent = new Map();
  const parentEdge = new Map();
  for (const n of nodes) {
    const candidates = (incoming.get(n.id) || []).slice().sort((a,b) => {
      const ap = a.type === "navigation" ? 0 : 1;
      const bp = b.type === "navigation" ? 0 : 1;
      return ap - bp || (a.timestamp || 0) - (b.timestamp || 0) || a.id - b.id;
    });
    if (candidates.length) {
      parent.set(n.id, candidates[0].source);
      parentEdge.set(n.id, candidates[0]);
    }
  }

  const navChildren = new Map(nodes.map(n => [n.id, []]));
  const auxChildren = new Map(nodes.map(n => [n.id, []]));
  for (const [childId, parentId] of parent) {
    const e = parentEdge.get(childId);
    (e.type === "navigation" ? navChildren : auxChildren).get(parentId).push(childId);
  }
  navChildren.forEach(a => a.sort((x,y) => byTime(byId.get(x), byId.get(y))));
  auxChildren.forEach(a => a.sort((x,y) => byTime(byId.get(x), byId.get(y))));

  const xStep = NODE_W + 175;
  const navGap = 92;
  const auxGap = { pivot: 103, translation: 86, manual: 100 };
  const auxFallbackGap = 70;
  const componentGap = 190;

  /** Build each subtree bottom-up; all child edge types share the next column. */
  function buildSubtree(id, depth) {
    const childIds = [
      ...(navChildren.get(id) || []),
      ...(auxChildren.get(id) || [])
    ].sort((a, b) => byTime(byId.get(a), byId.get(b)));

    if (!childIds.length) {
      return {
        pos: new Map([[id, { x: depth * xStep, y: 0 }]]),
        nodeY: 0,
        top: -NODE_H / 2,
        bottom: NODE_H / 2,
        fullTop: -NODE_H / 2,
        fullBottom: NODE_H / 2
      };
    }

    // Lay out child subtrees first, pack them with the minimum gap, then center them on the parent.
    const childBlocks = childIds.map(childId => ({
      id: childId,
      child: buildSubtree(childId, depth + 1)
    }));

    const centers = [];
    centers[0] = 0;
    for (let i = 1; i < childBlocks.length; i++) {
      const prev = childBlocks[i - 1].child;
      const cur = childBlocks[i].child;
      centers[i] = Math.max(
        centers[i - 1] + prev.fullBottom + navGap - cur.fullTop,
        centers[i - 1] + NODE_H + navGap
      );
    }

    // Center child roots around the parent: 1 child aligns, 2 split around it, 3 put the middle child on it.
    const centerShift = -(centers[0] + centers[centers.length - 1]) / 2;
    const shifts = centers.map(c => c + centerShift);

    const pos = new Map([[id, { x: depth * xStep, y: 0 }]]);
    let fullTop = -NODE_H / 2;
    let fullBottom = NODE_H / 2;

    childBlocks.forEach(({ child }, i) => {
      const shift = shifts[i];
      child.pos.forEach((p, nid) => {
        pos.set(nid, { x: p.x, y: p.y + shift });
      });
      fullTop = Math.min(fullTop, child.fullTop + shift);
      fullBottom = Math.max(fullBottom, child.fullBottom + shift);
    });

    return {
      pos,
      nodeY: 0,
      top: -NODE_H / 2,
      bottom: NODE_H / 2,
      fullTop,
      fullBottom
    };
  }

  const roots = nodes.filter(n => !parent.has(n.id)).sort(byTime);
  const positions = new Map();

  if (stackVertically) {
    // Stacked roots share the first column; each story occupies one full-height band in chronological order.
    let componentY = 30;
    for (const root of roots) {
      const block = buildSubtree(root.id, 0);
      let minY = Infinity, maxY = -Infinity;
      block.pos.forEach(p => {
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y + NODE_H);
      });

      // Move each story to the current vertical cursor, then advance by its full footprint.
      const yShift = componentY - minY;
      block.pos.forEach((p, id) => {
        positions.set(id, { x: p.x, y: p.y + yShift });
      });
      componentY += (maxY - minY) + componentGap;
    }

    nodes.forEach((n, i) => {
      if (!positions.has(n.id)) {
        positions.set(n.id, { x: (i % 4) * xStep, y: componentY + Math.floor(i / 4) * (NODE_H + navGap) });
      }
    });
  } else {
    // Side-by-side roots share a horizontal baseline and run left to right by chronology.
    let componentX = 0;
    for (const root of roots) {
      const block = buildSubtree(root.id, 0);
      let minX = Infinity, maxX = -Infinity;
      block.pos.forEach(p => {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x + NODE_W);
      });

      const rootY = block.pos.get(root.id).y;
      const baseline = 30;
      const yShift = baseline - rootY;
      block.pos.forEach((p, id) => {
        positions.set(id, { x: p.x + componentX - minX, y: p.y + yShift });
      });
      componentX += (maxX - minX) + componentGap;
    }

    nodes.forEach((n, i) => {
      if (!positions.has(n.id)) {
        positions.set(n.id, { x: componentX + (i % 4) * xStep, y: 30 + Math.floor(i / 4) * (NODE_H + navGap) });
      }
    });
  }

  // Prevent overlap between cards in the same column.
  const columns = new Map();
  positions.forEach((p, id) => {
    const key = Math.round(p.x * 100) / 100;
    if (!columns.has(key)) columns.set(key, []);
    columns.get(key).push(id);
  });
  for (const ids of columns.values()) {
    ids.sort((a,b) => positions.get(a).y - positions.get(b).y || a - b);
    for (let i = 1; i < ids.length; i++) {
      const prev = positions.get(ids[i - 1]);
      const cur = positions.get(ids[i]);
      cur.y = Math.max(cur.y, prev.y + NODE_H + 18);
    }
  }

  return positions;
}

/** Keep simple curved edges; add lanes only when several edges connect the same pair. */
let routingBounds = { minY: 0, maxY: 0 };
let routingPorts = new Map();
let routingNodes = [];
let routingEdges = [];

function buildEdgeLanes(edges, nodes = [], positions = new Map()) {
  routingEdges = Array.isArray(edges) ? edges.slice() : [];
  routingNodes = Array.isArray(nodes)
    ? nodes.map((n) => {
        const p = positions.get(n.id);
        return { ...n, x: p?.x ?? n.posX, y: p?.y ?? n.posY };
      })
    : [];

  const groups = new Map();
  for (const e of edges) {
    const a = Math.min(e.source, e.target);
    const b = Math.max(e.source, e.target);
    const key = `${a}:${b}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const lane = new Map();
  for (const group of groups.values()) {
    group.sort((a, b) => {
      const priority = (e) =>
        e.type === "navigation" ? 0 :
        e.type === "revisit" ? 1 :
        e.type === "pivot" ? 2 :
        e.type === "translation" ? 3 : 4;
      return priority(a) - priority(b) || a.id - b.id;
    });
    const mid = (group.length - 1) / 2;
    group.forEach((e, i) => lane.set(e.id, i - mid));
  }
  routingPorts = new Map();
  return lane;
}

function isLongCrossPivot(e, dx) {
  // Offset long pivots from the main navigation chain even in favicon mode.
  return e.type === "pivot" && dx >= 260;
}

function navigationPathNodes(sourceId, targetId) {
  // Clear only the navigation/search chain between pivot endpoints; unrelated branches may cross.
  if (!Number.isFinite(sourceId) || !Number.isFinite(targetId)) return [];
  const adjacency = new Map();
  for (const e of routingEdges) {
    if (!e || e.type !== "navigation") continue;
    if (!adjacency.has(e.source)) adjacency.set(e.source, []);
    adjacency.get(e.source).push(e.target);
  }

  const queue = [sourceId];
  const prev = new Map([[sourceId, null]]);
  while (queue.length) {
    const id = queue.shift();
    if (id === targetId) break;
    for (const next of adjacency.get(id) || []) {
      if (prev.has(next)) continue;
      prev.set(next, id);
      queue.push(next);
    }
  }

  if (!prev.has(targetId)) return [];
  const path = [];
  let cur = targetId;
  while (cur !== null) {
    path.push(cur);
    cur = prev.get(cur);
  }
  path.reverse();
  return path.slice(1, -1);
}

function pivotLaneY(s, t, laneOffset = 0) {
  const sy = s.y + NODE_H / 2;
  const ty = t.y + NODE_H / 2;
  const desiredFallback = Math.max(sy, ty) + NODE_H / 2 + 10;

  const pathNodeIds = navigationPathNodes(s.id, t.id);
  let lowestBottom = -Infinity;
  for (const id of pathNodeIds) {
    const n = routingNodes.find((node) => node.id === id);
    if (!n || !Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
    lowestBottom = Math.max(lowestBottom, n.y + NODE_H);
  }

  // Route the pivot about 10 px below the lowest intermediate navigation node.
  let desiredCableY = Number.isFinite(lowestBottom)
    ? lowestBottom + 10
    : desiredFallback;

  desiredCableY += Math.abs(laneOffset) * 18;
  return desiredCableY;
}

function longPivotGeometry(s, t, laneOffset = 0, faviconMode = false) {
  const sx = s.x + (faviconMode ? NODE_W / 2 : NODE_W);
  const sy = s.y + NODE_H / 2;
  const tx = t.x + (faviconMode ? NODE_W / 2 : 0);
  const ty = t.y + NODE_H / 2;

  const dx = Math.max(45, tx - sx);
  const desiredCableY = pivotLaneY(s, t, laneOffset);

  // Use two smooth blends around the horizontal corridor so its height stays fixed as nodes move.
  const bend = Math.max(55, Math.min(170, dx * 0.22));
  const leftX = Math.min(tx - 20, sx + bend);
  const rightX = Math.max(sx + 20, tx - bend);

  // Collapse the corridor when endpoints are too close to fit both bends.
  const corridorWidth = Math.max(20, rightX - leftX);
  const midX = (sx + tx) / 2;
  const safeLeftX = corridorWidth > 20 ? leftX : midX - 10;
  const safeRightX = corridorWidth > 20 ? rightX : midX + 10;

  return {
    sx, sy, tx, ty,
    laneY: desiredCableY,
    leftX: safeLeftX,
    rightX: safeRightX,
    bend: Math.max(35, Math.min(130, bend * 0.7)),
  };
}

function edgePathD(e, s, t, lane = 0) {
  const faviconMode = viewTransform.k < FAVICON_ONLY_K;
  const sx = s.x + (faviconMode ? NODE_W / 2 : NODE_W);
  const sy = s.y + NODE_H / 2;
  const tx = t.x + (faviconMode ? NODE_W / 2 : 0);
  const ty = t.y + NODE_H / 2;
  const laneOffset = faviconMode ? 0 : lane;

  if (tx >= sx) {
    const dx = Math.max(45, tx - sx);

    if (isLongCrossPivot(e, dx)) {
      const g = longPivotGeometry(s, t, laneOffset, faviconMode);
      const blend = g.bend;

      // Use two smooth bends plus a straight corridor so intermediate node movement does not change its height.
      return [
        `M${g.sx},${g.sy}`,
        `C${g.sx + blend},${g.sy} ${g.leftX - blend},${g.laneY} ${g.leftX},${g.laneY}`,
        `L${g.rightX},${g.laneY}`,
        `C${g.rightX + blend},${g.laneY} ${g.tx - blend},${g.ty} ${g.tx},${g.ty}`,
      ].join(' ');
    }

    const bend = Math.max(55, Math.min(180, dx * 0.48));
    const offset = laneOffset * 10;
    return `M${sx},${sy + offset} C${sx + bend},${sy + offset} ${tx - bend},${ty + offset} ${tx},${ty + offset}`;
  }

  // Backward/revisit edges curve below the source and target.
  const dx = Math.max(70, sx - tx);
  const bend = Math.max(60, Math.min(190, dx * 0.5));
  const arch = Math.min(150, 45 + dx * 0.22) + Math.abs(laneOffset) * 16;
  const dir = laneOffset < 0 ? -1 : 1;
  const cy = Math.max(sy, ty) + dir * arch;
  return `M${sx},${sy} C${sx - bend},${cy} ${tx + bend},${cy} ${tx},${ty}`;
}

function edgeLabelPos(e, s, t, lane = 0) {
  const faviconMode = viewTransform.k < FAVICON_ONLY_K;
  const sx = s.x + (faviconMode ? NODE_W / 2 : NODE_W);
  const sy = s.y + NODE_H / 2;
  const tx = t.x + (faviconMode ? NODE_W / 2 : 0);
  const ty = t.y + NODE_H / 2;
  const laneOffset = faviconMode ? 0 : lane;

  if (tx >= sx) {
    const dx = Math.max(45, tx - sx);

    if (isLongCrossPivot(e, dx)) {
      const g = longPivotGeometry(s, t, laneOffset, faviconMode);
      // Place the label on the horizontal corridor for vertical stability.
      return {
        lx: (g.leftX + g.rightX) / 2,
        ly: g.laneY - 8,
      };
    }

    return {
      lx: (sx + tx) / 2,
      ly: (sy + ty) / 2 + laneOffset * 10 - 8,
    };
  }

  const dx = Math.max(70, sx - tx);
  const arch = Math.min(150, 45 + dx * 0.22) + Math.abs(laneOffset) * 16;
  const dir = laneOffset < 0 ? -1 : 1;
  return {
    lx: (sx + tx) / 2,
    ly: Math.max(sy, ty) + dir * arch - 8,
  };
}

function truncate(str, n) {
  if (!str) return "";
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

/** Cull DOM creation outside the padded viewport; layout and filtering still process the full graph. */
const CULL_MARGIN_PX = 600;
function getCullRect() {
  const rect = svg.getBoundingClientRect();
  const marginWorld = CULL_MARGIN_PX / viewTransform.k;
  return {
    minX: -viewTransform.x / viewTransform.k - marginWorld,
    minY: -viewTransform.y / viewTransform.k - marginWorld,
    maxX: (rect.width - viewTransform.x) / viewTransform.k + marginWorld,
    maxY: (rect.height - viewTransform.y) / viewTransform.k + marginWorld,
  };
}
/** Test card/viewport overlap with axis-aligned bounding boxes. */
function posInRect(pos, rect) {
  return (
    pos.x + NODE_W >= rect.minX &&
    pos.x <= rect.maxX &&
    pos.y + NODE_H >= rect.minY &&
    pos.y <= rect.maxY
  );
}

/** Pan and zoom use CSS transforms without rerendering; resync culling after the gesture settles. */
let cullSyncTimer = null;
const CULL_SYNC_DEBOUNCE_MS = 150;
function scheduleCullSync() {
  clearTimeout(cullSyncTimer);
  cullSyncTimer = setTimeout(rerender, CULL_SYNC_DEBOUNCE_MS);
}

/** Filter syntax: space or + = AND, | = OR, () groups, "quotes" = phrase. Precedence: () > + > |. */
function nodeSearchText(n) {
  const downloads = Array.isArray(n.downloads)
    ? n.downloads.map((d) => d.filename || "").join(" ")
    : "";
  return [n.title, n.url, n.domain, n.notes, downloads]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Tokenize filters while preserving quoted phrases; operators and parentheses may be spaced or adjacent. */
function tokenizeFilter(expr) {
  const tokens = [];
  let i = 0;

  while (i < expr.length) {
    const ch = expr[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (ch === "+" || ch === "|" || ch === "(" || ch === ")") {
      tokens.push({ type: ch });
      i++;
      continue;
    }

    if (ch === '"') {
      i++;
      let value = "";
      while (i < expr.length) {
        if (expr[i] === "\\" && i + 1 < expr.length && expr[i + 1] === '"') {
          value += '"';
          i += 2;
          continue;
        }
        if (expr[i] === '"') {
          i++;
          break;
        }
        value += expr[i++];
      }
      tokens.push({ type: "term", value, quoted: true });
      continue;
    }

    // Capture word/term tokens
    let value = "";
    while (i < expr.length) {
      const c = expr[i];
      if (/\s/.test(c) || c === "+" || c === "|" || c === "(" || c === ")") break;
      value += c;
      i++;
    }

    if (value) {
      const upper = value.toUpperCase();
      if (upper === "AND") {
        tokens.push({ type: "+" }); // Treat 'AND' identically to '+'
      } else if (upper === "OR") {
        tokens.push({ type: "|" }); // Treat 'OR' identically to '|'
      } else {
        tokens.push({ type: "term", value });
      }
    }
  }

  return tokens;
}

function parseFilter(expr) {
  const tokens = tokenizeFilter(expr);
  let pos = 0;

  function parseOr() {
    let node = parseAnd();
    while (tokens[pos] && tokens[pos].type === "|") {
      pos++;
      node = { type: "or", children: [node, parseAnd()] };
    }
    return node;
  }

  function parseAnd() {
    let node = parsePrimary();
    while (
      tokens[pos] &&
      tokens[pos].type !== ")" &&
      tokens[pos].type !== "|" // Prevent OR tokens from triggering an implicit AND
    ) {
      if (tokens[pos].type === "+") pos++;
      node = { type: "and", children: [node, parsePrimary()] };
    }
    return node;
  }

  function parsePrimary() {
    const token = tokens[pos];
    if (!token) return { type: "empty" };

    if (token.type === "(") {
      pos++;
      const node = parseOr();
      if (tokens[pos] && tokens[pos].type === ")") pos++;
      return node;
    }

    if (token.type === "term") {
      pos++;
      return { type: "term", value: token.value, quoted: !!token.quoted };
    }

    // Be forgiving of malformed expressions such as a leading operator.
    pos++;
    return { type: "empty" };
  }

  return expr ? parseOr() : { type: "empty" };
}

function evaluateFilter(ast, haystack) {
  if (!ast || ast.type === "empty") return true;
  if (ast.type === "term") return !!ast.value && haystack.includes(ast.value);
  if (ast.type === "and") return ast.children.every((child) => evaluateFilter(child, haystack));
  if (ast.type === "or") return ast.children.some((child) => evaluateFilter(child, haystack));
  return false;
}

/** Share the same filter parser between full render and in-place highlighting. */
function computeMatchIds(nodes, filterText) {
  const q = (filterText || "").trim().toLowerCase();
  const activeFilter = !!q;
  const filterAst = parseFilter(q);
  const matchIds = new Set();
  if (activeFilter) {
    for (const n of nodes) {
      if (evaluateFilter(filterAst, nodeSearchText(n))) matchIds.add(n.id);
    }
  }
  return { matchIds, activeFilter };
}

/** Search input restyles cached elements only; visibility checkboxes still require a full rerender. */
function applySearchHighlight() {
  const filterText = document.getElementById("search").value;
  const { matchIds, activeFilter } = computeMatchIds(allNodes, filterText);

  nodeEls.forEach((entry, id) => {
    const isMatch = activeFilter && matchIds.has(id);
    entry.group.classList.toggle("dimmed", activeFilter && !isMatch);
    entry.group.classList.toggle("match", isMatch);
  });

  edgeEls.forEach((entry) => {
    const dimmed = activeFilter && !(matchIds.has(entry.source) || matchIds.has(entry.target));
    entry.path.classList.toggle("dimmed", dimmed);
    if (entry.label) entry.label.classList.toggle("dimmed", dimmed);
  });

  updateFilterSpotlight();
}

function render(nodes, edges, filterText, onlyPivots, onlyFavorites) {
  svg.innerHTML = "";
  document.getElementById("emptyState").classList.toggle("hidden", nodes.length > 0);
  if (nodes.length === 0) return;

  const positions = buildLayout(nodes, edges);
  layoutPositions = positions;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ys = Array.from(positions.values()).map((p) => p.y);
  routingBounds = { minY: Math.min(...ys), maxY: Math.max(...ys) };
  edgeLanes = buildEdgeLanes(edges, nodes, positions);
  const cullRect = getCullRect();

  const g = el("g", { id: "world" }, svg);
  applyTransform(g);

  const pivotNodeIds = new Set();
  const translationNodeIds = new Set();
  const revisitCounts = new Map();
  const hasIncoming = new Set(); // cards reached from another card (revisits don't count)
  edges.forEach((e) => {
    if (e.type !== "revisit") hasIncoming.add(e.target);
    if (e.type === "pivot") {
      pivotNodeIds.add(e.source);
      pivotNodeIds.add(e.target);
    } else if (e.type === "translation") {
      translationNodeIds.add(e.source);
      translationNodeIds.add(e.target);
    } else if (e.type === "revisit") {
      revisitCounts.set(e.target, (revisitCounts.get(e.target) || 0) + 1);
    }
  });

  const { matchIds, activeFilter } = computeMatchIds(nodes, filterText);
  const selectionFocusIds = getSelectionFocusIds(selectedNodeId, edges);

  function nodeVisible(id) {
    if (onlyPivots && !pivotNodeIds.has(id) && !translationNodeIds.has(id)) return false;
    if (onlyFavorites && !(byId.get(id) && byId.get(id).favorite)) return false;
    return true;
  }

  // Render strings first so pinned cards appear above them.
  nodeEls = new Map();
  edgeEls = new Map();
  const edgeLayer = el("g", {}, g);
  for (const e of edges) {
    const s = positions.get(e.source);
    const t = positions.get(e.target);
    if (!s || !t) continue;
    if (!nodeVisible(e.source) || !nodeVisible(e.target)) continue;
    // Skip edges far outside the viewport; render an edge when either endpoint is inside to avoid cut-offs.
    if (!posInRect(s, cullRect) && !posInRect(t, cullRect)) continue;
    const dimmed = activeFilter && !(matchIds.has(e.source) || matchIds.has(e.target));
    let path, label;
    let hitD;
    if (e.type === "navigation" || e.type === "revisit") {
      hitD = edgePathD(e, s, t, edgeLanes.get(e.id) || 0);
      path = el(
        "path",
        {
          d: hitD,
          class: (e.type === "revisit" ? "edge-revisit" : "edge-nav") + (dimmed ? " dimmed" : "") + selectionSoftClass(selectionFocusIds, e.source, e.target),
          "data-edge-id": e.id,
        },
        edgeLayer
      );
    } else {
      // Pivot, translation, and manual strings can connect any two cards.
      hitD = edgePathD(e, s, t, edgeLanes.get(e.id) || 0);
      const cls = e.type === "translation" ? "edge-translation" : e.type === "manual" ? "edge-manual" : "edge-pivot";
      const labelCls = e.type === "translation" ? "translation-label" : e.type === "manual" ? "manual-label" : "pivot-label";
      path = el(
        "path",
        { d: hitD, class: cls + (dimmed ? " dimmed" : "") + selectionSoftClass(selectionFocusIds, e.source, e.target), "data-edge-id": e.id },
        edgeLayer
      );
      if (e.label) {
        const { lx, ly } = edgeLabelPos(e, s, t, edgeLanes.get(e.id) || 0);
        label = edgeLabelGroup(e, lx, ly, labelCls + (dimmed ? " dimmed" : "") + selectionSoftClass(selectionFocusIds, e.source, e.target), edgeLayer);
      }
    }
    // Add a wide invisible hit stroke to make thin edges easier to right-click.
    const hitPath = el("path", { d: hitD, class: "edge-hit", "data-edge-id": e.id }, edgeLayer);
    hitPath.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (rightDragMoved) {
        rightDragMoved = false;
        return;
      }
      showEdgeContextMenu(ev.clientX, ev.clientY, e.id);
    });
    edgeEls.set(e.id, { path, hitPath, label, type: e.type, source: e.source, target: e.target });
  }

  const nodeLayer = el("g", {}, g);
  for (const n of nodes) {
    const pos = positions.get(n.id);
    if (!pos) continue;
    if (!nodeVisible(n.id)) continue;
    if (!posInRect(pos, cullRect)) continue; // outside the padded viewport — no DOM to build
    const dimmed = activeFilter && !matchIds.has(n.id);
    const isMatch = activeFilter && matchIds.has(n.id);
    const isSelected = n.id === selectedNodeId;
    const isMultiSelected = selectedNodeIds.has(n.id);
    const isPending = linkMode && n.id === linkFirstNodeId;

    const tilt = 0;

    const group = el(
      "g",
      {
        class:
          "node" +
          (dimmed ? " dimmed" : "") +
          (isMatch ? " match" : "") +
          (isSelected ? " selected" : "") +
          (selectionFocusIds && !selectionFocusIds.has(n.id) ? " selection-soft" : "") +
          (isMultiSelected ? " multi-selected" : "") +
          (isPending ? " link-pending" : "") +
          (n.favorite ? " favorite" : "") +
          (n.manual ? " manual" : ""),
        transform: `translate(${pos.x},${pos.y}) rotate(${tilt.toFixed(2)},${NODE_W / 2},${NODE_H / 2})`,
        "data-id": n.id,
      },
      nodeLayer
    );
    // Outer groups hold world position/rotation; inner content counter-scales on zoom-out to keep text readable.
    const inner = el("g", { class: "node-inner" }, group);

    // Use a chamfered panel silhouette instead of a rounded rectangle.
    const CHAMFER = 9;
    const panelPoints = [
      [CHAMFER, 0],
      [NODE_W, 0],
      [NODE_W, NODE_H - CHAMFER],
      [NODE_W - CHAMFER, NODE_H],
      [0, NODE_H],
      [0, CHAMFER],
    ]
      .map((p) => p.join(","))
      .join(" ");
    el("polygon", { class: "card", points: panelPoints }, inner);

    const accent = n.manual ? "var(--pin-manual)" : n.siteType === "search" ? "var(--pin-search)" : "var(--pin-default)";
    // Draw HUD brackets on the two square corners.
    const bracketStyle = { stroke: accent, style: `color: ${accent}` };
    el("path", { class: "hud-bracket", ...bracketStyle, d: `M${NODE_W - 20},2 L${NODE_W - 2},2 L${NODE_W - 2},20` }, inner);
    el("path", { class: "hud-bracket", ...bracketStyle, d: `M2,${NODE_H - 20} L2,${NODE_H - 2} L20,${NODE_H - 2}` }, inner);

    const titleText = truncate(n.title || n.domain || n.url, 26);
    const title = el("text", { class: "n-title", x: 14, y: 19 }, inner);
    title.textContent = titleText;
    const url = el("text", { class: "n-url", x: 14, y: 35 }, inner);
    url.textContent = truncate((n.domain || n.foundVia || n.url || ""), 26);
    // Add a PCB-trace accent below the URL.
    el("line", { class: "pcb-trace", x1: 14, y1: 39, x2: NODE_W - 16, y2: 39 }, inner);
    el("rect", { class: "pcb-pad", x: NODE_W - 18, y: 37, width: 4, height: 4 }, inner);

    // A card that starts a story (no incoming link) or is a search gets a bracketed date/time above it.
    if (!hasIncoming.has(n.id) || n.siteType === "search") {
      el("rect", { class: "time-bg", x: -12, y: -30, width: STAMP_W + 12, height: 24 }, inner);
      el("path", { class: "time-bracket", d: `M-12,${NODE_H + 4} L-12,-30 L${STAMP_W},-30` }, inner);
      el("text", { class: "n-stamp", x: -4, y: -14 }, inner).textContent = formatStamp(n.timestamp);
    }

    // Place badges below the card face to reduce clutter.
    const BADGE_Y = NODE_H + 13;
    let badgeX = 10;
    if (n.notes) {
      svgIcon(ASSET_ICONS.notes, badgeX, BADGE_Y - 12, 13, inner);
      badgeX += 18;
    }
    if (Array.isArray(n.downloads) && n.downloads.length) {
      svgIcon(ASSET_ICONS.download, badgeX, BADGE_Y - 12, 13, inner);
      const downloadCount = el(
        "text",
        { x: badgeX + 16, y: BADGE_Y, "font-size": 10.5, fill: "var(--string-translate)" },
        inner
      );
      downloadCount.textContent = String(n.downloads.length);
    }

    const visitCount = 1 + (revisitCounts.get(n.id) || 0);
    if (visitCount > 1) {
      el(
        "text",
        { class: "n-visits", x: NODE_W - 10, y: BADGE_Y, "text-anchor": "end" },
        inner
      ).textContent = `↻${visitCount}`;
    }

    // Below FAVICON_ONLY_K, hide card content and show a small favicon marker with a state ring.
    const iconMark = el("g", { class: "node-icon-mark" }, group);
    el("circle", { class: "node-icon-ring", cx: NODE_W / 2, cy: NODE_H / 2, r: 16 }, iconMark);
    const fallbackDot = el(
      "circle",
      { class: "node-favicon-fallback", cx: NODE_W / 2, cy: NODE_H / 2, r: 10, style: `fill:${accent}` },
      iconMark
    );
    if (n.favIconUrl) {
      fallbackDot.style.display = "none";
      const favImg = el(
        "image",
        {
          href: n.favIconUrl,
          x: NODE_W / 2 - 13,
          y: NODE_H / 2 - 13,
          width: 26,
          height: 26,
          preserveAspectRatio: "xMidYMid meet",
          class: "node-favicon-img",
        },
        iconMark
      );
      favImg.addEventListener("error", () => {
        favImg.remove();
        fallbackDot.style.display = "";
      });
    }

    nodeEls.set(n.id, { group, inner, tilt });

    group.style.cursor = linkMode ? "crosshair" : "grab";
    group.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return; // left button only
      // Stop bubbling: in link mode the event would reach the marquee handler, whose re-render destroys this element.
      ev.stopPropagation();
      svg.focus({ preventScroll: true }); // see the canvas mousedown handler for why this is needed explicitly
      if (linkMode) return; // click handler deals with link-mode logic; no drag here
      ev.preventDefault();

      // Dragging a selected card moves the whole group; otherwise select and move only that card.
      const additive = ev.shiftKey || ev.ctrlKey || ev.metaKey;
      const isGroupDrag = selectedNodeIds.has(n.id) && selectedNodeIds.size > 1;
      const ids = isGroupDrag ? Array.from(selectedNodeIds) : [n.id];
      if (!isGroupDrag && !additive) {
        selectedNodeIds = new Set([n.id]);
      }

      const startPositions = new Map();
      ids.forEach((id) => {
        const p = layoutPositions.get(id);
        if (p) startPositions.set(id, { x: p.x, y: p.y });
      });
      nodeDrag = {
        ids,
        startPositions,
        originWorld: {
          x: (ev.clientX - viewTransform.x) / viewTransform.k,
          y: (ev.clientY - viewTransform.y) / viewTransform.k,
        },
        originScreen: { x: ev.clientX, y: ev.clientY },
        moved: false,
      };
    });
    group.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (rightDragMoved) {
        rightDragMoved = false;
        return;
      }
      showNodeContextMenu(ev.clientX, ev.clientY, n.id);
    });
    group.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      if (linkMode) {
        handleLinkModeClick(n.id);
        return;
      }
      const now = performance.now();
      const isDoubleClick = n.id === lastClickNodeId && now - lastClickTime < DBLCLICK_MS;
      lastClickNodeId = isDoubleClick ? null : n.id; // a 3rd rapid click starts fresh, doesn't re-trigger
      lastClickTime = now;
      if (ev.shiftKey || ev.ctrlKey || ev.metaKey) {
        if (selectedNodeIds.has(n.id)) {
          selectedNodeIds.delete(n.id);
          // Marquee selection is group-only; clear individual focus while multiple cards are selected.
          selectedNodeId = null;
          document.getElementById("detail").innerHTML = '<div class="detail-placeholder">Select a node to see details.</div>';
          rerender();
        } else {
          selectedNodeIds.add(n.id);
          if (selectedNodeIds.size > 1) {
            // With multiple nodes selected, disable individual selection and focus highlighting.
            selectedNodeId = null;
            document.getElementById("detail").innerHTML = '<div class="detail-placeholder">Select a node to see details.</div>';
            rerender();
          } else {
            selectNode(n.id, byId, edges); // a single additive selection can still show its details
          }
        }
      } else {
        selectedNodeIds = new Set([n.id]);
        selectNode(n.id, byId, edges);
      }
      if (isDoubleClick) zoomToNode(n.id);
    });
    group.addEventListener("dblclick", (ev) => {
      ev.stopPropagation();
      if (linkMode) return; // let link-mode's own click flow handle it
      zoomToNode(n.id);
    });
  }
}

/**
 * Moves a card's element to its current layout position and re-routes the edges attached to it (used while
 * dragging).
 */
function repositionNode(id) {
  const pos = layoutPositions.get(id);
  if (!pos) return;
  const entry = nodeEls.get(id);
  if (entry) {
    entry.group.setAttribute(
      "transform",
      `translate(${pos.x},${pos.y}) rotate(${entry.tilt.toFixed(2)},${NODE_W / 2},${NODE_H / 2})`
    );
  }
  edgeEls.forEach((e) => {
    if (e.source !== id && e.target !== id) return;
    const s = layoutPositions.get(e.source);
    const t = layoutPositions.get(e.target);
    if (!s || !t) return;
    if (e.type === "navigation" || e.type === "revisit") {
      const d = edgePathD({ type: e.type, id: e.id }, s, t, edgeLanes.get(e.id) || 0);
      e.path.setAttribute("d", d);
      if (e.hitPath) e.hitPath.setAttribute("d", d);
    } else {
      const d = edgePathD({ type: e.type, id: e.id }, s, t, edgeLanes.get(e.id) || 0);
      e.path.setAttribute("d", d);
      if (e.hitPath) e.hitPath.setAttribute("d", d);
      if (e.label) {
        const { lx, ly } = edgeLabelPos(e, s, t, edgeLanes.get(e.id) || 0);
        e.label.setAttribute("transform", `translate(${lx},${ly})`);
      }
    }
  });
}

window.addEventListener("mousemove", (ev) => {
  if (!nodeDrag) return;
  if (!nodeDrag.moved) {
    const screenDx = ev.clientX - nodeDrag.originScreen.x;
    const screenDy = ev.clientY - nodeDrag.originScreen.y;
    if (Math.hypot(screenDx, screenDy) < DRAG_THRESHOLD_PX) return;
    nodeDrag.moved = true;
  }
  const curWorld = {
    x: (ev.clientX - viewTransform.x) / viewTransform.k,
    y: (ev.clientY - viewTransform.y) / viewTransform.k,
  };
  const dx = curWorld.x - nodeDrag.originWorld.x;
  const dy = curWorld.y - nodeDrag.originWorld.y;
  nodeDrag.ids.forEach((id) => {
    const start = nodeDrag.startPositions.get(id);
    if (!start) return;
    layoutPositions.set(id, { x: start.x + dx, y: start.y + dy });
    repositionNode(id);
  });
});

window.addEventListener("mouseup", async () => {
  if (!nodeDrag) return;
  const { ids, startPositions, moved } = nodeDrag;
  nodeDrag = null;
  if (moved) {
    suppressNextClick = true;
    const moves = [];
    for (const id of ids) {
      const newPos = layoutPositions.get(id);
      const oldPos = startPositions.get(id);
      if (!newPos) continue;
      await PivotDB.updateNode(id, { posX: newPos.x, posY: newPos.y });
      moves.push({ id, oldPos: oldPos ? { ...oldPos } : null, newPos: { ...newPos } });
    }
    if (moves.length) {
      pushUndo({
        label: "move card",
        undo: async () => {
          for (const m of moves) {
            if (m.oldPos) await PivotDB.updateNode(m.id, { posX: m.oldPos.x, posY: m.oldPos.y });
          }
        },
        redo: async () => {
          for (const m of moves) await PivotDB.updateNode(m.id, { posX: m.newPos.x, posY: m.newPos.y });
        },
      });
    }
    await loadAndRender(true);
  }
});

// ---------- Right-click context menu ----------
function closeContextMenu() {
  if (contextMenuEl) {
    contextMenuEl.remove();
    contextMenuEl = null;
  }
  window.removeEventListener("mousedown", outsideContextMenuClick, true);
  document.removeEventListener("keydown", contextMenuEscHandler);
}
function outsideContextMenuClick(e) {
  // Close the context menu only on outside clicks; closing on mousedown would cancel menu item clicks.
  if (contextMenuEl && !contextMenuEl.contains(e.target)) {
    closeContextMenu();
  }
}
function contextMenuEscHandler(e) {
  if (e.key === "Escape") closeContextMenu();
}
function buildContextMenu(clientX, clientY, items) {
  closeContextMenu();
  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.style.left = clientX + "px";
  menu.style.top = clientY + "px";

  items.forEach((item) => {
    const btn = document.createElement("button");
    btn.textContent = item.label;
    if (item.danger) btn.classList.add("danger-item");
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      closeContextMenu();
      item.onClick();
    });
    menu.appendChild(btn);
  });

  document.body.appendChild(menu);
  contextMenuEl = menu;

  // Clamp the context menu to the viewport.
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = window.innerWidth - rect.width - 8 + "px";
    if (rect.bottom > window.innerHeight) menu.style.top = window.innerHeight - rect.height - 8 + "px";
  });

  setTimeout(() => {
    window.addEventListener("mousedown", outsideContextMenuClick, true);
    document.addEventListener("keydown", contextMenuEscHandler);
  }, 0);
}

function startLinkFrom(nodeId) {
  linkMode = true;
  linkFirstNodeId = nodeId;
  linkModeBtn.classList.add("active");
  linkModeBtn.textContent = nodeId == null ? "Click two cards…" : "Click a second card…";
  svg.classList.add("linking");
  rerender();
}

function exitLinkMode() {
  linkMode = false;
  linkFirstNodeId = null;
  linkModeBtn.classList.remove("active");
  linkModeBtn.textContent = "+ Draw a connection";
  svg.classList.remove("linking");
  rerender();
}

/** These are the nodes reached by navigating from this node; use them for delete-cascade decisions. */
function getDescendantIds(nodeId, edges) {
  const children = new Map();
  edges
    .filter((e) => e.type === "navigation")
    .forEach((e) => {
      if (!children.has(e.source)) children.set(e.source, []);
      children.get(e.source).push(e.target);
    });
  const result = new Set();
  const stack = [nodeId];
  while (stack.length) {
    const cur = stack.pop();
    (children.get(cur) || []).forEach((child) => {
      if (!result.has(child)) {
        result.add(child);
        stack.push(child);
      }
    });
  }
  return result;
}

async function deleteNodeCascade(nodeId, includeDescendants) {
  const idsToDelete = [nodeId];
  if (includeDescendants) {
    getDescendantIds(nodeId, allEdges).forEach((id) => idsToDelete.push(id));
  }
  const snapshot = snapshotNodesAndEdges(idsToDelete);
  for (const id of idsToDelete) {
    await PivotDB.deleteNode(id);
  }
  pushUndo({
    label: "delete card",
    undo: () => restoreSnapshot(snapshot),
    redo: async () => {
      for (const id of idsToDelete) await PivotDB.deleteNode(id);
    },
  });
  if (selectedNodeId != null && idsToDelete.includes(selectedNodeId)) {
    selectedNodeId = null;
    document.getElementById("detail").innerHTML = '<div class="detail-placeholder">Select a node to see details.</div>';
  }
  selectedNodeIds = new Set();
  await loadAndRender(true);
}

function confirmDeleteNode(nodeId) {
  const descendantCount = getDescendantIds(nodeId, allEdges).size;
  const choices = [{ label: "Cancel" }];
  choices.push({
    label: descendantCount ? "Delete just this card" : "Delete this card",
    danger: true,
    onClick: () => deleteNodeCascade(nodeId, false),
  });
  if (descendantCount) {
    choices.push({
      label: `Delete this card + ${descendantCount} that came from it`,
      danger: true,
      onClick: () => deleteNodeCascade(nodeId, true),
    });
  }
  openChoiceModal({
    title: "Remove this card?",
    hint: descendantCount
      ? `${descendantCount} other card(s) were reached by browsing on from this one. You can remove just this card, or take those with it — either way, Ctrl+Z undoes it.`
      : "This removes the card and any strings connected to it (Ctrl+Z undoes it).",
    choices,
  });
}

async function deleteSelection(ids) {
  const snapshot = snapshotNodesAndEdges(ids);
  for (const id of ids) {
    await PivotDB.deleteNode(id);
  }
  pushUndo({
    label: "delete cards",
    undo: () => restoreSnapshot(snapshot),
    redo: async () => {
      for (const id of ids) await PivotDB.deleteNode(id);
    },
  });
  selectedNodeIds = new Set();
  if (selectedNodeId != null && ids.includes(selectedNodeId)) {
    selectedNodeId = null;
    document.getElementById("detail").innerHTML = '<div class="detail-placeholder">Select a node to see details.</div>';
  }
  await loadAndRender(true);
}

function confirmDeleteSelection(ids) {
  if (ids.length === 1) {
    confirmDeleteNode(ids[0]);
    return;
  }
  openChoiceModal({
    title: `Remove ${ids.length} selected cards?`,
    hint: "This removes exactly the selected cards and their connections — not their downstream browsing descendants (Ctrl+Z undoes it).",
    choices: [
      { label: "Cancel" },
      { label: `Delete ${ids.length} cards`, danger: true, onClick: () => deleteSelection(ids) },
    ],
  });
}

function showNodeContextMenu(clientX, clientY, nodeId) {
  const inMultiSelection = selectedNodeIds.has(nodeId) && selectedNodeIds.size > 1;
  buildContextMenu(clientX, clientY, [
    { label: "+ Draw a connection", onClick: () => startLinkFrom(nodeId) },
    {
      label: inMultiSelection ? `🗑 Delete ${selectedNodeIds.size} selected cards` : "🗑 Delete",
      danger: true,
      onClick: () => (inMultiSelection ? confirmDeleteSelection(Array.from(selectedNodeIds)) : confirmDeleteNode(nodeId)),
    },
  ]);
}

function showCanvasContextMenu(clientX, clientY) {
  buildContextMenu(clientX, clientY, [
    { label: "+ Pin a lead", onClick: () => openAddLeadModal() },
    { label: "+ Create a link", onClick: () => startLinkFrom(null) },
  ]);
}

function showEdgeContextMenu(clientX, clientY, edgeId) {
  buildContextMenu(clientX, clientY, [
    { label: "🗑 Delete this connection", danger: true, onClick: () => deleteEdgeWithUndo(edgeId) },
  ]);
}

function applyTransform(g) {
  g.setAttribute(
    "transform",
    `translate(${viewTransform.x},${viewTransform.y}) scale(${viewTransform.k})`
  );
}

/** Animate pan/zoom with requestAnimationFrame so ordinary drag and wheel updates remain immediate. */
let viewAnimFrame = null;
function animateViewTo(targetX, targetY, targetK, duration = 320) {
  if (viewAnimFrame != null) cancelAnimationFrame(viewAnimFrame);
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    viewTransform = { x: targetX, y: targetY, k: targetK };
    const g0 = document.getElementById("world");
    if (g0) applyTransform(g0);
    updateContentScale();
    scheduleCullSync();
    return;
  }
  const start = { ...viewTransform };
  const startTime = performance.now();
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  // Defer favicon-mode rerender until the glide ends to avoid replacing the animated world mid-flight.
  suppressFaviconRerender = true;
  function step(now) {
    const t = Math.min(1, (now - startTime) / duration);
    const e = easeOutCubic(t);
    viewTransform = {
      x: start.x + (targetX - start.x) * e,
      y: start.y + (targetY - start.y) * e,
      k: start.k + (targetK - start.k) * e,
    };
    // Refetch the target element each frame in case another rerender replaced it.
    const g = document.getElementById("world");
    if (g) applyTransform(g);
    updateContentScale();
    if (t < 1) {
      viewAnimFrame = requestAnimationFrame(step);
      return;
    }
    viewAnimFrame = null;
    suppressFaviconRerender = false;
    if (pendingFaviconRerender) {
      pendingFaviconRerender = false;
      rerender();
    } else {
      // Ensure the final view is rendered even when it lands outside the current cull region.
      scheduleCullSync();
    }
  }
  viewAnimFrame = requestAnimationFrame(step);
}

/** Double-click a card to center and zoom in; never zoom out below the current scale. */
const DBLCLICK_ZOOM_K = 1.6;
function zoomToNode(id) {
  const pos = layoutPositions.get(id);
  if (!pos) return;
  const rect = svg.getBoundingClientRect();
  const targetK = Math.min(2.5, Math.max(viewTransform.k, DBLCLICK_ZOOM_K));
  const cx = pos.x + NODE_W / 2;
  const cy = pos.y + NODE_H / 2;
  animateViewTo(rect.width / 2 - cx * targetK, rect.height / 2 - cy * targetK, targetK);
}

/** Below CONTENT_SCALE_FLOOR_K card content is counter-scaled; below FAVICON_ONLY_K only a favicon marker shows. */
const CONTENT_SCALE_FLOOR_K = 0.55;
const FAVICON_ONLY_K = 0.5;
/** Matches the .node-icon-ring's r=16 in the node-building loop. */
const ICON_WORLD_DIAMETER = 32;
const ICON_TARGET_PX = 40;
const ICON_SCALE_CAP = 6;
let lastFaviconMode = false;
let suppressFaviconRerender = false;
let pendingFaviconRerender = false;
function updateContentScale() {
  const factor = Math.max(1, CONTENT_SCALE_FLOOR_K / viewTransform.k);
  svg.style.setProperty("--content-scale", factor.toFixed(3));
  const inFaviconMode = viewTransform.k < FAVICON_ONLY_K;
  svg.classList.toggle("favicon-mode", inFaviconMode);
  if (inFaviconMode) {
    const iconFactor = Math.min(
      ICON_SCALE_CAP,
      ICON_TARGET_PX / (ICON_WORLD_DIAMETER * viewTransform.k)
    );
    svg.style.setProperty("--icon-scale", iconFactor.toFixed(3));
  }
  // Favicon mode targets card centers instead of edges, so crossing the threshold needs a rerender.
  if (inFaviconMode !== lastFaviconMode) {
    lastFaviconMode = inFaviconMode;
    if (allNodes.length) {
      if (suppressFaviconRerender) {
        pendingFaviconRerender = true;
      } else {
        rerender();
      }
    }
  }
}

/** Selection focus keeps the selected node and relevant incoming ancestry visible. */
function getSelectionFocusIds(selectedId, edges) {
  if (selectedId == null) return null;

  // Focus keeps the selection plus its incoming ancestry (navigation/pivot/translation); the rest is dimmed.
  const focus = new Set([selectedId]);
  const incoming = new Map();
  const allowedTypes = new Set(["navigation", "pivot", "translation"]);

  for (const e of edges) {
    if (!allowedTypes.has(e.type)) continue;
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target).push(e.source);
  }

  const queue = [selectedId];
  while (queue.length) {
    const cur = queue.shift();
    for (const source of incoming.get(cur) || []) {
      if (focus.has(source)) continue;
      focus.add(source);
      queue.push(source);
    }
  }

  return focus;
}

function selectionSoftClass(focusIds, sourceId, targetId) {
  if (!focusIds) return "";
  return (focusIds.has(sourceId) && focusIds.has(targetId)) ? "" : " selection-soft";
}

/** Selects a card and shows its details in the sidebar. */
function selectNode(id, byId, edges) {
  selectedNodeId = id;
  const n = byId.get(id);
  if (!n) return;
  const detail = document.getElementById("detail");
  detail.innerHTML = "";

  const card = document.createElement("div");
  card.className = "evidence-card";

  if (n.manual) {
    const tag = document.createElement("span");
    tag.className = "tag-manual";
    tag.textContent = "Manually added";
    card.appendChild(tag);
  }

  const topRow = document.createElement("div");
  topRow.className = "evidence-toprow";
  const titleWrap = document.createElement("div");
  titleWrap.className = "evidence-title-wrap";
  if (n.favIconUrl) {
    const favicon = document.createElement("img");
    favicon.className = "evidence-favicon";
    favicon.src = n.favIconUrl;
    favicon.alt = "";
    favicon.addEventListener("error", () => favicon.remove());
    titleWrap.appendChild(favicon);
  }
  const h2 = document.createElement("h2");
  h2.textContent = n.title || "(untitled)";
  titleWrap.appendChild(h2);
  const starBtn = document.createElement("button");
  starBtn.className = "star-btn" + (n.favorite ? " on" : "");
  starBtn.title = n.favorite ? "Remove from favorites" : "Mark as favorite";
  starBtn.textContent = n.favorite ? "★" : "☆";
  starBtn.addEventListener("click", async () => {
    await PivotDB.updateNode(id, { favorite: !n.favorite });
    await loadAndRender(true);
    selectNode(id, new Map(allNodes.map((x) => [x.id, x])), allEdges);
  });
  topRow.appendChild(titleWrap);
  topRow.appendChild(starBtn);
  card.appendChild(topRow);

  if (n.url) {
    const link = document.createElement("a");
    link.href = n.url;
    link.target = "_blank";
    link.className = "url";
    link.textContent = n.url;
    card.appendChild(link);
  }

  addRow(card, n.manual ? "Added" : "Visited", new Date(n.timestamp).toLocaleString());
  if (n.domain) addRow(card, "Domain", n.domain);
  if (n.transitionType) addRow(card, "Transition", n.transitionType);

  if (Array.isArray(n.downloads) && n.downloads.length) {
    const row = document.createElement("div");
    row.className = "detail-row";
    const l = document.createElement("div");
    l.className = "label";
    l.textContent = `Download(s) — ${n.downloads.length}`;
    row.appendChild(l);
    const list = document.createElement("ul");
    list.className = "downloads-list";
    n.downloads
      .slice()
      .sort((a, b) => b.timestamp - a.timestamp)
      .forEach((d) => {
        const li = document.createElement("li");
        li.textContent = d.filename;
        li.title = new Date(d.timestamp).toLocaleString();
        list.appendChild(li);
      });
    row.appendChild(list);
    card.appendChild(row);
  }

  const visitEdges = edges
    .filter((e) => e.target === id && (e.type === "navigation" || e.type === "revisit"))
    .slice()
    .sort((a, b) => b.timestamp - a.timestamp);
  if (visitEdges.length > 1) {
    const row = document.createElement("div");
    row.className = "detail-row";
    const l = document.createElement("div");
    l.className = "label";
    l.textContent = "Visit history";
    row.appendChild(l);
    visitEdges.forEach((ve) => {
      const src = byId.get(ve.source);
      const line = document.createElement("div");
      line.style.fontSize = "11px";
      line.style.marginTop = "3px";
      line.style.color = "var(--ink-dim)";
      line.textContent = `${new Date(ve.timestamp).toLocaleString()} — via ${
        src ? src.title || src.domain || src.url : "typed / new tab"
      }`;
      row.appendChild(line);
    });
    card.appendChild(row);
  }

  function chipRow(label, list, cls) {
    if (!list.length) return;
    const row = document.createElement("div");
    row.className = "detail-row";
    const l = document.createElement("div");
    l.className = "label";
    l.textContent = label;
    row.appendChild(l);
    list.forEach((e) => {
      const wrap = document.createElement("div");
      wrap.style.display = "flex";
      wrap.style.alignItems = "center";
      wrap.style.gap = "6px";
      wrap.style.marginTop = "4px";
      const chip = document.createElement("span");
      chip.className = cls;
      chip.textContent = `"${e.label || "(no label)"}"`;
      const rm = document.createElement("button");
      rm.className = "link-btn";
      rm.textContent = "✕";
      rm.title = "Remove this connection";
      rm.addEventListener("click", async () => {
        await deleteEdgeWithUndo(e.id);
        selectNode(id, new Map(allNodes.map((x) => [x.id, x])), allEdges);
      });
      wrap.appendChild(chip);
      wrap.appendChild(rm);
      row.appendChild(wrap);
    });
    card.appendChild(row);
  }

  chipRow("Pivoted from", edges.filter((e) => e.type === "pivot" && e.target === id), "pivot-chip");
  chipRow("Led to search pivot(s)", edges.filter((e) => e.type === "pivot" && e.source === id), "pivot-chip");
  chipRow("Translated from", edges.filter((e) => e.type === "translation" && e.target === id), "translate-chip");
  chipRow("Sent to translator", edges.filter((e) => e.type === "translation" && e.source === id), "translate-chip");
  chipRow("Connected from", edges.filter((e) => e.type === "manual" && e.target === id), "manual-chip");
  chipRow("Connected to", edges.filter((e) => e.type === "manual" && e.source === id), "manual-chip");

  const notesRow = document.createElement("div");
  notesRow.className = "detail-row";
  const notesLabel = document.createElement("div");
  notesLabel.className = "label";
  notesLabel.textContent = "Notes";
  const notesBox = document.createElement("textarea");
  notesBox.className = "notes-box";
  notesBox.placeholder = "Add your own notes about this lead…";
  notesBox.value = n.notes || "";
  let saveTimer = null;
  notesBox.addEventListener("input", () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      await PivotDB.updateNode(id, { notes: notesBox.value });
      await loadAndRender(true); // refreshes the 🖉 note indicator on the board without touching this textarea
    }, 600);
  });
  notesRow.appendChild(notesLabel);
  notesRow.appendChild(notesBox);
  card.appendChild(notesRow);

  const delBtn = document.createElement("button");
  delBtn.className = "link-btn";
  delBtn.style.marginTop = "10px";
  delBtn.style.display = "block";
  delBtn.textContent = "🗑 Delete this card";
  delBtn.addEventListener("click", () => confirmDeleteNode(id));
  card.appendChild(delBtn);

  detail.appendChild(card);
  rerender();
}

function addRow(parent, label, value) {
  const row = document.createElement("div");
  row.className = "detail-row";
  const l = document.createElement("div");
  l.className = "label";
  l.textContent = label;
  const v = document.createElement("div");
  v.className = "value";
  v.textContent = value;
  row.appendChild(l);
  row.appendChild(v);
  parent.appendChild(row);
}

/** Use a simple option-only modal for confirmations without form fields. */
function openChoiceModal({ title, hint, choices }) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const modalCard = document.createElement("div");
  modalCard.className = "modal-card";

  const h3 = document.createElement("h3");
  h3.textContent = title;
  modalCard.appendChild(h3);

  if (hint) {
    const p = document.createElement("p");
    p.className = "modal-hint";
    p.textContent = hint;
    modalCard.appendChild(p);
  }

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  actions.style.flexWrap = "wrap";
  const buttons = [];
  choices.forEach((choice) => {
    const btn = document.createElement("button");
    btn.textContent = choice.label;
    if (choice.danger) btn.className = "danger";
    btn.addEventListener("click", () => {
      close();
      if (choice.onClick) choice.onClick();
    });
    buttons.push(btn);
    actions.appendChild(btn);
  });
  // Arrow keys cycle focus through choice buttons.
  actions.addEventListener("keydown", (e) => {
    if (e.target.tagName !== "BUTTON") return;
    const idx = buttons.indexOf(e.target);
    if (idx === -1) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      buttons[(idx + 1) % buttons.length].focus();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      buttons[(idx - 1 + buttons.length) % buttons.length].focus();
    }
  });
  modalCard.appendChild(actions);
  overlay.appendChild(modalCard);
  document.body.appendChild(overlay);

  function close() {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  }
  function onKey(e) {
    if (e.key === "Escape") close();
  }
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  // Focus the first choice when the dialog opens.
  if (buttons[0]) setTimeout(() => buttons[0].focus(), 30);
}

function openModal({ title, hint, fields, submitLabel, onSubmit }) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const modalCard = document.createElement("div");
  modalCard.className = "modal-card";

  const h3 = document.createElement("h3");
  h3.textContent = title;
  modalCard.appendChild(h3);

  if (hint) {
    const p = document.createElement("p");
    p.className = "modal-hint";
    p.textContent = hint;
    modalCard.appendChild(p);
  }

  const inputs = {};
  fields.forEach((f) => {
    const wrap = document.createElement("div");
    wrap.className = "modal-field";
    if (f.type !== "checkbox") {
      const label = document.createElement("label");
      label.textContent = f.label;
      wrap.appendChild(label);
    }
    let input;
    if (f.type === "select") {
      input = document.createElement("select");
      f.options.forEach((opt) => {
        const o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.label;
        input.appendChild(o);
      });
    } else if (f.type === "textarea") {
      input = document.createElement("textarea");
    } else if (f.type === "checkbox") {
      const checkLabel = document.createElement("label");
      checkLabel.style.display = "flex";
      checkLabel.style.alignItems = "center";
      checkLabel.style.gap = "6px";
      checkLabel.style.cursor = "pointer";
      input = document.createElement("input");
      input.type = "checkbox";
      checkLabel.appendChild(input);
      checkLabel.appendChild(document.createTextNode(f.label));
      wrap.appendChild(checkLabel);
    } else {
      input = document.createElement("input");
      input.type = f.type || "text";
    }
    if (f.placeholder) input.placeholder = f.placeholder;
    if (f.value !== undefined) {
      if (f.type === "checkbox") input.checked = !!f.value;
      else input.value = f.value;
    }
    if (f.type !== "checkbox") wrap.appendChild(input);
    modalCard.appendChild(wrap);
    inputs[f.key] = input;
  });

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", close);
  const submitBtn = document.createElement("button");
  submitBtn.className = "primary";
  submitBtn.textContent = submitLabel || "Save";
  submitBtn.addEventListener("click", () => {
    const values = {};
    for (const k in inputs) {
      values[k] = inputs[k].type === "checkbox" ? inputs[k].checked : inputs[k].value;
    }
    close();
    onSubmit(values);
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(submitBtn);
  actions.addEventListener("keydown", (e) => {
    if (e.target.tagName !== "BUTTON") return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      (e.target === cancelBtn ? submitBtn : cancelBtn).focus();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      (e.target === submitBtn ? cancelBtn : submitBtn).focus();
    }
  });
  modalCard.appendChild(actions);
  overlay.appendChild(modalCard);
  document.body.appendChild(overlay);

  function close() {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  }
  function onKey(e) {
    if (e.key === "Escape") close();
    if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") submitBtn.click();
  }
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  const firstKey = fields[0] && fields[0].key;
  if (firstKey && inputs[firstKey]) setTimeout(() => inputs[firstKey].focus(), 30);
}

/** Opens the modal for pinning a lead (something found outside the browser) as a manual card. */
function openAddLeadModal() {
  openModal({
    title: "Pin a lead",
    hint: "Add something you found outside the browser — a document, a phone number, a name from a leak, anything worth tracking on the board.",
    fields: [
      { key: "title", label: "Title", type: "text", placeholder: "e.g. Phone number found in leaked DB" },
      { key: "url", label: "URL (optional)", type: "text", placeholder: "https://…" },
      { key: "notes", label: "Notes (optional)", type: "textarea" },
      { key: "favorite", label: "Mark as favorite", type: "checkbox" },
    ],
    submitLabel: "Pin it",
    onSubmit: async (v) => {
      const title = (v.title || "").trim();
      const url = (v.url || "").trim();
      if (!title && !url) return;
      let domain = "manual entry";
      if (url) {
        try {
          domain = new URL(url).hostname;
        } catch {
          /* not a valid URL, leave the generic label */
        }
      }
      const nodeData = {
        title: title || url,
        url,
        domain,
        timestamp: Date.now(),
        manual: true,
        notes: (v.notes || "").trim(),
        favorite: !!v.favorite,
      };
      const newId = await PivotDB.addNode(nodeData);
      pushUndo({
        label: "add card",
        undo: () => PivotDB.deleteNode(newId),
        redo: () => PivotDB.addNode({ ...nodeData, id: newId }),
      });
      await loadAndRender(true);
    },
  });
}
document.getElementById("btnAddNode").addEventListener("click", openAddLeadModal);

/** "Draw a connection" button: toggles link mode. */
const linkModeBtn = document.getElementById("btnLinkMode");
linkModeBtn.addEventListener("click", () => {
  if (linkMode) {
    exitLinkMode();
  } else {
    startLinkFrom(null);
  }
});

function handleLinkModeClick(nodeId) {
  if (linkFirstNodeId === null) {
    linkFirstNodeId = nodeId;
    rerender();
    return;
  }
  if (linkFirstNodeId === nodeId) {
    linkFirstNodeId = null;
    rerender();
    return;
  }
  const sourceId = linkFirstNodeId;
  const targetId = nodeId;
  exitLinkMode(); // one connection per activation — re-click "Draw a connection" for another
  openModal({
    title: "Label this connection",
    hint: "This pins a string between the two cards you just selected.",
    fields: [
      {
        key: "type",
        label: "Type",
        type: "select",
        options: [
          { value: "pivot", label: "Pivot — found here, searched here" },
          { value: "translation", label: "Translation" },
          { value: "manual", label: "Related / note" },
        ],
      },
      { key: "label", label: "Label (optional)", type: "text", placeholder: "e.g. shared phone number" },
    ],
    submitLabel: "Pin the string",
    onSubmit: async (v) => {
      const edgeData = {
        source: sourceId,
        target: targetId,
        type: v.type,
        label: (v.label || "").trim(),
        timestamp: Date.now(),
      };
      const newId = await PivotDB.addEdge(edgeData);
      pushUndo({
        label: "add connection",
        undo: () => PivotDB.deleteEdge(newId),
        redo: () => PivotDB.addEdge({ ...edgeData, id: newId }),
      });
      // Disable link mode after one connection; re-enable it for the next.
      linkMode = false;
      linkModeBtn.classList.remove("active");
      linkModeBtn.textContent = "+ Draw a connection";
      svg.classList.remove("linking");
      await loadAndRender(true);
    },
  });
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && linkMode) {
    exitLinkMode();
  }
  const activeTag = document.activeElement && document.activeElement.tagName;
  const inTextField = activeTag === "INPUT" || activeTag === "TEXTAREA" || activeTag === "SELECT";
  if (e.key === "Delete") {
    // Ignore Delete while focus is inside editable text.
    if (inTextField) return;
    if (selectedNodeIds.size > 1) {
      confirmDeleteSelection(Array.from(selectedNodeIds));
    } else if (selectedNodeId != null) {
      confirmDeleteNode(selectedNodeId);
    }
  }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !inTextField) {
    const key = e.key.toLowerCase();
    if (key === "z" && !e.shiftKey) {
      e.preventDefault();
      performUndo();
    } else if (key === "y" || (key === "z" && e.shiftKey)) {
      e.preventDefault();
      performRedo();
    } else if (key === "a") {
      e.preventDefault();
      selectedNodeIds = new Set(allNodes.map((n) => n.id));
      rerender();
    }
  }
});

/** Right-drag pans; left-drag on empty space selects a marquee; a stationary left click deselects. */
let dragging = false, dragStart = null;

svg.addEventListener("contextmenu", (e) => {
  // Ignore context-menu handling during a right-drag pan.
  e.preventDefault();
  if (rightDragMoved) {
    rightDragMoved = false;
    return;
  }
  showCanvasContextMenu(e.clientX, e.clientY);
});

svg.addEventListener("mousedown", (e) => {
  e.preventDefault(); // stops the browser starting a text-selection drag across card titles
  svg.focus({ preventScroll: true }); // preventDefault() blocks native focus; without this, Delete/Ctrl+Z are ignored while the search box has it
  if (e.button === 2) {
    // right button: pan
    dragging = true;
    rightDragMoved = false;
    dragStart = { x: e.clientX - viewTransform.x, y: e.clientY - viewTransform.y };
    svg.classList.add("grabbing");
  } else if (e.button === 0) {
    // Arm marquee selection on left-drag over empty space; activate it only after DRAG_THRESHOLD_PX movement.
    const rect = svg.getBoundingClientRect();
    marquee = {
      x0: e.clientX - rect.left,
      y0: e.clientY - rect.top,
      x1: e.clientX - rect.left,
      y1: e.clientY - rect.top,
      moved: false,
    };
  }
});

function updateMarqueeBox() {
  if (!marquee) return;
  const box = document.getElementById("selectionBox");
  const x = Math.min(marquee.x0, marquee.x1);
  const y = Math.min(marquee.y0, marquee.y1);
  const w = Math.abs(marquee.x1 - marquee.x0);
  const h = Math.abs(marquee.y1 - marquee.y0);
  box.style.left = x + "px";
  box.style.top = y + "px";
  box.style.width = w + "px";
  box.style.height = h + "px";
}

window.addEventListener("mousemove", (e) => {
  if (dragging) {
    if (!rightDragMoved) {
      const screenDx = e.clientX - (dragStart.x + viewTransform.x);
      const screenDy = e.clientY - (dragStart.y + viewTransform.y);
      if (Math.hypot(screenDx, screenDy) >= DRAG_THRESHOLD_PX) rightDragMoved = true;
    }
    viewTransform.x = e.clientX - dragStart.x;
    viewTransform.y = e.clientY - dragStart.y;
    const g = document.getElementById("world");
    if (g) applyTransform(g);
    scheduleCullSync();
  } else if (marquee) {
    const rect = svg.getBoundingClientRect();
    const nx1 = e.clientX - rect.left;
    const ny1 = e.clientY - rect.top;
    if (!marquee.moved) {
      if (Math.hypot(nx1 - marquee.x0, ny1 - marquee.y0) < DRAG_THRESHOLD_PX) return;
      marquee.moved = true;
      document.getElementById("selectionBox").classList.remove("hidden");
    }
    marquee.x1 = nx1;
    marquee.y1 = ny1;
    updateMarqueeBox();
  }
});

window.addEventListener("mouseup", () => {
  if (dragging) {
    dragging = false;
    svg.classList.remove("grabbing");
  }
  if (marquee) {
    const box = document.getElementById("selectionBox");
    box.classList.add("hidden");
    if (marquee.moved) {
      // Convert the marquee rectangle from screen space to world space.
      const sx0 = Math.min(marquee.x0, marquee.x1);
      const sy0 = Math.min(marquee.y0, marquee.y1);
      const sx1 = Math.max(marquee.x0, marquee.x1);
      const sy1 = Math.max(marquee.y0, marquee.y1);
      const wx0 = (sx0 - viewTransform.x) / viewTransform.k;
      const wy0 = (sy0 - viewTransform.y) / viewTransform.k;
      const wx1 = (sx1 - viewTransform.x) / viewTransform.k;
      const wy1 = (sy1 - viewTransform.y) / viewTransform.k;
      const picked = new Set();
      let lastPickedId = null;
      layoutPositions.forEach((pos, id) => {
        const overlaps = pos.x < wx1 && pos.x + NODE_W > wx0 && pos.y < wy1 && pos.y + NODE_H > wy0;
        if (overlaps) {
          picked.add(id);
          lastPickedId = id;
        }
      });
      selectedNodeIds = picked;
      // Marquee selection is always group-only; do not promote the last card to individual focus.
      selectedNodeId = null;
      document.getElementById("detail").innerHTML = '<div class="detail-placeholder">Select a node to see details.</div>';
      rerender();
    } else {
      // A stationary click on empty space deselects everything, including the sidebar.
      selectedNodeIds = new Set();
      selectedNodeId = null;
      document.getElementById("detail").innerHTML = '<div class="detail-placeholder">Select a node to see details.</div>';
      rerender();
    }
    marquee = null;
  }
});

svg.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = svg.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  const delta = e.deltaY < 0 ? 1.08 : 0.92;
  const newK = Math.min(MAX_ZOOM_K, Math.max(MIN_ZOOM_K, viewTransform.k * delta));

  // Keep the world point under the cursor fixed while zooming.
  const worldX = (mouseX - viewTransform.x) / viewTransform.k;
  const worldY = (mouseY - viewTransform.y) / viewTransform.k;
  viewTransform.x = mouseX - worldX * newK;
  viewTransform.y = mouseY - worldY * newK;
  viewTransform.k = newK;

  const g = document.getElementById("world");
  if (g) applyTransform(g);
  updateContentScale();
  scheduleCullSync();
}, { passive: false });

function fitViewToGraph(animate = true) {
  const g = document.getElementById("world");
  const rect = svg.getBoundingClientRect();
  if (!g || !rect.width || !rect.height || !layoutPositions.size) return;

  // Fit the laid-out graph instead of resetting to a fixed 1:1 transform.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pos of layoutPositions.values()) {
    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x + NODE_W);
    maxY = Math.max(maxY, pos.y + NODE_H);
  }
  if (!Number.isFinite(minX)) return;

  const pad = 56;
  const graphW = Math.max(1, maxX - minX);
  const graphH = Math.max(1, maxY - minY);
  const availableW = Math.max(1, rect.width - pad * 2);
  const availableH = Math.max(1, rect.height - pad * 2);

  // Keep small graphs readable and allow large graphs to zoom out until they fit, bounded by MIN_ZOOM_K.
  const targetK = Math.min(1.35, Math.max(MIN_ZOOM_K, Math.min(availableW / graphW, availableH / graphH)));
  const targetX = (rect.width - graphW * targetK) / 2 - minX * targetK;
  const targetY = (rect.height - graphH * targetK) / 2 - minY * targetK;

  if (animate) {
    animateViewTo(targetX, targetY, targetK, 360);
  } else {
    viewTransform = { x: targetX, y: targetY, k: targetK };
    applyTransform(g);
    updateContentScale();
    scheduleCullSync();
  }
}

document.getElementById("btnFit").addEventListener("click", () => fitViewToGraph(true));

document.getElementById("btnUndo").addEventListener("click", performUndo);
document.getElementById("btnRedo").addEventListener("click", performRedo);
document.getElementById("btnZoomSelected").addEventListener("click", () => {
  if (selectedNodeId != null) zoomToNode(selectedNodeId);
});

const sidePanel = document.getElementById("sidePanel");
const sidePanelToggle = document.getElementById("sidePanelToggle");
sidePanelToggle.addEventListener("click", () => {
  const open = sidePanel.classList.toggle("open");
  sidePanelToggle.classList.toggle("open", open);
  sidePanelToggle.textContent = open ? "‹" : "›";
  sidePanelToggle.title = open ? "Hide tools" : "Tools";
});

document.getElementById("btnAutoArrange").addEventListener("click", async () => {
  const btn = document.getElementById("btnAutoArrange");
  if (allNodes.length < 2) return;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "Arranging…";
  // Yield once so the button label can repaint before synchronous layout.
  await new Promise((r) => setTimeout(r, 20));

  const before = allNodes.map((n) => ({ id: n.id, posX: n.posX ?? null, posY: n.posY ?? null }));
  const positions = runAlignedLayout(allNodes, allEdges, { stackVertically: true });
  const after = [];
  for (const node of allNodes) {
    const p = positions.get(node.id);
    if (!p) continue;
    await PivotDB.updateNode(node.id, { posX: p.x, posY: p.y });
    after.push({ id: node.id, posX: p.x, posY: p.y });
  }
  pushUndo({
    label: "vertical layout",
    undo: async () => {
      for (const b of before) await PivotDB.updateNode(b.id, { posX: b.posX, posY: b.posY });
    },
    redo: async () => {
      for (const a of after) await PivotDB.updateNode(a.id, { posX: a.posX, posY: a.posY });
    },
  });

  btn.disabled = false;
  btn.textContent = original;
  await loadAndRender(true);
  fitViewToGraph(true);
});

document.getElementById("btnResetLayout").addEventListener("click", async () => {
  const before = allNodes
    .filter((n) => n.posX != null || n.posY != null)
    .map((n) => ({ id: n.id, posX: n.posX, posY: n.posY }));
  for (const b of before) {
    await PivotDB.updateNode(b.id, { posX: null, posY: null });
  }
  if (before.length) {
    pushUndo({
      label: "horizontal layout",
      undo: async () => {
        for (const b of before) await PivotDB.updateNode(b.id, { posX: b.posX, posY: b.posY });
      },
      redo: async () => {
        for (const b of before) await PivotDB.updateNode(b.id, { posX: null, posY: null });
      },
    });
  }
  await loadAndRender(true);
  fitViewToGraph(true);
});

// ---------- Filters ----------
function rerender() {
  updateFilterSpotlight();
  render(
    allNodes,
    allEdges,
    document.getElementById("search").value,
    document.getElementById("onlyPivots").checked,
    document.getElementById("onlyFavorites").checked
  );
  // Keep the selection-dependent control state synchronized after rerendering.
  document.getElementById("btnZoomSelected").disabled = selectedNodeId == null;
}
/** Search input only restyles existing elements and is debounced; visibility filters still rerender. */
let searchDebounceTimer = null;
const SEARCH_DEBOUNCE_MS = 180;
document.getElementById("search").addEventListener("input", () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(applySearchHighlight, SEARCH_DEBOUNCE_MS);
});
document.getElementById("onlyPivots").addEventListener("change", rerender);
document.getElementById("onlyFavorites").addEventListener("change", rerender);

// ---------- Export ----------
document.getElementById("btnExportJson").addEventListener("click", () => {
  const payload = { exportedAt: new Date().toISOString(), nodes: allNodes, edges: allEdges };
  downloadFile(
    `pivot-tree-${Date.now()}.json`,
    JSON.stringify(payload, null, 2),
    "application/json"
  );
});

document.getElementById("btnExportReport").addEventListener("click", () => {
  browser.tabs.create({ url: browser.runtime.getURL("report.html") });
});

/** Import: opens the file picker for a JSON export. */
document.getElementById("btnImport").addEventListener("click", () => {
  document.getElementById("importFile").click();
});
document.getElementById("importFile").addEventListener("change", async (ev) => {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = ""; // reset so re-selecting the same file still fires 'change'
  if (!file) return;

  let data;
  try {
    const text = await file.text();
    data = JSON.parse(text);
  } catch (err) {
    openChoiceModal({
      title: "Couldn't read that file",
      hint: `This doesn't look like valid JSON (${err.message}). Use a file exported from this extension's "Export JSON" button.`,
      choices: [{ label: "OK" }],
    });
    return;
  }
  if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
    openChoiceModal({
      title: "Not a Urd export",
      hint: 'Expected an object with "nodes" and "edges" arrays, like the file "Export JSON" produces.',
      choices: [{ label: "OK" }],
    });
    return;
  }

  openChoiceModal({
    title: "Import case file",
    hint: `Found ${data.nodes.length} card(s) and ${data.edges.length} connection(s) in this file. Add them to the current board, or start fresh from this file?`,
    choices: [
      { label: "Cancel" },
      { label: "Merge into current board", onClick: () => importData(data, "merge") },
      { label: "Replace current board", danger: true, onClick: () => importData(data, "replace") },
    ],
  });
});

async function importData(data, mode) {
  if (mode === "replace") {
    await PivotDB.clearAll();
  }
  // Insert imported nodes with new ids and remap edge endpoints.
  const idMap = new Map();
  for (const n of data.nodes) {
    const { id: oldId, ...rest } = n;
    if (!rest.urlKey && rest.url) rest.urlKey = normalizeUrlKey(rest.url);
    const newId = await PivotDB.addNode(rest);
    idMap.set(oldId, newId);
  }
  let skipped = 0;
  for (const e of data.edges) {
    const { id: oldId, ...rest } = e;
    const source = idMap.get(e.source);
    const target = idMap.get(e.target);
    if (source == null || target == null) {
      skipped++;
      continue;
    }
    await PivotDB.addEdge({ ...rest, source, target });
  }
  await loadAndRender(true);
  if (skipped) {
    console.warn(`Import: skipped ${skipped} edge(s) referencing nodes not present in the file.`);
  }
}

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------- Init ----------
/**
 * Reloads nodes and edges and re-renders when something changed.
 * @param {boolean} [force=false] Re-render even when the counts are unchanged (favorite, notes, or one edge swap would otherwise be missed).
 * @returns {boolean} Whether the node/edge counts changed.
 */
async function loadAndRender(force = false) {
  const nodes = await PivotDB.getAllNodes();
  const edges = await PivotDB.getAllEdges();
  const changed = nodes.length !== allNodes.length || edges.length !== allEdges.length;
  allNodes = nodes;
  allEdges = edges;
  document.getElementById("rangeLabel").textContent =
    `${allNodes.length} pages · ${allEdges.filter((e) => e.type === "pivot").length} pivots · ${allEdges.filter((e) => e.type === "translation").length} translations`;
  if (changed || force) rerender();
  return changed;
}

// ---------- Background dot grid ----------
/**
 * Two canvases: #dotBg (grid + artwork) is drawn once per resize; #dotFx (spotlight + twinkles) is redrawn only
 * while something animates.
 */
const DOT_SPACING = 10;
const DOT_RADIUS = 1.5;
const DOT_REST_RGBA = [71, 72, 74, 0.55];
const DOT_SPOTLIGHT_RGBA = [255, 241, 113, 0.99];
const DOT_GLOW_FROM_RGBA = [150, 155, 160, 0.55];
const DOT_GLOW_PEAK_RGBA = [255, 154, 162, 1];
const DOT_GLOW_PEAK_RADIUS = 2.1;
/** Fraction of the pulse at which the dot is brightest. */
const DOT_GLOW_PEAK_AT = 0.45;
const DOT_GLOW_SHADOW_RGB = "255, 59, 78";
const DOT_TWINKLE_INTERVAL_MS = 300;
const DOT_TWINKLE_MIN_PER_TICK = 1;
const DOT_TWINKLE_MAX_PER_TICK = 4;
const DOT_TWINKLE_MIN_MS = 2600;
const DOT_TWINKLE_SPREAD_MS = 2200;
/** Minimum milliseconds between effect frames (~30 fps is plenty for slow pulses). */
const DOT_FX_FRAME_MS = 33;
const SPOTLIGHT_FADE_MS = 350;

/**
 * Spotlight point in urd.png's pixel space (her eye), lit while a filter is active and mapped to board
 * coordinates per render.
 * assets/urd.png is 546x546.
 */
const SPOTLIGHT_IMG_SIZE = 546;
const SPOTLIGHT_IMG_X = 263;
const SPOTLIGHT_IMG_Y = 72;
const SPOTLIGHT_RADIUS = 25;

const dotBgCanvas = document.getElementById("dotBg");
const dotFxCanvas = document.getElementById("dotFx");
const figureImg = new Image();
figureImg.addEventListener("load", () => renderDotBackground());
figureImg.src = "assets/urd.png";

let dotW = 0;
let dotH = 0;
let dotDpr = 1;
let dotCols = 0;
let dotRows = 0;
/** Dots that light up while a filter is active: [{ x, y }]. */
let spotlightDots = [];
/** Pulses in flight: [{ x, y, key, start, dur }]. */
let twinkles = [];
let twinkleKeys = new Set();
let twinkleTimer = null;
let dotFxFrame = null;
let dotFxLastDraw = 0;
/** Spotlight state: 0 = resting colour, 1 = fully lit. */
let spotValue = 0;
let spotTarget = 0;
let spotFrom = 0;
let spotStart = 0;

function mixRgba(a, b, p) {
  const ch = (i) => Math.round(a[i] + (b[i] - a[i]) * p);
  return `rgba(${ch(0)},${ch(1)},${ch(2)},${(a[3] + (b[3] - a[3]) * p).toFixed(3)})`;
}
/** Ease-in-out curve for p in [0, 1]. */
const smooth = (p) => p * p * (3 - 2 * p);

function updateFilterSpotlight() {
  const active =
    !!document.getElementById("search").value.trim() ||
    document.getElementById("onlyPivots").checked ||
    document.getElementById("onlyFavorites").checked;
  const target = active ? 1 : 0;
  if (target === spotTarget) return;
  spotTarget = target;
  spotFrom = spotValue;
  spotStart = performance.now();
  ensureDotFx();
}

function renderDotBackground() {
  const wrap = document.getElementById("canvasWrap");
  const w = wrap.clientWidth || window.innerWidth;
  const h = wrap.clientHeight || window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  dotW = w;
  dotH = h;
  dotDpr = dpr;
  for (const c of [dotBgCanvas, dotFxCanvas]) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    c.style.width = w + "px";
    c.style.height = h + "px";
  }

  dotCols = Math.ceil(w / DOT_SPACING) + 1;
  dotRows = Math.ceil(h / DOT_SPACING) + 1;

  const figureW = Math.min(560, w * 0.42);
  const figureH = figureW; // urd.png is square
  const figureX = -40;
  const figureY = h - figureH - 10;

  // Map the artwork-space spotlight point to board coordinates for this render.
  const spotlightX = figureX + (SPOTLIGHT_IMG_X / SPOTLIGHT_IMG_SIZE) * figureW;
  const spotlightY = figureY + (SPOTLIGHT_IMG_Y / SPOTLIGHT_IMG_SIZE) * figureH;

  const ctx = dotBgCanvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // One path for the resting dots, one for the reveal windows over the artwork.
  const restPath = new Path2D();
  const windowPath = new Path2D();
  spotlightDots = [];
  for (let gy = 0; gy <= dotRows; gy++) {
    for (let gx = 0; gx <= dotCols; gx++) {
      const cx = gx * DOT_SPACING;
      const cy = gy * DOT_SPACING;
      const dx = cx - spotlightX;
      const dy = cy - spotlightY;
      const a = Math.atan2(dy, dx);
      const starRadius = SPOTLIGHT_RADIUS * (0.45 + 0.6 * Math.abs(Math.cos(2 * a)));
      if (Math.hypot(dx, dy) < starRadius) {
        spotlightDots.push({ x: cx, y: cy });
      } else {
        restPath.moveTo(cx + DOT_RADIUS, cy);
        restPath.arc(cx, cy, DOT_RADIUS, 0, Math.PI * 2);
      }
      // Mask window only where the artwork sits; dots elsewhere can never reveal anything.
      if (cx >= figureX && cx <= figureX + figureW && cy >= figureY && cy <= figureY + figureH) {
        windowPath.moveTo(cx + DOT_RADIUS + 0.6, cy);
        windowPath.arc(cx, cy, DOT_RADIUS + 0.6, 0, Math.PI * 2);
      }
    }
  }

  // The artwork shows only through the dot grid: each dot is a small window.
  if (figureImg.complete && figureImg.naturalWidth) {
    ctx.save();
    ctx.clip(windowPath);
    ctx.globalAlpha = 0.75;
    ctx.drawImage(figureImg, figureX, figureY, figureW, figureH);
    ctx.restore();
  }

  ctx.fillStyle = `rgba(${DOT_REST_RGBA.join(",")})`;
  ctx.fill(restPath);

  twinkles = [];
  twinkleKeys = new Set();
  drawDotFx(performance.now());
  restartTwinkle();
}

function drawDotFx(now) {
  const ctx = dotFxCanvas.getContext("2d");
  ctx.setTransform(dotDpr, 0, 0, dotDpr, 0, 0);
  ctx.clearRect(0, 0, dotW, dotH);

  // Spotlight dots fade between resting and lit colour.
  const fade = Math.min(1, (now - spotStart) / SPOTLIGHT_FADE_MS);
  spotValue = spotFrom + (spotTarget - spotFrom) * smooth(fade);
  if (spotlightDots.length) {
    const path = new Path2D();
    for (const d of spotlightDots) {
      path.moveTo(d.x + DOT_RADIUS, d.y);
      path.arc(d.x, d.y, DOT_RADIUS, 0, Math.PI * 2);
    }
    ctx.fillStyle = mixRgba(DOT_REST_RGBA, DOT_SPOTLIGHT_RGBA, spotValue);
    ctx.fill(path);
  }

  // Twinkles: grey -> pink with a red glow at DOT_GLOW_PEAK_AT, then back.
  twinkles = twinkles.filter((t) => {
    if (now - t.start < t.dur) return true;
    twinkleKeys.delete(t.key);
    return false;
  });
  for (const t of twinkles) {
    const f = (now - t.start) / t.dur;
    const p = smooth(f < DOT_GLOW_PEAK_AT ? f / DOT_GLOW_PEAK_AT : (1 - f) / (1 - DOT_GLOW_PEAK_AT));
    const r = DOT_RADIUS + (DOT_GLOW_PEAK_RADIUS - DOT_RADIUS) * p;
    ctx.save();
    ctx.shadowColor = `rgba(${DOT_GLOW_SHADOW_RGB},${(0.9 * p).toFixed(3)})`;
    ctx.shadowBlur = 4 * dotDpr; // shadowBlur ignores the context transform
    ctx.fillStyle = mixRgba(DOT_GLOW_FROM_RGBA, DOT_GLOW_PEAK_RGBA, p);
    ctx.beginPath();
    ctx.arc(t.x, t.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

/** Runs only while a pulse or the spotlight fade is in flight, and never in a hidden tab. */
function stepDotFx(now) {
  dotFxFrame = null;
  const busy = twinkles.length > 0 || now - spotStart < SPOTLIGHT_FADE_MS;
  // Throttle to DOT_FX_FRAME_MS, but always draw the final frame so the fade lands exactly.
  if (!busy || now - dotFxLastDraw >= DOT_FX_FRAME_MS) {
    dotFxLastDraw = now;
    drawDotFx(now);
  }
  if (busy) dotFxFrame = requestAnimationFrame(stepDotFx);
}

function ensureDotFx() {
  if (dotFxFrame == null && !document.hidden) dotFxFrame = requestAnimationFrame(stepDotFx);
}

function restartTwinkle() {
  clearInterval(twinkleTimer);
  twinkleTimer = null;
  if (document.hidden) return;
  twinkleTimer = setInterval(() => {
    if (!dotCols || !dotRows) return;
    const count =
      DOT_TWINKLE_MIN_PER_TICK + Math.floor(Math.random() * (DOT_TWINKLE_MAX_PER_TICK - DOT_TWINKLE_MIN_PER_TICK + 1));
    const now = performance.now();
    for (let i = 0; i < count; i++) {
      const gx = Math.floor(Math.random() * (dotCols + 1));
      const gy = Math.floor(Math.random() * (dotRows + 1));
      const key = gy * (dotCols + 1) + gx;
      if (twinkleKeys.has(key)) continue; // already mid-pulse, leave it
      twinkleKeys.add(key);
      twinkles.push({
        x: gx * DOT_SPACING,
        y: gy * DOT_SPACING,
        key,
        start: now,
        dur: DOT_TWINKLE_MIN_MS + Math.random() * DOT_TWINKLE_SPREAD_MS,
      });
    }
    ensureDotFx();
  }, DOT_TWINKLE_INTERVAL_MS);
}

/** A hidden tab stops both the pulse timer and the animation loop. */
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearInterval(twinkleTimer);
    twinkleTimer = null;
    if (dotFxFrame != null) cancelAnimationFrame(dotFxFrame);
    dotFxFrame = null;
  } else {
    restartTwinkle();
    ensureDotFx();
  }
});

let dotBgResizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(dotBgResizeTimer);
  dotBgResizeTimer = setTimeout(renderDotBackground, 200);
});

/**
 * Initializes the board, then polls so a tab left open shows new activity; re-renders only when node/edge
 * counts change.
 */
async function init() {
  updateContentScale();
  renderDotBackground();
  updateFilterSpotlight();
  await loadAndRender();
  setInterval(loadAndRender, 4000);
}

init();
