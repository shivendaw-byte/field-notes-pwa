/* Field Notes sync endpoint.
 *
 * This server stores an OPAQUE ENCRYPTED BLOB and nothing else. The
 * encryption key never leaves the device — it is derived from the user's
 * passphrase in the browser (see sync.js). Whoever runs this server,
 * including Vercel and the database provider, sees only ciphertext.
 *
 * Storage is Upstash Redis over its REST API, so no driver or package.json
 * is needed. Set either pair of env vars (the Vercel Upstash integration
 * creates the KV_* ones automatically):
 *
 *   KV_REST_API_URL            + KV_REST_API_TOKEN
 *   UPSTASH_REDIS_REST_URL     + UPSTASH_REDIS_REST_TOKEN
 *
 * Protocol
 *   GET  /api/sync?id=<syncId>          -> 200 {rev, updatedAt, blob} | 404
 *   PUT  /api/sync  {id, blob, baseRev} -> 200 {rev, updatedAt}
 *                                       -> 409 {rev, updatedAt, blob}  (someone
 *                                          else wrote first; client merges + retries)
 *   Any method                          -> 429 {error, retryAfter} when a limit is hit
 *                                       -> 413 when the blob is over the size cap
 *
 * Limits (the endpoint is public, so these bound what a stranger can cost):
 *   - blob size: 3 MB of ciphertext. 1,000 contacts is about 0.8 MB.
 *   - requests per address: 90 per 5 minutes.
 *   - writes per sync id: 40 per 5 minutes.
 *   - new sync ids per address: 6 per day.
 * Addresses are stored only as a short one-way hash, and only until the
 * window expires.
 */

const MAX_BLOB_BYTES = 3 * 1024 * 1024;
const TTL_SECONDS = 60 * 60 * 24 * 365 * 2; // 2 years since last write

const WINDOW_SECONDS = 300;
const MAX_REQUESTS_PER_IP = 90;
const MAX_WRITES_PER_ID = 40;
const MAX_NEW_IDS_PER_IP_PER_DAY = 6;

function creds() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

async function redis(cmd) {
  const c = creds();
  const res = await fetch(c.url, {
    method: "POST",
    headers: { Authorization: "Bearer " + c.token, "Content-Type": "application/json" },
    body: JSON.stringify(cmd)
  });
  if (!res.ok) throw new Error("storage error " + res.status);
  const j = await res.json();
  return j.result;
}

// Sync IDs are generated client-side by crypto.randomUUID(); accept only that shape.
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* Short one-way hash so raw addresses are never written to storage. */
function hashKey(s) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

function clientAddress(req) {
  const h = (req.headers && (req.headers["x-forwarded-for"] || req.headers["x-real-ip"])) || "";
  return String(Array.isArray(h) ? h[0] : h).split(",")[0].trim() || "unknown";
}

/* Fixed-window counter. Returns true when the caller is over the limit.
   If the counter itself fails, the request is allowed: a storage hiccup should
   not lock the owner out of their own sync. */
async function overLimit(key, max, windowSeconds) {
  try {
    const n = Number(await redis(["INCR", key]));
    if (n === 1) await redis(["EXPIRE", key, String(windowSeconds)]);
    return n > max;
  } catch (e) {
    return false;
  }
}

function tooMany(res) {
  res.setHeader("Retry-After", String(WINDOW_SECONDS));
  return res.status(429).json({ error: "too many requests", retryAfter: WINDOW_SECONDS });
}

/* CommonJS on purpose: there is no package.json in this project, and Vercel
   treats an /api/*.js file as CommonJS unless one declares "type": "module".
   Using `export default` here would crash the function on deploy. */
module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!creds()) {
    return res.status(501).json({
      error: "Sync is not configured on this deployment.",
      hint: "Add an Upstash Redis store in the Vercel dashboard (Storage tab), then redeploy."
    });
  }

  try {
    const ip = hashKey(clientAddress(req));
    if (await overLimit("fn:rl:ip:" + ip, MAX_REQUESTS_PER_IP, WINDOW_SECONDS)) return tooMany(res);

    if (req.method === "GET") {
      const id = String((req.query && req.query.id) || "");
      if (!ID_RE.test(id)) return res.status(400).json({ error: "bad id" });

      const raw = await redis(["GET", "fn:" + id]);
      if (!raw) return res.status(404).json({ error: "not found" });
      return res.status(200).json(JSON.parse(raw));
    }

    if (req.method === "PUT" || req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      const id = String(body.id || "");
      const blob = String(body.blob || "");
      const baseRev = Number(body.baseRev || 0);

      if (!ID_RE.test(id)) return res.status(400).json({ error: "bad id" });
      if (!blob) return res.status(400).json({ error: "empty blob" });
      if (blob.length > MAX_BLOB_BYTES) return res.status(413).json({ error: "too large", maxBytes: MAX_BLOB_BYTES });
      if (await overLimit("fn:rl:id:" + id.toLowerCase(), MAX_WRITES_PER_ID, WINDOW_SECONDS)) return tooMany(res);

      const raw = await redis(["GET", "fn:" + id]);
      const cur = raw ? JSON.parse(raw) : null;

      // A brand-new id costs storage, so creating them is limited per address.
      if (!cur && await overLimit("fn:rl:new:" + ip, MAX_NEW_IDS_PER_IP_PER_DAY, 86400)) return tooMany(res);

      // Optimistic concurrency: refuse if the stored revision moved on without us.
      if (cur && cur.rev !== baseRev) return res.status(409).json(cur);

      const next = { rev: (cur ? cur.rev : 0) + 1, updatedAt: new Date().toISOString(), blob };
      await redis(["SET", "fn:" + id, JSON.stringify(next), "EX", String(TTL_SECONDS)]);
      return res.status(200).json({ rev: next.rev, updatedAt: next.updatedAt });
    }

    if (req.method === "DELETE") {
      const id = String((req.query && req.query.id) || "");
      if (!ID_RE.test(id)) return res.status(400).json({ error: "bad id" });
      await redis(["DEL", "fn:" + id]);
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, PUT, POST, DELETE");
    return res.status(405).json({ error: "method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: "sync failed", detail: String(err && err.message || err) });
  }
};
