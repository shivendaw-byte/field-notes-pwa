# Progress

One entry per release. Newest last.

## v9.4 — safety net and instant updates (2026-11-16)
- Shipped: full JSON backup and restore; rollback copy kept before each update; the app now reloads itself once when a new version takes over and shows "Updated to vX"; version shown at the bottom of the Add tab; CSV import now keeps potential ratings (it dropped them before); removed a dead duplicate of the cleanup screen; first test suite.
- Tests: 16 of 16 pass (`tests/run.html`), including backup round trip and the v9.3 -> v9.4 update on 1,000 fake people, and no sideways scroll at 375px.
- Baseline speed (955 fake people, desktop browser): app boot 83 ms; redrawing the Acquaintance list 190 ms per tap.
- Deploy: see below.
- On your phone: this is the last update that may need two opens. From here on a new version loads on the first open.
