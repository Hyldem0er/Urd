function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleString();
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

async function renderClips() {
  const clips = await PivotDB.getAllClips();
  const nodes = await PivotDB.getAllNodes();
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  document.getElementById("clipCount").textContent = `(${clips.length})`;
  const tbody = document.querySelector("#clipTable tbody");
  tbody.innerHTML = "";
  if (clips.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty">No copies/selections captured yet.</td></tr>`;
    return;
  }
  const head = document.createElement("tr");
  head.innerHTML = "<th>When</th><th>Captured text</th><th>Captured on page</th><th>Node</th>";
  tbody.appendChild(head);
  for (const c of clips.slice(0, 150)) {
    const n = nodeById.get(c.nodeId);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="time">${timeAgo(c.timestamp)}</td>
      <td class="mono">"${esc(c.text)}"</td>
      <td class="mono">${esc(c.url || "")}</td>
      <td>${n ? esc(n.title || n.domain) : "<span class='badge bad'>no node</span>"}</td>
    `;
    tbody.appendChild(tr);
  }
}

document.getElementById("btnRefresh").addEventListener("click", renderClips);
renderClips();
