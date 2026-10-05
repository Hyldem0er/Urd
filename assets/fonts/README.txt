Fonts used by the header/toolbar design
========================================

Montserrat (bundled here, ready to use)
----------------------------------------
Self-hosted via @fontsource/montserrat (SIL Open Font License 1.1, see
MONTSERRAT-LICENSE.txt in this folder). Used for body text: the subtitle,
filter box, and checkbox labels. Four weights are included:
  montserrat-latin-400-normal.woff2
  montserrat-latin-600-normal.woff2
  montserrat-latin-700-normal.woff2
  montserrat-latin-800-normal.woff2

Norse (NOT bundled — add these two files yourself)
----------------------------------------------------
Used for the "Urd" wordmark and the toolbar button labels. This is Norse
by Joël Carrouché (https://www.dafont.com/norse.font — "100% free for
personal and commercial use" per the author and dafont's own listing).
It isn't included in this folder because font files generally shouldn't
be re-bundled by a third party without the person actually using them
making that call themselves — download it from the link above and drop
the two files here, named exactly:
  Norse.otf
  Norsebold.otf

viewer.css and popup.html already have @font-face rules pointing at
these exact filenames. Until the files exist here, those rules simply
fail to load (silently — check DevTools' Network tab if you want to
confirm) and every element using var(--font-norse) falls back to the
next name in that stack (a plain condensed sans), so nothing is broken
in the meantime — the wordmark and toolbar just won't have the runic
look yet. Once both files are in place, reload the extension and it
applies automatically; no other changes needed.
