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
 */

const MAX_BLOB_BYTES = 8 * 1024 * 1024; // ~8 MB of ciphertext
const TTL_SECONDS = 60 * 60 * 24 * 365 * 2; // 2 years since last write

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

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!creds()) {
    return res.status(501).json({
      error: "Sync is not configured on this deployment.",
      hint: "Add an Upstash Redis store in the Vercel dashboard (Storage tab), then redeploy."
    });
  }

  try {
    if (req.method === "GET") {
      const id = String(req.query.id || "");
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
      if (blob.length > MAX_BLOB_BYTES) return res.status(413).json({ error: "too large" });

      const raw = await redis(["GET", "fn:" + id]);
      const cur = raw ? JSON.parse(raw) : null;

      // Optimistic concurrency: refuse if the stored revision moved on without us.
      if (cur && cur.rev !== baseRev) return res.status(409).json(cur);

      const next = { rev: (cur ? cur.rev : 0) + 1, updatedAt: new Date().toISOString(), blob };
      await redis(["SET", "fn:" + id, JSON.stringify(next), "EX", String(TTL_SECONDS)]);
      return res.status(200).json({ rev: next.rev, updatedAt: next.updatedAt });
    }

    if (req.method === "DELETE") {
      const id = String(req.query.id || "");
      if (!ID_RE.test(id)) return res.status(400).json({ error: "bad id" });
      await redis(["DEL", "fn:" + id]);
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, PUT, POST, DELETE");
    return res.status(405).json({ error: "method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: "sync failed", detail: String(err && err.message || err) });
  }
}
