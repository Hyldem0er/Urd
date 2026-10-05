/** @file Content script: forwards copied/selected text to the background page. Stores nothing, sends nothing elsewhere. */

(() => {
  let lastSent = "";

  function normalize(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function send(text) {
    const trimmed = normalize(text);
    if (trimmed.length < 3 || trimmed === lastSent) return;
    lastSent = trimmed;
    try {
      browser.runtime.sendMessage({
        type: "selection",
        text: trimmed,
        url: location.href,
      });
    } catch {
      /* extension context may be gone during page unload */
    }
  }

  /** Returns the active text selection; a focused input/textarea takes priority over the page selection. */
  function getCurrentSelectionText(preferredTarget) {
    const active = preferredTarget || document.activeElement;
    if (active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT")) {
      if (
        typeof active.selectionStart === "number" &&
        typeof active.selectionEnd === "number" &&
        active.selectionEnd > active.selectionStart
      ) {
        return active.value.substring(active.selectionStart, active.selectionEnd);
      }
      // Focused field with nothing selected: don't fall back to a stale page selection (the DeepL bug).
      return "";
    }
    const sel = document.getSelection();
    return sel ? sel.toString() : "";
  }

  /** Read the selection at Ctrl+C keydown, before SPAs (e.g. DeepL) re-render and collapse it. */
  document.addEventListener(
    "keydown",
    (e) => {
      const isCopyCombo = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === "c" || e.key === "C");
      if (!isCopyCombo) return;
      const text = getCurrentSelectionText(document.activeElement);
      if (text) send(text);
    },
    true
  );

  /** Capture phase: some sites (e.g. DeepL) call stopPropagation() on 'copy', hiding it from bubble listeners. */
  document.addEventListener(
    "copy",
    (e) => {
      const text = getCurrentSelectionText(e.target);
      if (text) send(text);
    },
    true
  );

  /** SPA translators keep one URL across translations, so webNavigation never fires; capture the paste instead. */
  document.addEventListener(
    "paste",
    (e) => {
      try {
        const text = e.clipboardData && e.clipboardData.getData("text/plain");
        const trimmed = normalize(text);
        if (trimmed.length < 3) return;
        browser.runtime.sendMessage({
          type: "translationPaste",
          text: trimmed,
          url: location.href,
        });
      } catch {
        /* extension context may be gone */
      }
    },
    true
  );

  function extractTextFromClipboardItems(items) {
    try {
      const list = items && items.length ? items : [];
      for (let i = 0; i < list.length; i++) {
        const item = list[i];
        if (!item || !item.types || !item.types.includes || !item.types.includes("text/plain")) continue;
        item
          .getType("text/plain")
          .then((blob) => blob.text())
          .then((text) => send(text))
          .catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }

  function hookClipboardViaWrappedJSObject() {
    const pageWin = window.wrappedJSObject;
    const clipboard = pageWin && pageWin.navigator && pageWin.navigator.clipboard;
    if (!clipboard) return false;
    if (clipboard.__pivotHooked) return true;
    let hookedSomething = false;

    const originalWriteText = clipboard.writeText;
    if (typeof originalWriteText === "function") {
      clipboard.writeText = exportFunction(function (text) {
        try {
          send(text === undefined || text === null ? "" : String(text));
        } catch {
          /* ignore */
        }
        return originalWriteText.call(clipboard, text);
      }, pageWin);
      hookedSomething = true;
    }

    // Some copy buttons use clipboard.write([ClipboardItem]) instead of writeText(); hook it too.
    const originalWrite = clipboard.write;
    if (typeof originalWrite === "function") {
      clipboard.write = exportFunction(function (items) {
        extractTextFromClipboardItems(items);
        return originalWrite.call(clipboard, items);
      }, pageWin);
      hookedSomething = true;
    }

    if (!hookedSomething) return false;
    try {
      clipboard.__pivotHooked = true;
    } catch {
      /* some pages freeze navigator.clipboard; hook itself still works */
    }
    return true;
  }

  function hookClipboardViaScriptInjection() {
    function inject() {
      try {
        const script = document.createElement("script");
        script.textContent =
          "(() => {" +
          "if (!navigator.clipboard || navigator.clipboard.__pivotHooked) return;" +
          "navigator.clipboard.__pivotHooked = true;" +
          "if (navigator.clipboard.writeText) {" +
          "const origText = navigator.clipboard.writeText.bind(navigator.clipboard);" +
          "navigator.clipboard.writeText = function(text) {" +
          "try { window.dispatchEvent(new CustomEvent('__pivotTrackerClipboardWrite', { detail: String(text) })); } catch (e) {}" +
          "return origText(text);" +
          "};}" +
          "if (navigator.clipboard.write) {" +
          "const origWrite = navigator.clipboard.write.bind(navigator.clipboard);" +
          "navigator.clipboard.write = function(items) {" +
          "try {" +
          "(items||[]).forEach(function(item){" +
          "if (item.types && item.types.includes('text/plain')) {" +
          "item.getType('text/plain').then(function(b){return b.text();}).then(function(t){" +
          "window.dispatchEvent(new CustomEvent('__pivotTrackerClipboardWrite', { detail: t }));" +
          "}).catch(function(){});" +
          "}" +
          "});" +
          "} catch (e) {}" +
          "return origWrite(items);" +
          "};}" +
          "})();";
        (document.head || document.documentElement).appendChild(script);
        script.remove();
      } catch {
        /* page CSP may block inline scripts */
      }
    }
    if (document.head || document.documentElement) {
      inject();
    } else {
      document.addEventListener("DOMContentLoaded", inject, { once: true });
    }
  }

  try {
    const usedWrapped = typeof exportFunction === "function" && hookClipboardViaWrappedJSObject();
    if (!usedWrapped) hookClipboardViaScriptInjection();
  } catch {
    hookClipboardViaScriptInjection();
  }
  window.addEventListener("__pivotTrackerClipboardWrite", (e) => send(e.detail));

  let selChangeTimer = null;
  document.addEventListener(
    "selectionchange",
    () => {
      clearTimeout(selChangeTimer);
      selChangeTimer = setTimeout(() => {
        const text = getCurrentSelectionText();
        if (text.trim().length >= 3) send(text);
      }, 150);
    },
    true
  );

  let selectionTimer = null;
  document.addEventListener(
    "mouseup",
    (e) => {
      clearTimeout(selectionTimer);
      selectionTimer = setTimeout(() => {
        const text = getCurrentSelectionText(e.target);
        if (text.trim().length >= 3) send(text);
      }, 250);
    },
    true
  );
})();
