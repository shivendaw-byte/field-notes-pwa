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
- Deploy v9.5: commit `792cda3`. Both production sites confirmed on `APP_VERSION 9.5` (the second site took about two minutes to switch over).

## v9.6 — reconnect reasons and recall (2026-11-16)
- Shipped: the reminder card and the Reach count are now Close and Middle only (rated Acquaintance and Networking people sit in a folded "further out" list on the Reach tab and never trigger anything); every card and Reach row says why now ("Last talked 40 days ago · you usually talk every 10 days") plus a line of your notes; an optional "Something I said I would do" on each person, listed on Reach until you tap Done; break prompts from the Penn calendar (Thanksgiving, winter, spring, summer: rated Close/Middle people outside Philadelphia; new semester: rated people added last term with nothing logged), shown only when there is someone to list; `#tags` in notes with a Tag view and Select -> "+ Tag" for tagging many at once; Trends gained Your circle, Talked to this month, Rising, Gone quiet and Groups; discreet mode (tap the Field Notes title) hides tier names and ratings.
- Tests: 39 of 39 pass.
- Speed: unchanged from v9.5 (Acquaintance list redraw about 30 ms, boot about 40 ms).
- Decisions: see DECISIONS.md 7 to 10.
- On your phone: Thanksgiving break prompt appears from Nov 21 if any rated Close/Middle person has a city other than Philadelphia.
- Deploy v9.6: commit `ef34a67`. Both production sites confirmed on `APP_VERSION 9.6`, cache `field-notes-v25`.

## v9.7 — sync hardening (2026-11-16)
- Shipped: `/api/sync` now has a 3 MB size cap and three rate limits (90 requests per address per 5 minutes, 40 writes per sync id per 5 minutes, 6 new sync ids per address per day; addresses stored only as a short hash); turning sync on needs the passphrase typed twice, shows a plain warning that it cannot be recovered, and asks for a final confirm; when both devices edited the same person, the newer copy wins and the other side's notes are appended instead of dropped; a contact added while a sync is in flight is no longer lost (bug B1); "synced 3 min ago" shows under the app title when sync is on, and "sync problem, see Settings" when it is failing; rate-limit and size errors are explained in plain words.
- Tests: 49 of 49 pass. Sync tests run the real `api/sync.js` handler and the real encryption in the browser against an in-memory stand-in for Upstash. That checks the logic. It is not a real round trip.
- BLOCKED, needs you: real Upstash test. Both production sites answer `/api/sync` with 501 because neither Vercel project has an Upstash store. See DECISIONS.md 11 for the two-minute setup, then run `bash tools/sync_smoke.sh <site>`.
