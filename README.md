# Field Notes

A private relationship tracker. 955 contacts preloaded. All data stays in your browser.

## Deploy to Vercel — the one thing that matters

Upload the **contents** of this folder, not the folder itself.

Vercel needs `index.html` sitting at the top level of what you upload. If it ends up one folder deeper, you get a blank page or a 404.

### Drag and drop

1. Unzip. You now have a folder called `pwa`.
2. **Open** the `pwa` folder so you can see `index.html`, `app.js`, `styles.css`, `icons/`, etc.
3. Select all of those files and folders (Cmd+A / Ctrl+A).
4. Go to https://vercel.com/new and drag the **selected files** onto the drop area.
5. If asked for a framework preset, choose **Other**. Leave build command and output directory empty.
6. Deploy.

### CLI

```bash
cd pwa
npx vercel --prod
```

Answer the prompts with defaults. There is no build step.

## Verify it worked

Open the deployed URL. You should see "Field Notes" with "955 contacts" underneath.

If the page tells you a file could not be loaded, the upload was nested one level too deep — redo the steps above making sure `index.html` is at the root.

## Install on your phone

**iOS (Safari):** open the URL → Share → Add to Home Screen.
**Android (Chrome):** open the URL → tap Install in the header, or browser menu → Install app.

Launches full screen, works offline.

## Files

```
index.html      app shell
styles.css      all styling
app.js          application logic
sync.js         end-to-end encryption + merge for device sync
api/sync.js     serverless endpoint that stores the encrypted blob
data.js         empty by design — contacts are imported on-device
manifest.json   PWA manifest
sw.js           service worker, offline-first
vercel.json     cache headers
icons/          192, 512, maskable, apple-touch, favicon
```

All paths are relative, so the app also runs from a subfolder or straight off your desktop by opening `index.html`.

## Sync across devices (optional)

Sync is **off** until you turn it on, and the app works fully without it.

Contacts are encrypted in the browser with a key derived from your passphrase
(PBKDF2-SHA256, 250k iterations) before anything is uploaded. The server stores
an opaque AES-GCM blob and a revision number, so Vercel, the database provider,
and the author of this code cannot read it. **There is no password reset** —
lose the passphrase and the synced copy is unrecoverable.

### Turning it on

1. In this project's Vercel dashboard open **Storage** and create an **Upstash
   Redis** store. Vercel then sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`
   automatically. (`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` also work.)
2. Redeploy so the function sees the variables.
3. In the app: **Add → Sync across devices**, choose a passphrase, **Turn on sync**.
4. On the second device: same site, **same passphrase**, paste the **sync code**
   shown on the first device, then **Join that sync**.

Without those variables `/api/sync` returns 501 and the app says sync is not
configured. Nothing else breaks.

### How conflicts resolve

Edits merge per contact by timestamp rather than overwriting the whole file, so
changes made on your phone and laptop between syncs both survive. Deletions use
tombstones, so deleting on one device is not undone by the other still holding a
copy. Simultaneous writes are caught by a revision check and retried.

Sync is not a backup — export a CSV regularly regardless.

## Data

`localStorage`, per browser and per device. Without sync, phone and laptop keep
separate copies.

Export CSV from the Add tab to back up or move data between devices. LinkedIn's `Connections.csv` imports directly.

To change the preloaded set, replace `data.js`:

```js
{ n: "Name", t: "Tier", co: "Company", sc: "School", l: "City", c: "Notes", ph: "Phone", em: "Email" }
```
