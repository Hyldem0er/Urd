# URD — OSINT Pivot Tracker

A Firefox extension that records your browsing as a visual tree, so you can see
how a research session unfolded. Everything stays on your machine (local
IndexedDB); nothing is sent anywhere.

## What it does

- **Builds a tree of your browsing.** Each page is a card; links you follow and
  tabs you open from a page are attached under it. A typed URL, a typed search
  or a bookmark starts a new branch.
- **Detects pivots**, the moves that connect separate pages:
  - text you copied, then searched for (or found in a URL);
  - a link to another website (`external link`);
  - text pasted into a translator.
- **Popup:** live counters, pause/resume, **Start here** (begin a fresh branch
  from the current page), notes for the current page, open the tree, clear data.
- **Tree view:** pan and zoom, drag cards, auto-layout (vertical or horizontal),
  filters (text search, pivot chains only, favorites), favorites, notes, pin
  your own leads, draw connections by hand, undo/redo.
- **Export:** a log of every search and browsing session as **PDF or Markdown**,
  plus JSON export/import of the whole tree.

## Install (temporary)

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click **Load Temporary Add-on…** and select `manifest.json`.
3. Browse as usual, then click the toolbar icon → **Open pivot tree**.

Temporary add-ons are removed when Firefox restarts.

## Customize

- Search engines and translators: `config/*.json`.
- Link shown at the top of the report: `REPO_URL` in `report.js`.
