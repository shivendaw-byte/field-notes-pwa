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
data.js         seeded contacts (window.SEED_CONTACTS)
manifest.json   PWA manifest
sw.js           service worker, offline-first
vercel.json     cache headers
icons/          192, 512, maskable, apple-touch, favicon
```

All paths are relative, so the app also runs from a subfolder or straight off your desktop by opening `index.html`.

## Data

`localStorage`, per browser and per device. Phone and laptop keep separate copies.

Export CSV from the Add tab to back up or move data between devices. LinkedIn's `Connections.csv` imports directly.

To change the preloaded set, replace `data.js`:

```js
{ n: "Name", t: "Tier", co: "Company", sc: "School", l: "City", c: "Notes", ph: "Phone", em: "Email" }
```
