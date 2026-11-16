# Decisions

Calls made during the overhaul without asking, newest last. Each has the reasoning and how to reverse it.

1. **Two production sites.** This repo deploys to two Vercel projects: `field-notes-two-blond.vercel.app` and `field-notes-pwa-gules.vercel.app`. I could not tell which one is installed on the phone, so every release is verified on both. Suggestion: delete whichever project you do not use (Vercel dashboard), so there is one copy.
2. **Tests run in the browser, not Node.** Node is not installed on this machine, and the stack rule is "no new dependencies". `tests/run.html` drives the real app in a frame on a local server. Test mode needs `localhost` plus `?fntest=1` and uses a separate storage key, so it cannot touch real contacts. `tests/` and `tools/` are excluded from deploys by `.vercelignore`.
3. **Full backup is JSON; CSV stays for spreadsheets.** CSV cannot carry ids or reconnect clocks. Restoring a JSON backup replaces the device's data after a confirm and keeps what was there as the rollback copy.
4. **One-step rollback copy.** Before a new version first touches stored data it saves the untouched original under a second storage key. Settings > About > "Go back to that copy" restores it. If storage is full the copy is skipped and the update still runs.
