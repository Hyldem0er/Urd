async function refreshStats() {
  const { nodes, edges, pivots } = await PivotDB.counts();
  document.getElementById("statNodes").textContent = nodes;
  document.getElementById("statEdges").textContent = edges;
  document.getElementById("statPivots").textContent = pivots;
}

async function initToggle() {
  const btn = document.getElementById("pauseToggle");
  const { paused } = await browser.storage.local.get("paused");
  const isOn = !paused;
  btn.classList.toggle("on", isOn);
  btn.addEventListener("click", async () => {
    const cur = await browser.storage.local.get("paused");
    const nowPaused = !cur.paused;
    await browser.storage.local.set({ paused: nowPaused });
    btn.classList.toggle("on", !nowPaused);
    loadNotesForActiveTab(); // paused/resumed can change whether this page has a card
  });
}

/** Notes use the same node.notes field as the viewer, so edits appear on the board immediately. */
let notesNodeId = null;
let notesSaveTimer = null;

function flashNotesStatus(text) {
  const status = document.getElementById("notesStatus");
  status.textContent = text;
  status.classList.add("show");
  clearTimeout(flashNotesStatus._t);
  flashNotesStatus._t = setTimeout(() => status.classList.remove("show"), 1100);
}

async function saveNotesNow() {
  const box = document.getElementById("notesBox");
  if (notesNodeId == null || box.dataset.dirty !== "1") return;
  clearTimeout(notesSaveTimer);
  box.dataset.dirty = "";
  await PivotDB.updateNode(notesNodeId, { notes: box.value });
  flashNotesStatus("Saved");
}

function showNotesMessage(text, offerStart = false) {
  document.getElementById("notesBox").style.display = "none";
  document.getElementById("notesPage").style.display = "none";
  const msg = document.getElementById("notesMsg");
  msg.style.display = "block";
  msg.textContent = "";
  msg.appendChild(document.createTextNode(text));
  if (offerStart) {
    msg.appendChild(document.createElement("br"));
    const link = document.createElement("button");
    link.type = "button";
    link.className = "link-btn";
    link.textContent = "📌 Start here";
    link.addEventListener("click", () => doStartHere());
    msg.appendChild(link);
  }
}

async function loadNotesForActiveTab(isRetry = false) {
  const box = document.getElementById("notesBox");
  const pageLabel = document.getElementById("notesPage");

  let tab;
  try {
    [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  } catch {
    tab = null;
  }

  if (!tab || !tab.url || !/^https?:/.test(tab.url)) {
    notesNodeId = null;
    showNotesMessage("This kind of page isn't tracked, so there's no card to attach a note to.");
    return;
  }

  const node = await PivotDB.findNodeByUrl(tab.url);

  if (!node) {
    // Navigation recording is asynchronous; retry once if the active page node is not ready yet.
    if (!isRetry) {
      setTimeout(() => loadNotesForActiveTab(true), 500);
      return;
    }
    notesNodeId = null;
    const { paused } = await browser.storage.local.get("paused");
    showNotesMessage(
      paused
        ? "Tracking is paused, so this page has no card yet."
        : "This page hasn't been added to the tree yet.",
      true
    );
    return;
  }

  notesNodeId = node.id;
  pageLabel.style.display = "block";
  pageLabel.textContent = node.title || node.domain || tab.url;
  pageLabel.title = tab.url;
  box.style.display = "block";
  document.getElementById("notesMsg").style.display = "none";
  box.value = node.notes || "";
  box.dataset.dirty = "";
}

function initNotes() {
  const box = document.getElementById("notesBox");
  box.addEventListener("input", () => {
    box.dataset.dirty = "1";
    clearTimeout(notesSaveTimer);
    notesSaveTimer = setTimeout(saveNotesNow, 500);
  });
  // Flush pending note edits on blur and before the popup closes.
  box.addEventListener("blur", saveNotesNow);
  window.addEventListener("unload", () => {
    if (notesNodeId != null && box.dataset.dirty === "1") {
      PivotDB.updateNode(notesNodeId, { notes: box.value });
    }
  });
  loadNotesForActiveTab();
}

document.getElementById("openViewer").addEventListener("click", () => {
  browser.tabs.create({ url: browser.runtime.getURL("viewer.html") });
});

/** Briefly swaps a button's label, then restores it. */
async function flashButtonText(btn, text) {
  const original = btn.dataset.label || btn.textContent;
  btn.dataset.label = original;
  btn.textContent = text;
  setTimeout(() => {
    btn.textContent = btn.dataset.label;
  }, 1400);
}

/** Start here: create/reuse the active page's node, resume tracking, and make it this tab's new root. */
async function doStartHere(triggerBtn) {
  let tab;
  try {
    [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  } catch {
    tab = null;
  }

  if (!tab || !tab.url || !/^https?:/.test(tab.url)) {
    if (triggerBtn) flashButtonText(triggerBtn, "Can't track this page");
    return;
  }

  if (triggerBtn) triggerBtn.disabled = true;
  try {
    const res = await browser.runtime.sendMessage({
      type: "startHere",
      tabId: tab.id,
      url: tab.url,
      title: tab.title || "",
    });
    if (res && res.ok) {
      document.getElementById("pauseToggle").classList.add("on");
      if (triggerBtn) flashButtonText(triggerBtn, res.created ? "Card added ✓" : "Tracking from here ✓");
      refreshStats();
      loadNotesForActiveTab();
    } else if (triggerBtn) {
      flashButtonText(triggerBtn, "Couldn't start — try again");
    }
  } catch {
    if (triggerBtn) flashButtonText(triggerBtn, "Couldn't start — try again");
  } finally {
    if (triggerBtn) setTimeout(() => { triggerBtn.disabled = false; }, 1400);
  }
}

document.getElementById("startHere").addEventListener("click", (e) => {
  doStartHere(e.currentTarget);
});

document.getElementById("clearData").addEventListener("click", async () => {
  if (!confirm("Delete all locally stored pivot tree data? This cannot be undone.")) return;
  await PivotDB.clearAll();
  refreshStats();
});

refreshStats();
initToggle();
initNotes();
