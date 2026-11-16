# Progress

One entry per release. Newest last.

## v9.4 — safety net and instant updates (2026-11-16)
- Shipped: full JSON backup and restore; rollback copy kept before each update; the app now reloads itself once when a new version takes over and shows "Updated to vX"; version shown at the bottom of the Add tab; CSV import now keeps potential ratings (it dropped them before); removed a dead duplicate of the cleanup screen; first test suite.
- Tests: 16 of 16 pass (`tests/run.html`), including backup round trip and the v9.3 -> v9.4 update on 1,000 fake people, and no sideways scroll at 375px.
- Baseline speed (955 fake people, desktop browser): app boot 83 ms; redrawing the Acquaintance list 190 ms per tap.
- Deploy: see below.
- On your phone: this is the last update that may need two opens. From here on a new version loads on the first open.
- Deploy v9.4: commit `1735ad8`. Both production sites served `APP_VERSION 9.4` and cache `field-notes-v23` within about a minute of the push. `tests/` and the `.md` files return 404 there, as intended.

## v9.5 — fast capture and speed (2026-11-16)
- Shipped: one-line capture ("Sam Lee at Geography Club" + Enter); name box focused when Add opens and after every save; follow-up card with one-tap tier and potential; duplicate-name notice with "Add anyway"; the other fields folded under "More details"; home-screen shortcuts "Add someone" and "Log a conversation" (Android long-press) and `?tab=add`, `?tab=log`, `?add=...` links; Log tab lists the people you talk to most so logging needs no typing; rows draw their edit form only when open; long lists draw 150 rows at a time; reminder card no longer covers the Add tab.
- Capture cost: open Add (1 tap), type, Enter. Before: tap the name box, type, scroll past 9 chips and 4 fields, tap Save.
- Tests: 27 of 27 pass.
- Speed (955 fake people, desktop browser): redrawing the Acquaintance list 190 ms -> 28 ms; HTML per redraw about 2 MB -> 84 KB; boot 83 ms -> 36 ms; one capture 7 ms.
- Decisions: see DECISIONS.md 5 and 6.
