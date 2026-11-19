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
- Deploy v9.7: commit `af38a50`. Both production sites confirmed on `APP_VERSION 9.7`, cache `field-notes-v26`. `/api/sync` answers 501 with its JSON hint on both, so the new handler loads without errors.

## v9.8 — polish and update path (2026-11-16)
- Shipped: first-run "Start with one person" card; phone, email and passphrase boxes full height; Call and Email as proper buttons; accessible names on every input and pressed state on chips; backup reminder moved below the capture box and now saves a full backup; fixed the dead "Back to settings" button on Trends; README rewritten; CHANGELOG added.
- Tests: 51 of 51 pass, including new first-run and accessibility checks (every field named, every control at least 40px tall).
- Update path, tested for real with a service worker on a local server and 955 fake people:
  - v9.3 installed -> v9.8 files swapped in -> one reopen: the app reloaded itself, showed "Updated to v9.9", data identical, rollback copy of all 955 kept, old cache removed.
  - v9.7 installed -> v9.8 swapped in -> app resumed without a page load (as an installed app does): same result.
- Never-homework review: nothing new is required anywhere. Capture needs a name only. Promises, tags, tier and potential are optional. Break prompts and the "further out" list appear only when they have someone to show and never raise the reminder card. The only recurring ask left is the 30-day backup reminder, kept on purpose because the data lives on one device (it no longer sits above the capture box).
- Deploy v9.8: commit `a159b91`. Both production sites confirmed on `APP_VERSION 9.8`, cache `field-notes-v27`; every deployed file matches the repo byte for byte.

## v9.9 — Penn and duplicates (2026-11-19)
- Shipped: Penn badge worked out from company, school or upenn.edu email; "From Penn" toggle on the Add card (starts on, remembered, switches on when you type Penn) and on every contact; "Penn only" filter, remembered; robust vCard import with in-file combining, matching of people already here that fills blanks only, and an "Add the Penn people" button; Duplicates screen with merge, merge all and undo; import undo now restores filled fields.
- Tests: 67 of 67 pass. New tests cover Penn detection (12 Penn names, 15 lookalikes), the toggle and its memory, vCard quirks, the same-person rule (siblings on a family number, middle initials, numbered entries), Penn-only import with undo, merging at 1,000 people with 40 planted duplicates, and that no tier is ever lowered.
- Dry run on the real files, on this computer only (counts only; private copies deleted afterwards): 955 people loaded earlier, 653 already show as Penn; 36 people saved twice (37 extra records); the contacts file has 1,926 named cards, 88 repeats combined into 1,838 people; 832 already in the app; 200 new from Penn; 806 new and not Penn. After "Add the Penn people": 1,155 people, 853 from Penn, no new duplicates. Parsing the 30 MB file took 0.36 s on the laptop.
- A first version of the same-person rule would have merged four separate numbered entries and could have merged siblings on a family number. Both are fixed and covered by tests.
- Deploy v9.9: commit `c50ea6e`. Both production sites confirmed on `APP_VERSION 9.9`, cache `field-notes-v28`; live app.js matches the repo byte for byte.

## Where things stand
- Live version: **9.9** on https://field-notes-two-blond.vercel.app and https://field-notes-pwa-gules.vercel.app.
- On your phone: open the app once. It reloads itself and shows "Updated to v9.9". Check the bottom of the Add tab.
- Open: real Upstash sync test (DECISIONS.md 11). Suggested: delete the Vercel project you do not use (DECISIONS.md 1).
