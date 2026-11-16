/* Field Notes — end-to-end encrypted sync.
 *
 * Your contacts are encrypted on this device before they are uploaded.
 * The server stores ciphertext and a revision number; it never receives
 * the passphrase or the key, so it cannot read your data.
 *
 *   key   = PBKDF2-SHA256(passphrase, salt = syncId, 250k iterations)
 *   blob  = base64( iv[12] || AES-GCM(key, JSON(state)) )
 *
 * Conflicts are resolved per contact by `updatedAt`, not by overwriting the
 * whole file, so editing on your phone and laptop at the same time merges
 * instead of one side winning and eating the other's changes. When both
 * devices edited the SAME person since the last sync, the newer copy wins the
 * fields but the other side's notes are appended rather than dropped.
 */
(function () {
  "use strict";

  var CFG_KEY = "field-notes-sync";
  var ITERATIONS = 250000;
  var TOMBSTONE_DAYS = 90;

  var cfg = null;      // { id, pass, rev, lastSync }
  var keyCache = null; // { pass, key }

  function loadCfg() {
    if (cfg) return cfg;
    try { cfg = JSON.parse(localStorage.getItem(CFG_KEY) || "null"); } catch (e) { cfg = null; }
    return cfg;
  }
  function saveCfg(next) {
    cfg = next;
    try { localStorage.setItem(CFG_KEY, JSON.stringify(next)); } catch (e) {}
  }
  function clearCfg() {
    cfg = null; keyCache = null;
    try { localStorage.removeItem(CFG_KEY); } catch (e) {}
  }
  function enabled() { var c = loadCfg(); return !!(c && c.id && c.pass); }

  function newId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    // Fallback for older WebViews
    var b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = [].map.call(b, function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }

  /* ---------- binary helpers (chunked: avoids stack overflow on big blobs) ---------- */
  function toB64(bytes) {
    var s = "", CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(s);
  }
  function fromB64(b64) {
    var s = atob(b64), out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function deriveKey(pass, id) {
    if (keyCache && keyCache.pass === pass && keyCache.id === id) return Promise.resolve(keyCache.key);
    var enc = new TextEncoder();
    return crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"])
      .then(function (base) {
        return crypto.subtle.deriveKey(
          { name: "PBKDF2", salt: enc.encode("field-notes:" + id), iterations: ITERATIONS, hash: "SHA-256" },
          base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
        );
      })
      .then(function (k) { keyCache = { pass: pass, id: id, key: k }; return k; });
  }

  function encrypt(obj) {
    var c = loadCfg();
    return deriveKey(c.pass, c.id).then(function (key) {
      var iv = crypto.getRandomValues(new Uint8Array(12));
      var data = new TextEncoder().encode(JSON.stringify(obj));
      return crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, data).then(function (ct) {
        var out = new Uint8Array(iv.length + ct.byteLength);
        out.set(iv, 0); out.set(new Uint8Array(ct), iv.length);
        return toB64(out);
      });
    });
  }

  function decrypt(b64) {
    var c = loadCfg();
    return deriveKey(c.pass, c.id).then(function (key) {
      var raw = fromB64(b64);
      var iv = raw.subarray(0, 12), ct = raw.subarray(12);
      return crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, ct);
    }).then(function (buf) {
      return JSON.parse(new TextDecoder().decode(buf));
    }).catch(function () {
      // AES-GCM fails authentication when the passphrase is wrong.
      throw new Error("WRONG_PASSPHRASE");
    });
  }

  /* ------------------------------- merge ------------------------------- */
  function pruneTombstones(list) {
    var cut = Date.now() - TOMBSTONE_DAYS * 86400000;
    return (list || []).filter(function (d) { return new Date(d.at).getTime() > cut; });
  }

  /* Union the append-only lists on a contact, keeping every dated fact from
     both devices. Interactions are plain date strings; tier changes are
     objects keyed by date+from+to. */
  function mergeHistories(winner, a, b) {
    var out = {}, k;
    for (k in winner) if (winner.hasOwnProperty(k)) out[k] = winner[k];

    var seen = {}, dates = [];
    [].concat(a.interactions || [], b.interactions || []).forEach(function (d) {
      if (d && !seen[d]) { seen[d] = 1; dates.push(d); }
    });
    out.interactions = dates.sort();
    out.lastContact = dates.length ? dates[dates.length - 1] : "";

    var seenM = {}, moves = [];
    [].concat(a.tierLog || [], b.tierLog || []).forEach(function (m) {
      if (!m || !m.date) return;
      var key = m.date + "|" + m.from + "|" + m.to;
      if (seenM[key]) return;
      seenM[key] = 1;
      moves.push(m);
    });
    out.tierLog = moves.sort(function (x, y) { return x.date < y.date ? -1 : 1; });

    return out;
  }

  /* Both devices changed this person since they last agreed. The newer copy
     has already won the plain fields; make sure nothing typed on the older
     copy disappears without a trace. */
  var FILL = ["company", "school", "location", "phone", "email", "potential"];
  function keepBoth(out, loser) {
    var wn = String(out.notes || ""), ln = String(loser.notes || "").trim();
    if (ln && ln !== wn.trim() && wn.indexOf(ln) === -1) {
      out.notes = wn ? wn.replace(/\s*$/, "") + " | other device: " + ln : ln;
    }
    var wf = String(out.followUp || "").trim(), lf = String(loser.followUp || "").trim();
    if (lf && !wf) out.followUp = lf;
    else if (lf && lf !== wf && wf.indexOf(lf) === -1) out.followUp = wf + " / " + lf;
    FILL.forEach(function (k) { if (!out[k] && loser[k]) out[k] = loser[k]; });
    return out;
  }

  // Last-write-wins per contact, with tombstones so a delete on one device
  // is not resurrected by the other device still holding a copy.
  // `lastSync` is when this device last agreed with the server (ISO string or
  // null). Without it every overlap is treated as a possible conflict.
  function merge(local, remote, lastSync) {
    var byId = {}, i, c;

    for (i = 0; i < (remote.contacts || []).length; i++) {
      c = remote.contacts[i];
      if (c && c.id) byId[c.id] = c;
    }
    for (i = 0; i < (local.contacts || []).length; i++) {
      c = local.contacts[i];
      if (!c || !c.id) continue;
      var r = byId[c.id];
      if (!r) { byId[c.id] = c; continue; }
      var winner = String(c.updatedAt || "") >= String(r.updatedAt || "") ? c : r;
      var loser = winner === c ? r : c;
      // Histories are append-only facts, so they union rather than let the
      // newer side's copy win. Straight last-write-wins would silently drop
      // interactions and tier changes recorded on the other device.
      var out = mergeHistories(winner, c, r);
      var bothChanged = !lastSync ||
        (String(c.updatedAt || "") > lastSync && String(r.updatedAt || "") > lastSync);
      if (bothChanged && String(c.updatedAt || "") !== String(r.updatedAt || "")) keepBoth(out, loser);
      byId[c.id] = out;
    }

    var delMap = {};
    [].concat(local.deleted || [], remote.deleted || []).forEach(function (d) {
      if (!d || !d.id) return;
      if (!delMap[d.id] || d.at > delMap[d.id].at) delMap[d.id] = d;
    });
    Object.keys(delMap).forEach(function (id) {
      var d = delMap[id], kept = byId[id];
      // A delete only wins if nothing edited that contact after it.
      if (kept && String(kept.updatedAt || "") > String(d.at)) return;
      delete byId[id];
    });

    var contacts = Object.keys(byId).map(function (k) { return byId[k]; });
    var localNewer = String(local.updatedAt || "") >= String(remote.updatedAt || "");
    var base = localNewer ? local : remote;

    return {
      version: Math.max(local.version || 0, remote.version || 0),
      contacts: contacts,
      deleted: pruneTombstones(Object.keys(delMap).map(function (k) { return delMap[k]; })),
      settings: base.settings || local.settings || remote.settings || {},
      updatedAt: (local.updatedAt || "") > (remote.updatedAt || "") ? local.updatedAt : remote.updatedAt
    };
  }

  /* ------------------------------ transport ------------------------------ */
  function pull() {
    var c = loadCfg();
    return fetch("/api/sync?id=" + encodeURIComponent(c.id), { cache: "no-store" })
      .then(function (r) {
        if (r.status === 404) return null;
        if (r.status === 501) return r.json().then(function (j) { throw new Error(j.hint || "Sync not configured"); });
        if (r.status === 429) throw new Error("RATE_LIMITED");
        if (!r.ok) throw new Error("Could not reach sync (" + r.status + ")");
        return r.json();
      });
  }

  function put(state, baseRev) {
    var c = loadCfg();
    return encrypt(state).then(function (blob) {
      return fetch("/api/sync", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: c.id, blob: blob, baseRev: baseRev })
      });
    });
  }

  /* Full round trip: pull, merge, push. Retries once on a 409 (someone else
     wrote between our read and our write). Returns the merged state. */
  function uploadError(res) {
    return new Error(res.status === 429 ? "RATE_LIMITED" : res.status === 413 ? "TOO_LARGE" : "Upload failed (" + res.status + ")");
  }

  function syncNow(localState) {
    if (!enabled()) return Promise.reject(new Error("Sync is off"));
    var c = loadCfg();

    function attempt(retriesLeft) {
      return pull().then(function (rec) {
        if (!rec) {
          return put(localState, 0).then(function (res) {
            if (res.status === 409 && retriesLeft > 0) return attempt(retriesLeft - 1);
            if (!res.ok) throw uploadError(res);
            return res.json().then(function (j) {
              saveCfg(Object.assign({}, loadCfg(), { rev: j.rev, lastSync: j.updatedAt }));
              return { state: localState, merged: false };
            });
          });
        }
        return decrypt(rec.blob).then(function (remoteState) {
          var mergedState = merge(localState, remoteState, c.lastSync || null);
          return put(mergedState, rec.rev).then(function (res) {
            if (res.status === 409 && retriesLeft > 0) return attempt(retriesLeft - 1);
            if (!res.ok) throw uploadError(res);
            return res.json().then(function (j) {
              saveCfg(Object.assign({}, loadCfg(), { rev: j.rev, lastSync: j.updatedAt }));
              return { state: mergedState, merged: true };
            });
          });
        });
      });
    }
    return attempt(2);
  }

  /* Join an existing sync ID from a second device: pull and decrypt only. */
  function adopt(id, pass) {
    saveCfg({ id: id, pass: pass, rev: 0, lastSync: null });
    return pull().then(function (rec) {
      if (!rec) { clearCfg(); throw new Error("NO_SUCH_SYNC"); }
      return decrypt(rec.blob).then(function (state) {
        saveCfg({ id: id, pass: pass, rev: rec.rev, lastSync: rec.updatedAt });
        return state;
      });
    }).catch(function (e) { if (e.message !== "WRONG_PASSPHRASE") clearCfg(); throw e; });
  }

  window.FNSync = {
    enabled: enabled,
    config: loadCfg,
    newId: newId,
    enable: function (pass, id) { saveCfg({ id: id || newId(), pass: pass, rev: 0, lastSync: null }); return loadCfg(); },
    disable: clearCfg,
    adopt: adopt,
    syncNow: syncNow,
    merge: merge
  };
})();
