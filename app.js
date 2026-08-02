/* Field Notes — a private relationship tracker.
   Contacts live in this browser. If sync is on, they are encrypted on this
   device before upload (see sync.js) — the server never sees plaintext. */

(function () {
  "use strict";

  /* ============================================================
     Constants
     ============================================================ */
  var TIERS = ["Close", "Middle", "Acquaintance", "Networking"];
  var PURPOSES = ["Chill hang", "Spontaneous hang", "Deep conversation", "Unsure"];
  var POTENTIAL = [
    { key: "Rare",   lvl: 4, blurb: "the standout — rare" },
    { key: "Strong", lvl: 3, blurb: "clear pull toward more" },
    { key: "Some",   lvl: 2, blurb: "could go somewhere" },
    { key: "Low",    lvl: 1, blurb: "fine as it is" }
  ];
  var ROLES = ["Family", "Professor", "Mentor", "Coworker", "Classmate", "Teammate"];

  /* How long before someone counts as going cold. Close and Middle only —
     Networking and Acquaintance are deliberately absent, so the 800-odd people
     in those tiers can never generate a reminder.

     The clock does NOT require logging. It starts when someone enters a tracked
     tier and resets whenever you confirm you are in touch, so this works fine
     for someone who never logs a single conversation. */
  var COLD_DAYS = { Close: 21, Middle: 60 };
  var SNOOZE_DAYS = 10;

  var APP_VERSION = "5.3";
  var KEY = "field-notes-v4";     // kept: migrates older saves in place
  var BACKUP_NAG_DAYS = 30;

  /* ============================================================
     State
     ============================================================ */
  var memoryFallback = null;
  var state, tab = "tiering", openId = null;
  var browseBy = "tier", tierFilter = "Close", groupFilter = "";
  var tierQuery = "", travelQuery = "", searchAll = false;
  var nudgeFor = null;   // contact id currently shown in the reminder card
  var cleanup = null;    // { filter, marked:{id:true} } when the purge screen is open
  var queueIndex = 0, queueHistory = [];
  var qDraft = { tier: "Middle", purpose: "", potential: "" };
  var deferredPrompt = null;
  var lastDeleted = null, undoTimer = null;
  var importPreview = null;
  var syncBusy = false, syncMsg = "", syncTimer = null;

  function uid() {
    return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  }
  function today() { return new Date().toISOString().slice(0, 10); }
  function nowISO() { return new Date().toISOString(); }
  function monthsSince(d) { return d ? Math.round((Date.now() - new Date(d)) / 2592000000) : null; }
  function daysSince(d) { return d ? Math.floor((Date.now() - new Date(d)) / 86400000) : null; }
  function addDays(iso, n) {
    var d = new Date(iso);
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }

  /* ============================================================
     Storage + migration
     ============================================================ */
  function blankContact(over) {
    var c = {
      id: uid(), name: "", tier: "Acquaintance", purpose: "", potential: "",
      company: "", school: "", location: "", locationConfirmed: "",
      notes: "", phone: "", email: "", pending: false, added: "",
      roles: [], roleOther: "", lastContact: "", touches: 0,
      tierSince: "", snoozedUntil: "", updatedAt: nowISO()
    };
    if (over) for (var k in over) if (over.hasOwnProperty(k)) c[k] = over[k];
    return c;
  }

  function migrate(s) {
    if (!s || !Array.isArray(s.contacts)) s = { contacts: [] };
    if (!Array.isArray(s.deleted)) s.deleted = [];
    if (!s.settings || typeof s.settings !== "object") s.settings = {};
    if (s.settings.lastExport === undefined) s.settings.lastExport = "";
    if (s.settings.onboarded === undefined) s.settings.onboarded = false;
    if (!s.updatedAt) s.updatedAt = nowISO();
    s.version = 5;
    s.contacts.forEach(function (c) {
      if (!Array.isArray(c.roles)) c.roles = [];
      if (c.roleOther === undefined) c.roleOther = "";
      if (c.lastContact === undefined) c.lastContact = "";
      if (typeof c.touches !== "number") c.touches = 0;
      if (c.snoozedUntil === undefined) c.snoozedUntil = "";
      // Baseline for the reconnect clock when nothing has ever been logged.
      if (!c.tierSince) c.tierSince = c.lastContact || c.added || today();
      delete c.interactions;
      // "Networking" was dropped as a reach-out reason: the tier already says it.
      if (c.purpose === "Networking") c.purpose = "";
      if (!c.updatedAt) c.updatedAt = nowISO();
      if (!c.id) c.id = uid();
    });
    return s;
  }

  function seedToContact(s) {
    return blankContact({
      name: s.n || "", tier: s.t || "Acquaintance",
      company: s.co || "", school: s.sc || "", location: s.l || "",
      notes: s.c || "", phone: s.ph || "", email: s.em || ""
    });
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) return migrate(JSON.parse(raw));
    } catch (e) { /* storage blocked — fall through */ }
    if (memoryFallback) return memoryFallback;
    return migrate({ contacts: (window.SEED_CONTACTS || []).map(seedToContact) });
  }
  function save() {
    memoryFallback = state;
    try { localStorage.setItem(KEY, JSON.stringify(state)); return true; }
    catch (e) { return false; }
  }
  function touch(c) { if (c) c.updatedAt = nowISO(); }
  function commit() { state.updatedAt = nowISO(); save(); render(); scheduleSync(); }
  function commitQuiet() { state.updatedAt = nowISO(); save(); scheduleSync(); }

  function byId(id) {
    for (var i = 0; i < state.contacts.length; i++) if (state.contacts[i].id === id) return state.contacts[i];
    return null;
  }

  /* ============================================================
     Fuzzy search
     ============================================================ */
  function lev(a, b) {
    if (a === b) return 0;
    var m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    var prev = new Array(n + 1), cur = new Array(n + 1), i, j, tmp;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur[0] = i;
      for (j = 1; j <= n; j++) {
        cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
      }
      tmp = prev; prev = cur; cur = tmp;
    }
    return prev[n];
  }
  function tolerance(len) { return len <= 3 ? 0 : len <= 5 ? 1 : len <= 8 ? 2 : 3; }
  function fuzzyHit(hay, term) {
    if (!term) return true;
    var h = (hay || "").toLowerCase(), t = term.toLowerCase();
    if (h.indexOf(t) !== -1) return true;
    if (t.length < 4) return false;
    var tol = tolerance(t.length), words = h.split(/[^a-z0-9']+/);
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (!w) continue;
      if (Math.abs(w.length - t.length) > tol + 1) continue;
      if (lev(w, t) <= tol) return true;
      if (w.length > t.length && lev(w.slice(0, t.length), t) <= tol) return true;
    }
    return false;
  }
  function haystack(c) {
    return [c.name, c.company, c.school, c.location, c.purpose, c.potential,
            c.notes, c.tier, (c.roles || []).join(" "), c.roleOther].filter(Boolean).join(" ");
  }
  function searchContacts(list, q) {
    if (!q || !q.trim()) return list;
    var terms = q.trim().split(/\s+/);
    return list.filter(function (c) {
      var hay = haystack(c);
      return terms.every(function (t) { return fuzzyHit(hay, t); });
    });
  }

  /* ============================================================
     Render helpers
     ============================================================ */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (m) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m];
    });
  }
  function potLevel(p) {
    for (var i = 0; i < POTENTIAL.length; i++) if (POTENTIAL[i].key === p) return POTENTIAL[i].lvl;
    return 0;
  }
  function potMeter(p) {
    var found = null;
    POTENTIAL.forEach(function (x) { if (x.key === p) found = x; });
    if (!found) return "";
    var bars = "";
    for (var i = 1; i <= 4; i++) bars += '<i class="' + (i <= found.lvl ? "on" : "") + '"></i>';
    return '<span class="pot" title="' + found.blurb + '">' + bars + "</span>";
  }
  function tierBadge(t) { return '<span class="badge t-' + t.toLowerCase() + '">' + t + "</span>"; }
  function digits(s) { return String(s || "").replace(/[^\d+]/g, ""); }

  function roleTags(c) {
    var all = (c.roles || []).concat(c.roleOther ? [c.roleOther] : []);
    return all.map(function (r) { return '<span class="tag role">' + esc(r) + "</span>"; }).join("");
  }

  /* null means "not tracked at all" — any tier outside COLD_DAYS, or anyone
     pending. Everyone tracked has a clock, whether or not they were ever
     logged: it falls back to when they entered the tier. */
  function coldInfo(c) {
    var limit = COLD_DAYS[c.tier];
    if (!limit || c.pending) return null;
    var from = c.lastContact || c.tierSince;
    if (!from) return null;
    var d = daysSince(from);
    return {
      days: d, limit: limit, over: d - limit,
      cold: d >= limit,
      everMarked: !!c.lastContact,
      snoozed: c.snoozedUntil && daysSince(c.snoozedUntil) < 0
    };
  }

  /* The one person worth nudging about right now, or null. Most overdue first;
     snoozed people are skipped. Deliberately returns ONE — a queue would be
     the pressure this is meant to avoid. */
  function nudgeCandidate() {
    var best = null, bestOver = -1;
    state.contacts.forEach(function (c) {
      var i = coldInfo(c);
      if (!i || !i.cold || i.snoozed) return;
      if (i.over > bestOver) { best = c; bestOver = i.over; }
    });
    return best;
  }

  function rowHTML(c) {
    var mo = monthsSince(c.locationConfirmed);
    var stale = c.location && mo !== null && mo >= 6;
    var never = c.location && !c.locationConfirmed;
    var sub = [];
    if (c.location) {
      sub.push('<span>◍ ' + esc(c.location) +
        (stale ? ' <span class="stale">· ' + mo + 'mo old</span>' : (never ? ' <span class="stale">· unconfirmed</span>' : "")) + "</span>");
    }
    var ci = coldInfo(c);
    if (ci) {
      sub.push('<span class="' + (ci.cold ? "stale" : "") + '">✦ talked ' +
        (ci.days === 0 ? "today" : ci.days === 1 ? "yesterday" : ci.days + "d ago") + "</span>");
    }
    if (c.notes) sub.push('<span style="opacity:.8">' + esc(c.notes.slice(0, 64)) + (c.notes.length > 64 ? "…" : "") + "</span>");

    var markedToday = c.lastContact === today();
    return '<div class="row' + (openId === c.id ? " open" : "") + '" data-id="' + c.id + '">' +
      '<div class="row-top">' +
      '<button class="row-head" data-act="toggle" data-id="' + c.id + '" aria-expanded="' + (openId === c.id) + '">' +
        '<span style="flex:1;min-width:0">' +
          '<span class="row-meta">' +
            '<span class="row-name">' + (esc(c.name) || "Unnamed") + "</span>" +
            tierBadge(c.tier) + roleTags(c) +
            (c.company ? '<span class="tag co">' + esc(c.company) + "</span>" : "") +
            (c.school ? '<span class="tag sc">' + esc(c.school) + "</span>" : "") +
            (c.purpose ? '<span class="tag">' + esc(c.purpose) + "</span>" : "") +
            potMeter(c.potential) +
          "</span>" +
          (sub.length ? '<span class="row-sub">' + sub.join("") + "</span>" : "") +
        "</span>" +
        '<span class="caret" aria-hidden="true">▾</span>' +
      "</button>" +
      '<button class="quicktalk' + (markedToday ? " on" : "") + '" data-act="marktouch" data-id="' + c.id +
        '" aria-label="Mark that you talked to ' + esc(c.name) + ' today" title="Talked today">' +
        (markedToday ? "✓" : "Talked") + "</button>" +
      "</div>" +
      '<div class="row-body">' +
        '<div class="field rowsplit" style="gap:8px">' +
          '<button class="btn-ghost talk" data-act="marktouch" data-id="' + c.id + '">' +
            (c.lastContact === today() ? "✓ Talked today" : "Talked today") + "</button>" +
          (c.lastContact && c.lastContact !== today()
            ? '<span class="hint" style="margin:0">last ' + daysSince(c.lastContact) + "d ago</span>" : "") +
        "</div>" +
        '<div class="field"><label class="f">Tier — tap to move</label><div class="chips">' +
          TIERS.map(function (t) {
            return '<button class="chip' + (c.tier === t ? " on" : "") + '" data-t="' + t + '" data-act="settier" data-id="' + c.id + '" data-val="' + t + '">' + t + "</button>";
          }).join("") +
        "</div></div>" +
        '<div class="field"><label class="f">Role — optional, pick any</label><div class="chips">' +
          ROLES.map(function (r) {
            return '<button class="chip' + ((c.roles || []).indexOf(r) !== -1 ? " on" : "") + '" data-p="1" data-act="setrole" data-id="' + c.id + '" data-val="' + r + '">' + r + "</button>";
          }).join("") +
          '<button class="chip' + (c.roleOther ? " on" : "") + '" data-p="1" data-act="roleother" data-id="' + c.id + '">Other…</button>' +
        "</div>" +
        (c.roleOther || c.showOther
          ? '<input type="text" style="margin-top:8px" value="' + esc(c.roleOther) + '" data-act="setroleother" data-id="' + c.id + '" placeholder="e.g. Advisor, Landlord">'
          : "") +
        "</div>" +
        '<div class="field"><label class="f">Reach out for</label><div class="chips">' +
          PURPOSES.map(function (p) {
            return '<button class="chip' + (c.purpose === p ? " on" : "") + '" data-p="1" data-act="setpurpose" data-id="' + c.id + '" data-val="' + p + '">' + p + "</button>";
          }).join("") +
        "</div></div>" +
        '<div class="field"><label class="f">Potential to deepen</label><div class="chips">' +
          POTENTIAL.map(function (p) {
            return '<button class="chip' + (c.potential === p.key ? " on" : "") + '" data-p="1" data-act="setpot" data-id="' + c.id + '" data-val="' + p.key + '" title="' + p.blurb + '">' + p.key + "</button>";
          }).join("") +
        "</div></div>" +
        '<div class="field grid2">' +
          '<div><label class="f">Company</label><input type="text" value="' + esc(c.company) + '" data-act="setco" data-id="' + c.id + '" placeholder="e.g. Bain"></div>' +
          '<div><label class="f">School</label><input type="text" value="' + esc(c.school) + '" data-act="setsc" data-id="' + c.id + '" placeholder="e.g. Harvard"></div>' +
        "</div>" +
        '<div class="field grid2">' +
          '<div><label class="f">Phone</label><input type="tel" value="' + esc(c.phone) + '" data-act="setphone" data-id="' + c.id + '" placeholder="Optional"></div>' +
          '<div><label class="f">Email</label><input type="email" value="' + esc(c.email) + '" data-act="setemail" data-id="' + c.id + '" placeholder="Optional"></div>' +
        "</div>" +
        '<div class="field grid2">' +
          '<div><label class="f">City</label><input type="text" value="' + esc(c.location) + '" data-act="setloc" data-id="' + c.id + '" placeholder="e.g. Boston"></div>' +
          '<div style="display:flex;align-items:flex-end"><button class="btn-ghost" style="width:100%" data-act="confirmloc" data-id="' + c.id + '">' +
            (c.locationConfirmed ? "City confirmed " + esc(c.locationConfirmed) : "Mark city confirmed today") +
          "</button></div>" +
        "</div>" +
        '<div class="field"><label class="f">Notes</label><textarea rows="2" data-act="setnotes" data-id="' + c.id + '" placeholder="Where you met, what you talked about…">' + esc(c.notes) + "</textarea></div>" +
        ((c.phone || c.email) ? '<div class="field" style="display:flex;gap:14px;flex-wrap:wrap">' +
          (c.phone ? '<a class="contactlink" href="tel:' + esc(digits(c.phone)) + '">Call</a>' : "") +
          (c.email ? '<a class="contactlink" href="mailto:' + esc(c.email) + '">Email</a>' : "") +
        "</div>" : "") +
        '<div class="field"><button class="btn-danger" data-act="delete" data-id="' + c.id + '">Delete contact</button></div>' +
      "</div></div>";
  }

  /* ============================================================
     Views
     ============================================================ */
  function groupValues(field) {
    var map = {};
    state.contacts.forEach(function (c) {
      var v = (c[field] || "").trim();
      if (v) map[v] = (map[v] || 0) + 1;
    });
    return Object.keys(map).sort(function (a, b) {
      return map[b] - map[a] || a.localeCompare(b);
    }).map(function (k) { return { key: k, n: map[k] }; });
  }

  function onboardingHTML() {
    if (state.settings.onboarded || !state.contacts.length) return "";
    var pending = state.contacts.filter(function (c) { return c.pending; }).length;
    var closeN = state.contacts.filter(function (c) { return c.tier === "Close" && !c.pending; }).length;
    var exported = !!state.settings.lastExport;
    function step(done, label, btn) {
      return '<li class="' + (done ? "done" : "") + '"><span class="tick">' + (done ? "✓" : "○") + "</span>" +
        "<span>" + label + "</span>" + (done || !btn ? "" : btn) + "</li>";
    }
    return '<div class="card start">' +
      '<div class="rowsplit"><h3 style="margin:0">Start here</h3>' +
      '<button class="btn-ghost sm" data-act="dismissonboard">Hide</button></div>' +
      '<p class="note">Three things and this becomes useful. Tiers are about closeness, not importance.</p>' +
      "<ul class=\"steps\">" +
        step(pending === 0, pending ? pending + " imported contacts still need a tier" : "Imported contacts sorted",
             '<button class="btn-ghost sm" data-act="gotoadd">Sort →</button>') +
        step(closeN >= 5, "Put your closest people in Close (" + closeN + " so far)",
             '<button class="btn-ghost sm" data-act="filterclose">Open Close →</button>') +
        step(exported, "Save a backup — your data lives only on this device",
             '<button class="btn-ghost sm" data-act="export">Export →</button>') +
      "</ul></div>";
  }

  function backupNagHTML() {
    var last = state.settings.lastExport;
    var d = daysSince(last);
    if (last && d < BACKUP_NAG_DAYS) return "";
    if (!state.contacts.length) return "";
    return '<div class="card warn rowsplit"><p class="note" style="margin:0">' +
      (last ? "Last backup was " + d + " days ago." : "You have never saved a backup.") +
      (window.FNSync && FNSync.enabled() ? " Sync is on, but a file copy is still worth keeping." : " Your data lives only on this device.") +
      '</p><button class="btn-ghost" data-act="export">Export</button></div>';
  }

  function viewTiering() {
    var pending = state.contacts.filter(function (c) { return c.pending; });
    var base, heading;

    if (searchAll && tierQuery) {
      base = state.contacts; heading = "everyone";
    } else if (browseBy === "tier") {
      base = tierFilter === "Unsorted"
        ? pending
        : state.contacts.filter(function (c) { return c.tier === tierFilter && !c.pending; });
      heading = tierFilter;
    } else {
      var field = browseBy === "school" ? "school" : browseBy === "role" ? "roles" : "company";
      base = groupFilter
        ? state.contacts.filter(function (c) {
            if (field === "roles") return (c.roles || []).indexOf(groupFilter) !== -1 || c.roleOther === groupFilter;
            return (c[field] || "") === groupFilter;
          })
        : [];
      heading = groupFilter || "";
    }

    var list = searchContacts(base, tierQuery);

    // Never hide matches silently: if this tier has none but others do, say so.
    var elsewhere = 0;
    if (tierQuery && !list.length && !searchAll) {
      elsewhere = searchContacts(state.contacts, tierQuery).length;
    }

    var filtersHTML;
    if (browseBy === "tier") {
      filtersHTML = TIERS.map(function (t) {
        var n = state.contacts.filter(function (c) { return c.tier === t && !c.pending; }).length;
        return '<button class="filter' + (tierFilter === t ? " on" : "") + '" data-act="filter" data-val="' + t + '">' + t + '<span class="n">' + n + "</span></button>";
      }).join("") + (pending.length
        ? '<button class="filter' + (tierFilter === "Unsorted" ? " on" : "") + '" data-act="filter" data-val="Unsorted">Unsorted<span class="n">' + pending.length + "</span></button>"
        : "");
    } else if (browseBy === "role") {
      var rmap = {};
      state.contacts.forEach(function (c) {
        (c.roles || []).forEach(function (r) { rmap[r] = (rmap[r] || 0) + 1; });
        if (c.roleOther) rmap[c.roleOther] = (rmap[c.roleOther] || 0) + 1;
      });
      var rkeys = Object.keys(rmap).sort(function (a, b) { return rmap[b] - rmap[a] || a.localeCompare(b); });
      filtersHTML = rkeys.length
        ? rkeys.map(function (k) {
            return '<button class="filter' + (groupFilter === k ? " on" : "") + '" data-act="group" data-val="' + esc(k) + '">' + esc(k) + '<span class="n">' + rmap[k] + "</span></button>";
          }).join("")
        : '<span class="note">No roles tagged yet — open anyone and tap Family, Professor, and so on.</span>';
    } else {
      var vals = groupValues(browseBy === "school" ? "school" : "company");
      filtersHTML = vals.length
        ? vals.map(function (v) {
            return '<button class="filter' + (groupFilter === v.key ? " on" : "") + '" data-act="group" data-val="' + esc(v.key) + '">' + esc(v.key) + '<span class="n">' + v.n + "</span></button>";
          }).join("")
        : '<span class="note">No ' + browseBy + ' tags yet — add them on any contact.</span>';
    }

    return '<div class="eyebrow">Everyone, sorted</div><h2>Tiering</h2>' +
      '<p class="sub">Browse by tier, school, company, or role. Search covers names, notes, cities, and tags — misspellings are fine.</p>' +
      onboardingHTML() +
      (pending.length ? '<div class="card warn rowsplit"><p class="note" style="margin:0">' + pending.length + ' imported contacts are waiting to be sorted.</p><button class="btn-ghost" data-act="gotoadd">Sort them →</button></div>' : "") +
      '<div class="seg" role="group" aria-label="Browse by">' +
        ["tier", "school", "company", "role"].map(function (b) {
          return '<button class="' + (browseBy === b ? "on" : "") + '" data-act="browseby" data-val="' + b + '">By ' + b + "</button>";
        }).join("") +
      "</div>" +
      (searchAll && tierQuery ? "" : '<div class="filters">' + filtersHTML + "</div>") +
      '<div class="searchwrap"><input type="search" id="tierSearch" value="' + esc(tierQuery) + '" placeholder="Search name, company, school, notes…" autocomplete="off" enterkeyhint="search">' +
        (tierQuery ? '<button class="clearx" data-act="clearsearch" aria-label="Clear search">×</button>' : "") +
      "</div>" +
      (tierQuery
        ? '<div class="rowsplit" style="margin:-4px 0 12px"><p class="hint" style="margin:0">' + list.length + " match" + (list.length === 1 ? "" : "es") +
            (searchAll ? " across everyone" : heading ? " in " + esc(heading) : "") + "</p>" +
            '<button class="btn-ghost sm" data-act="toggleall">' + (searchAll ? "Search this tier only" : "Search everyone") + "</button></div>"
        : "") +
      '<div class="rowlist">' +
        (list.length ? list.map(rowHTML).join("")
          : '<div class="empty">' +
              (elsewhere
                ? "Nothing in " + esc(heading) + " matches “" + esc(tierQuery) + "”.<br>" +
                  '<button class="btn-ghost" style="margin-top:10px" data-act="toggleall">' + elsewhere + " match" + (elsewhere === 1 ? "" : "es") + " elsewhere — search everyone</button>"
                : browseBy !== "tier" && !groupFilter
                  ? "Pick a " + browseBy + " above to see who's there."
                  : (tierQuery ? "Nothing here matches “" + esc(tierQuery) + "”." : "No one in " + esc(heading) + " yet.")) +
            "</div>") +
      "</div>";
  }

  /* Compact line: name, tier, how long since contact. The number is the point. */
  function coldRowHTML(c) {
    var i = coldInfo(c);
    var since = !i ? ""
      : i.everMarked
        ? (i.days === 0 ? "in touch today" : i.days === 1 ? "yesterday" : i.days + " days")
        : "added " + i.days + "d ago, never marked";
    return '<div class="logrow' + (i && i.cold ? " cold" : "") + '">' +
      '<span class="body" data-act="opencontact" data-id="' + c.id + '">' +
        '<span class="t">' + (esc(c.name) || "Unnamed") + "</span>" +
        '<span class="d">' + tierBadge(c.tier) +
          '<span class="' + (i && i.cold ? "stale" : "") + '">' + since + "</span>" +
          potMeter(c.potential) +
        "</span>" +
      "</span>" +
      '<button class="logbtn" data-act="marktouch" data-id="' + c.id + '">Talked</button>' +
    "</div>";
  }

  function viewReconnect() {
    var tracked = state.contacts.filter(function (c) { return !!coldInfo(c); });
    var cold = tracked.filter(function (c) { return coldInfo(c).cold; });
    // Sort by potential first, lateness second: the question this app answers is
    // "who is worth reaching out to", not "who is most overdue".
    cold.sort(function (a, b) {
      var pa = potLevel(a.potential), pb = potLevel(b.potential);
      if (pa !== pb) return pb - pa;
      return coldInfo(b).over - coldInfo(a).over;
    });
    var fine = tracked.length - cold.length;

    return '<div class="eyebrow">Quietly keeping score</div><h2>Reconnect</h2>' +
      '<p class="sub">Close and Middle only. You never have to log anything — the clock starts when ' +
      'someone joins one of those tiers and resets when you tap <strong>In touch</strong>. ' +
      'Networking and Acquaintance are left alone on purpose.</p>' +

      (!tracked.length
        ? '<div class="card"><h3>Nobody tracked yet</h3><p class="note">Move someone into Close or Middle ' +
          'and they show up here after ' + COLD_DAYS.Close + ' and ' + COLD_DAYS.Middle + ' days respectively.</p></div>'
        : cold.length
          ? '<h3 class="logsec">Been a while <span class="n">' + cold.length + "</span></h3>" +
            '<div class="loglist">' + cold.map(coldRowHTML).join("") + "</div>" +
            (fine ? '<p class="hint" style="margin-top:14px">' + fine + " other" + (fine === 1 ? " is" : "s are") +
                    " still inside their window.</p>" : "")
          : '<div class="card ok-card"><h3>Nothing slipping</h3><p class="note">All ' + tracked.length +
            " tracked " + (tracked.length === 1 ? "person is" : "people are") + " inside their window. " +
            "Close resets after " + COLD_DAYS.Close + " days, Middle after " + COLD_DAYS.Middle + ".</p></div>");
  }

  function viewTravel() {
    var q = travelQuery.trim();
    var list = [];
    if (q) {
      list = state.contacts.filter(function (c) { return !c.pending && fuzzyHit(c.location || "", q); });
      list.sort(function (a, b) { return TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier); });
    }
    var staleCount = list.filter(function (c) {
      var m = monthsSince(c.locationConfirmed);
      return m === null || m >= 6;
    }).length;
    var cities = groupValues("location");

    return '<div class="eyebrow">Who is where</div><h2>Travel</h2>' +
      '<p class="sub">Type a city to see everyone there, Close tier first. Cities go stale — confirm them as you learn where people actually are.</p>' +
      '<div class="searchwrap"><input type="search" id="travelSearch" value="' + esc(travelQuery) + '" placeholder="Boston, SF, Philadelphia…" autocomplete="off" enterkeyhint="search"></div>' +
      (!q
        ? '<p class="note">Cities already tagged:</p><div class="chips">' +
            (cities.length
              ? cities.map(function (c) { return '<button class="chip" data-act="setcity" data-val="' + esc(c.key) + '">' + esc(c.key) + ' <span style="opacity:.5">' + c.n + "</span></button>"; }).join("")
              : '<span class="note">None yet — add a city on any contact.</span>') +
          "</div>"
        : list.length
          ? (staleCount ? '<p class="hint stale" style="margin-bottom:10px">' + staleCount + " of these " + (staleCount === 1 ? "hasn't" : "haven't") + " had a city confirmed recently — worth checking before you assume.</p>" : "") +
            '<div class="rowlist">' + list.map(rowHTML).join("") + "</div>"
          : '<div class="empty">No one tagged near “' + esc(q) + '” yet.</div>');
  }

  /* ---------- import preview ---------- */
  function normName(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
  function dupeKeys(c) {
    var keys = [];
    var n = normName(c.name);
    var p = digits(c.phone).slice(-10);
    var e = String(c.email || "").toLowerCase().trim();
    if (n && p) keys.push("np:" + n + ":" + p);
    if (n && e) keys.push("ne:" + n + ":" + e);
    if (p) keys.push("p:" + p);
    if (e) keys.push("e:" + e);
    if (n) keys.push("n:" + n);
    return keys;
  }
  function buildDupeIndex() {
    var idx = {};
    state.contacts.forEach(function (c) {
      dupeKeys(c).forEach(function (k) { if (!idx[k]) idx[k] = c; });
    });
    return idx;
  }

  function previewGroups(P) {
    var field = P.groupBy;
    var map = {};
    P.rows.forEach(function (r) {
      if (r.dupe) return;
      if (P.respectFile && hadTier(r)) return; // already decided in the file
      var v = (field === "school" ? r.c.school : field === "company" ? r.c.company : "") || "(none)";
      map[v] = (map[v] || 0) + 1;
    });
    return Object.keys(map).sort(function (a, b) { return map[b] - map[a] || a.localeCompare(b); })
      .map(function (k) { return { key: k, n: map[k] }; });
  }

  // parseCSV marks rows that arrived with a valid tier as pending:false.
  function hadTier(r) { return !r.c.pending; }

  function effTier(P, r) {
    // A tier written in the file is per-person data the user already decided.
    // Re-importing your own export must not flatten it under a bulk rule.
    if (P.respectFile && hadTier(r)) return r.c.tier;
    var field = P.groupBy;
    var v = (field === "school" ? r.c.school : field === "company" ? r.c.company : "") || "(none)";
    if (P.groups[v]) return P.groups[v];
    return P.defaultTier;
  }

  function viewImportPreview() {
    var P = importPreview;
    var newRows = P.rows.filter(function (r) { return !r.dupe; });
    var dupes = P.rows.length - newRows.length;
    var groups = previewGroups(P);

    var counts = {};
    newRows.forEach(function (r) {
      var t = effTier(P, r);
      counts[t] = (counts[t] || 0) + 1;
    });

    var preTiered = newRows.filter(hadTier).length;
    var needTier = newRows.length - (P.respectFile ? preTiered : 0);

    return '<div class="eyebrow">Review before importing</div><h2>' + P.rows.length + ' rows read</h2>' +
      '<p class="sub">Nothing has been saved yet. Set tiers by group, then confirm.</p>' +

      (preTiered
        ? '<div class="card"><h3>' + preTiered + ' rows already have a tier</h3>' +
          '<p class="note">This file came with tiers filled in — likely your own export.</p>' +
          '<div class="chips">' +
            [[true, "Keep the file's tiers"], [false, "Override them below"]].map(function (o) {
              return '<button class="chip' + (P.respectFile === o[0] ? " on" : "") + '" data-act="pvrespect" data-val="' + o[0] + '">' + o[1] + "</button>";
            }).join("") +
          "</div></div>"
        : "") +

      '<div class="card"><h3>Duplicates</h3>' +
        (dupes
          ? '<p class="note">' + dupes + ' of these already exist here (matched on name, phone, or email).</p>' +
            '<div class="chips">' +
              [["skip", "Skip them"], ["update", "Update mine with the new info"]].map(function (o) {
                return '<button class="chip' + (P.dupeMode === o[0] ? " on" : "") + '" data-act="pvdupe" data-val="' + o[0] + '">' + o[1] + "</button>";
              }).join("") +
            "</div>"
          : '<p class="ok">None — all ' + P.rows.length + " are new.</p>") +
      "</div>" +

      '<div class="card"><h3>Tier for the ' + needTier + ' new contact' + (needTier === 1 ? "" : "s") + ' without one</h3>' +
        '<p class="note">' + (needTier ? "Everyone without a tier in the file starts here. You can override any group below." : "Nothing to assign — every new row already has a tier.") + '</p>' +
        '<div class="chips">' +
          TIERS.concat(["Unsorted"]).map(function (t) {
            return '<button class="chip' + (P.defaultTier === t ? " on" : "") + '" data-act="pvdefault" data-val="' + t + '">' + t + "</button>";
          }).join("") +
        "</div>" +
        '<div class="field"><label class="f">Group by</label><div class="seg">' +
          ["school", "company", "none"].map(function (g) {
            return '<button class="' + (P.groupBy === g ? "on" : "") + '" data-act="pvgroupby" data-val="' + g + '">' + g + "</button>";
          }).join("") +
        "</div></div>" +
        (P.groupBy !== "none"
          ? '<div class="pvgroups">' + groups.map(function (g) {
              var cur = P.groups[g.key] || "";
              return '<div class="pvrow"><span class="pvname">' + esc(g.key) + '<span class="n">' + g.n + "</span></span>" +
                '<div class="chips">' + TIERS.concat(["Unsorted"]).map(function (t) {
                  return '<button class="chip sm' + (cur === t ? " on" : "") + '" data-act="pvgroup" data-g="' + esc(g.key) + '" data-val="' + t + '">' + t + "</button>";
                }).join("") + "</div></div>";
            }).join("") + "</div>"
          : "") +
      "</div>" +

      '<div class="card"><h3>Result</h3><p class="note">' +
        TIERS.concat(["Unsorted"]).filter(function (t) { return counts[t]; })
          .map(function (t) { return "<strong>" + counts[t] + "</strong> " + t; }).join(" · ") +
        (dupes ? " · <strong>" + dupes + "</strong> duplicate" + (dupes === 1 ? "" : "s") + " " + (P.dupeMode === "skip" ? "skipped" : "updated") : "") +
      "</p>" +
        '<div class="field"><button class="btn" data-act="pvconfirm">Import ' + newRows.length + " contacts</button></div>" +
        '<div class="field"><button class="btn-ghost" data-act="pvcancel">Cancel</button></div>' +
      "</div>";
  }

  /* ---------- cleanup: bulk triage of contacts that no longer matter ---------- */
  var CLEAN_FILTERS = [
    { key: "untagged", label: "No school or company",
      test: function (c) { return !(c.school || "").trim() && !(c.company || "").trim(); } },
    { key: "acq", label: "Acquaintance only",
      test: function (c) { return c.tier === "Acquaintance"; } },
    { key: "nevermarked", label: "Never talked to",
      test: function (c) { return !c.lastContact; } },
    { key: "all", label: "Everyone", test: function () { return true; } }
  ];

  function cleanupCandidates() {
    var f = CLEAN_FILTERS.filter(function (x) { return x.key === cleanup.filter; })[0] || CLEAN_FILTERS[0];
    return state.contacts.filter(function (c) { return !c.pending && f.test(c); })
      .sort(function (a, b) { return (a.name || "").localeCompare(b.name || ""); });
  }

  function viewCleanup() {
    var list = cleanupCandidates();
    var markedIds = Object.keys(cleanup.marked).filter(function (k) { return cleanup.marked[k]; });
    var shown = searchContacts(list, cleanup.q || "");

    return '<div class="eyebrow">Prune the list</div><h2>Clean up</h2>' +
      '<p class="sub">Tap anyone you no longer want. Nothing is deleted until you press the button at the bottom, ' +
      'and you get one undo after that. People with a school or company tag are hidden by default — those are your recent ones.</p>' +

      '<div class="filters">' + CLEAN_FILTERS.map(function (f) {
        var n = state.contacts.filter(function (c) { return !c.pending && f.test(c); }).length;
        return '<button class="filter' + (cleanup.filter === f.key ? " on" : "") + '" data-act="clfilter" data-val="' + f.key + '">' +
          f.label + '<span class="n">' + n + "</span></button>";
      }).join("") + "</div>" +

      '<div class="searchwrap"><input type="search" id="clSearch" value="' + esc(cleanup.q || "") +
        '" placeholder="Filter these by name…" autocomplete="off"></div>' +

      '<div class="rowsplit" style="margin-bottom:10px">' +
        '<p class="hint" style="margin:0">' + shown.length + " shown · " + markedIds.length + " marked</p>" +
        (markedIds.length ? '<button class="btn-ghost sm" data-act="clnone">Clear marks</button>' : "") +
      "</div>" +

      '<div class="loglist">' + (shown.length ? shown.map(function (c) {
        var on = !!cleanup.marked[c.id];
        var d = daysSince(c.lastContact);
        var meta = [c.tier];
        if (c.school) meta.push(c.school);
        if (c.company) meta.push(c.company);
        meta.push(c.lastContact ? "talked " + d + "d ago" : "never talked");
        return '<div class="logrow clean' + (on ? " marked" : "") + '" data-act="clmark" data-id="' + c.id + '">' +
          '<span class="clbox">' + (on ? "✕" : "") + "</span>" +
          '<span class="body"><span class="t">' + (esc(c.name) || "Unnamed") + "</span>" +
          '<span class="d">' + esc(meta.join(" · ")) + "</span></span>" +
        "</div>";
      }).join("") : '<div class="empty">Nobody matches.</div>') + "</div>" +

      '<div class="cleanbar">' +
        '<button class="btn-ghost" data-act="clexit">Done</button>' +
        (markedIds.length
          ? '<button class="btn-danger" data-act="cldelete">Delete ' + markedIds.length + "</button>"
          : '<span class="hint" style="margin:0;text-align:center;flex:1">Tap names to mark them</span>') +
      "</div>";
  }

  /* ---------- add / queue ---------- */
  function viewAdd() {
    if (cleanup) return viewCleanup();
    if (importPreview) return viewImportPreview();

    var pending = state.contacts.filter(function (c) { return c.pending; });
    if (queueIndex >= pending.length) queueIndex = Math.max(0, pending.length - 1);
    var cur = pending[queueIndex];

    return '<div class="eyebrow">Tonight\'s log</div><h2>Add</h2>' +
      '<p class="sub">Who did you meet? A name and a tier is enough. Potential and notes take five more seconds and are worth it while it is fresh.</p>' +
      backupNagHTML() +
      '<div class="card"><h3>Just met someone</h3>' +
        '<input type="text" id="qName" placeholder="Name" autocomplete="off" enterkeyhint="done">' +
        '<div class="field"><label class="f">Tier</label><div class="chips" id="qTier">' +
          TIERS.map(function (t) { return '<button class="chip' + (qDraft.tier === t ? " on" : "") + '" data-t="' + t + '" data-act="qtier" data-val="' + t + '">' + t + "</button>"; }).join("") +
        "</div></div>" +
        '<div class="field"><label class="f">Reach out for</label><div class="chips" id="qPurpose">' +
          PURPOSES.map(function (p) { return '<button class="chip' + (qDraft.purpose === p ? " on" : "") + '" data-p="1" data-act="qpurpose" data-val="' + p + '">' + p + "</button>"; }).join("") +
        "</div></div>" +
        '<div class="field"><label class="f">Potential to deepen</label><div class="chips" id="qPot">' +
          POTENTIAL.map(function (p) { return '<button class="chip' + (qDraft.potential === p.key ? " on" : "") + '" data-p="1" data-act="qpot" data-val="' + p.key + '" title="' + p.blurb + '">' + p.key + "</button>"; }).join("") +
        "</div></div>" +
        '<div class="field grid2">' +
          '<div><label class="f">Company</label><input type="text" id="qCo" placeholder="Optional" autocomplete="off"></div>' +
          '<div><label class="f">School</label><input type="text" id="qSc" placeholder="Optional" autocomplete="off"></div>' +
        "</div>" +
        '<div class="field grid2">' +
          '<div><label class="f">City</label><input type="text" id="qLoc" placeholder="Optional" autocomplete="off"></div>' +
          '<div><label class="f">Where / what</label><input type="text" id="qNotes" placeholder="Met at…" autocomplete="off"></div>' +
        "</div>" +
        '<div class="field"><button class="btn" data-act="quickadd">Save contact</button></div>' +
      "</div>" +

      '<div class="card"><h3>Sort imported contacts</h3>' +
        (!pending.length
          ? '<p class="ok">All caught up — nothing waiting.</p>' +
            (queueHistory.length ? '<div class="field"><button class="btn-ghost" data-act="queueback">← Undo last sort</button></div>' : "")
          : '<span class="queue-pos">' + (queueIndex + 1) + " of " + pending.length + "</span>" +
            '<div class="queue-name">' + esc(cur.name) + "</div>" +
            (cur.notes ? '<p class="note">' + esc(cur.notes) + "</p>" : "") +
            '<div class="field grid2">' +
              '<div><label class="f">Company</label><input type="text" value="' + esc(cur.company) + '" data-act="setco" data-id="' + cur.id + '" placeholder="Optional"></div>' +
              '<div><label class="f">School</label><input type="text" value="' + esc(cur.school) + '" data-act="setsc" data-id="' + cur.id + '" placeholder="Optional"></div>' +
            "</div>" +
            '<div class="field grid2">' +
              '<div><label class="f">Phone</label><input type="tel" value="' + esc(cur.phone) + '" data-act="setphone" data-id="' + cur.id + '" placeholder="Optional"></div>' +
              '<div><label class="f">Email</label><input type="email" value="' + esc(cur.email) + '" data-act="setemail" data-id="' + cur.id + '" placeholder="Optional"></div>' +
            "</div>" +
            '<div class="field grid2">' +
              '<div><label class="f">City</label><input type="text" value="' + esc(cur.location) + '" data-act="setloc" data-id="' + cur.id + '" placeholder="Optional"></div>' +
              '<div><label class="f">Notes</label><input type="text" value="' + esc(cur.notes) + '" data-act="setnotes" data-id="' + cur.id + '" placeholder="Optional"></div>' +
            "</div>" +
            '<div class="field"><label class="f">Tier — tapping saves and advances</label><div class="chips">' +
              TIERS.map(function (t) { return '<button class="chip" data-t="' + t + '" data-act="queuetier" data-val="' + t + '">' + t + "</button>"; }).join("") +
            "</div></div>" +
            '<div class="queue-nav">' +
              '<button class="btn-ghost" data-act="queueback"' + (queueHistory.length || queueIndex ? "" : " disabled") + '>← Back</button>' +
              '<button class="btn-ghost" data-act="queueskip">Skip →</button>' +
            "</div>" +
            '<div class="field"><button class="btn-danger" data-act="queuedelete" data-id="' + cur.id + '">Delete this contact</button></div>') +
      "</div>" +

      syncCardHTML() +

      '<div class="card"><h3>Clean up contacts</h3>' +
        '<p class="note">Bulk-remove people who are no longer part of your life. Defaults to contacts with ' +
        'no school or company tag — usually the oldest ones.</p>' +
        '<div class="field"><button class="btn-ghost" data-act="clopen">Start cleaning up →</button></div>' +
      "</div>" +

      '<div class="card"><h3>Import and export</h3>' +
        '<p class="note">CSV columns read: name, tier, purpose, company, school, location, notes, phone, email. You get a review screen before anything is saved. LinkedIn’s Connections.csv works directly.</p>' +
        '<div class="field"><input type="file" id="fileIn" accept=".csv,.vcf"></div>' +
        '<p class="note" id="importStatus"></p>' +
        '<div class="field"><button class="btn-ghost" data-act="export">Export everything as CSV</button>' +
        '<p class="hint">' + (state.settings.lastExport ? "Last export " + esc(state.settings.lastExport) + "." : "Never exported.") + ' Back this up monthly.</p></div>' +
        '<p class="hint" style="text-align:center;opacity:.55;margin-top:14px">Field Notes v' + APP_VERSION + '</p>' +
      "</div>";
  }

  function syncCardHTML() {
    var on = window.FNSync && FNSync.enabled();
    var cfg = on ? FNSync.config() : null;
    if (!on) {
      return '<div class="card"><h3>Sync across devices</h3>' +
        '<p class="note">Off. Turn it on to edit from your phone and laptop and have both stay current. ' +
        'Your contacts are encrypted on this device with your passphrase before upload — the server only ever stores gibberish.</p>' +
        '<div class="field"><label class="f">Passphrase</label>' +
          '<input type="password" id="syncPass" placeholder="Something you will remember" autocomplete="new-password"></div>' +
        '<p class="hint">There is no reset. If you forget it, the synced copy is unreadable — including to me.</p>' +
        '<div class="field"><button class="btn" data-act="syncon">Turn on sync</button></div>' +
        '<div class="field"><label class="f">Already synced on another device?</label>' +
          '<input type="text" id="syncJoin" placeholder="Paste the sync code from that device" autocomplete="off"></div>' +
        '<div class="field"><button class="btn-ghost" data-act="syncjoin">Join that sync</button></div>' +
        (syncMsg ? '<p class="note ' + (/fail|wrong|could not|no sync/i.test(syncMsg) ? "bad" : "ok") + '">' + esc(syncMsg) + "</p>" : "") +
      "</div>";
    }
    return '<div class="card"><h3>Sync <span class="dot-on"></span></h3>' +
      '<p class="note">On. ' + (cfg.lastSync ? "Last synced " + esc(String(cfg.lastSync).slice(0, 16).replace("T", " ")) + " UTC." : "Not yet uploaded.") + "</p>" +
      '<div class="field"><label class="f">Sync code — paste this on your other device</label>' +
        '<input type="text" readonly value="' + esc(cfg.id) + '" id="syncId" onclick="this.select()"></div>' +
      '<p class="hint">The code alone is useless without your passphrase.</p>' +
      '<div class="field"><button class="btn"' + (syncBusy ? " disabled" : "") + ' data-act="syncnow">' + (syncBusy ? "Syncing…" : "Sync now") + "</button></div>" +
      (syncMsg ? '<p class="note ' + (/fail|wrong|could not|error/i.test(syncMsg) ? "bad" : "ok") + '">' + esc(syncMsg) + "</p>" : "") +
      '<div class="field"><button class="btn-ghost" data-act="syncoff">Turn off sync on this device</button></div>' +
    "</div>";
  }

  /* ============================================================
     Render
     ============================================================ */
  function render() {
    document.getElementById("totalCount").textContent = state.contacts.length + " contacts";
    var pend = state.contacts.filter(function (c) { return c.pending; }).length;
    var pill = document.getElementById("pendingPill");
    pill.hidden = !pend;
    pill.textContent = pend;

    var coldN = state.contacts.filter(function (c) { var i = coldInfo(c); return i && i.cold && !c.pending; }).length;
    var cpill = document.getElementById("coldPill");
    if (cpill) { cpill.hidden = !coldN; cpill.textContent = coldN; }

    var tabs = document.querySelectorAll(".tab");
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].dataset.tab === tab;
      tabs[i].classList.toggle("on", on);
      tabs[i].setAttribute("aria-selected", on ? "true" : "false");
    }

    var boot = document.getElementById("bootMsg");
    if (boot && boot.parentNode) boot.parentNode.removeChild(boot);

    document.getElementById("view").innerHTML =
      tab === "tiering" ? viewTiering() :
      tab === "reconnect" ? viewReconnect() :
      tab === "travel" ? viewTravel() : viewAdd();

    var ts = document.getElementById("tierSearch");
    if (ts && tab === "tiering") {
      ts.addEventListener("input", function () { tierQuery = ts.value; renderListOnly(); });
    }
    var cl = document.getElementById("clSearch");
    if (cl && cleanup) {
      cl.addEventListener("input", function () { cleanup.q = cl.value; renderListOnly(); });
    }
    var tv = document.getElementById("travelSearch");
    if (tv && tab === "travel") {
      tv.addEventListener("input", function () { travelQuery = tv.value; renderListOnly(); });
    }
    var fi = document.getElementById("fileIn");
    if (fi) fi.addEventListener("change", handleFile);

    renderNudge();
    window.__FIELD_NOTES_READY = true;
  }

  // Re-render without stealing focus from a search box mid-typing.
  var reListTimer = null;
  function renderListOnly() {
    clearTimeout(reListTimer);
    reListTimer = setTimeout(function () {
      var active = document.activeElement, id = active && active.id, pos = active && active.selectionStart;
      render();
      if (id) {
        var el = document.getElementById(id);
        if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch (e) {} }
      }
    }, 120);
  }

  function renderNudge() {
    var host = document.getElementById("nudge");
    if (!host) return;
    var c = nudgeFor ? byId(nudgeFor) : null;
    var i = c ? coldInfo(c) : null;
    if (!c || !i || !i.cold) { host.hidden = true; host.innerHTML = ""; return; }
    host.hidden = false;
    host.innerHTML =
      '<div class="nudge-body">' +
        '<span class="nudge-lbl">Talked to them lately?</span>' +
        '<strong>' + esc(c.name) + "</strong>" +
        '<span class="nudge-sub">' + c.tier + " · " +
          (i.everMarked ? i.days + " days since you marked contact"
                        : i.days + " days in this tier, never marked") + "</span>" +
      "</div>" +
      '<div class="nudge-acts">' +
        '<button class="tbtn primary" data-act="marktouch" data-id="' + c.id + '">Yes, recently</button>' +
        '<button class="tbtn" data-act="nudgeopen">Open</button>' +
        '<button class="tbtn" data-act="nudgesnooze">Later</button>' +
      "</div>";
  }

  var toastTimer = null;
  function toast(msg, actionLabel, actionAct) {
    var t = document.getElementById("toast");
    t.innerHTML = esc(msg) + (actionLabel ? ' <button class="toast-act" data-act="' + actionAct + '">' + esc(actionLabel) + "</button>" : "");
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, actionLabel ? 6000 : 2000);
  }

  /* ============================================================
     Sync glue
     ============================================================ */
  function scheduleSync() {
    if (!(window.FNSync && FNSync.enabled())) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(function () { doSync(true); }, 4000);
  }
  function doSync(quiet) {
    if (!(window.FNSync && FNSync.enabled()) || syncBusy) return;
    syncBusy = true;
    if (!quiet) { syncMsg = ""; render(); }
    FNSync.syncNow(state).then(function (res) {
      syncBusy = false;
      state = migrate(res.state);
      save();
      syncMsg = "Synced " + new Date().toLocaleTimeString();
      render();
      if (!quiet) toast("Synced");
    }).catch(function (err) {
      syncBusy = false;
      var m = err && err.message ? err.message : "unknown";
      syncMsg = m === "WRONG_PASSPHRASE"
        ? "Wrong passphrase for this sync code."
        : /failed to fetch|networkerror|load failed/i.test(m)
          // Offline is the common case, and it is harmless: every edit is
          // already written to this device before sync is ever attempted.
          ? "No connection — your changes are saved on this device and will sync next time."
          : "Sync failed: " + m;
      render();
      if (!quiet) toast(syncMsg);
    });
  }

  /* ============================================================
     Events
     ============================================================ */
  document.addEventListener("click", function (e) {
    var tabBtn = e.target.closest(".tab");
    if (tabBtn) { tab = tabBtn.dataset.tab; openId = null; importPreview = null; cleanup = null; render(); return; }

    var el = e.target.closest("[data-act]");
    if (!el) return;
    var act = el.dataset.act, id = el.dataset.id, val = el.dataset.val;
    var c = id ? byId(id) : null;

    switch (act) {
      case "toggle": openId = openId === id ? null : id; render(); break;
      case "opencontact": {
        var oc = byId(id);
        if (oc) { tab = "tiering"; browseBy = "tier"; tierFilter = oc.tier; tierQuery = ""; searchAll = false; openId = oc.id; }
        render();
        break;
      }
      case "browseby": browseBy = val; groupFilter = ""; tierQuery = ""; searchAll = false; openId = null; render(); break;
      case "filter": tierFilter = val; tierQuery = ""; searchAll = false; openId = null; render(); break;
      case "filterclose": tab = "tiering"; browseBy = "tier"; tierFilter = "Close"; render(); break;
      case "group": groupFilter = groupFilter === val ? "" : val; tierQuery = ""; openId = null; render(); break;
      case "clearsearch": tierQuery = ""; searchAll = false; render(); break;
      case "toggleall": searchAll = !searchAll; render(); break;
      case "gotoadd": tab = "add"; render(); break;
      case "dismissonboard": state.settings.onboarded = true; commit(); break;
      case "setcity": travelQuery = val; render(); break;

      case "settier":
        if (c.tier !== val) c.tierSince = today();   // new tier, fresh clock
        c.tier = val; c.pending = false; c.snoozedUntil = "";
        touch(c); commit();
        break;
      case "setpurpose": c.purpose = c.purpose === val ? "" : val; touch(c); commit(); break;
      case "setpot": c.potential = c.potential === val ? "" : val; touch(c); commit(); break;
      case "setrole": {
        var i = c.roles.indexOf(val);
        if (i === -1) c.roles.push(val); else c.roles.splice(i, 1);
        touch(c); commit();
        break;
      }
      case "roleother": c.showOther = !c.showOther; if (!c.showOther) { c.roleOther = ""; touch(c); } render(); break;
      case "confirmloc": c.locationConfirmed = today(); touch(c); commit(); toast("City confirmed"); break;
      case "marktouch": case "logtalk": {
        c.lastContact = today();
        c.snoozedUntil = "";
        c.touches = (c.touches || 0) + 1;
        touch(c);
        if (nudgeFor === c.id) nudgeFor = null;
        commit();
        toast("Marked — talked to " + (c.name || "").split(" ")[0] + " today");
        break;
      }
      case "nudgesnooze": {
        var n = byId(nudgeFor);
        if (n) { n.snoozedUntil = addDays(today(), SNOOZE_DAYS); touch(n); }
        nudgeFor = null; commit();
        break;
      }
      case "nudgeopen": {
        var o = byId(nudgeFor);
        nudgeFor = null;
        if (o) { tab = "tiering"; browseBy = "tier"; tierFilter = o.tier; searchAll = false; tierQuery = ""; openId = o.id; }
        render();
        break;
      }

      case "delete": deleteContact(c); break;
      case "undodelete": undoDelete(); break;
      case "queuedelete": {
        var pend = state.contacts.filter(function (x) { return x.pending; });
        var was = queueIndex;
        deleteContact(c);
        queueIndex = Math.min(was, Math.max(0, pend.length - 2));
        render();
        break;
      }

      case "qtier": qDraft.tier = val; syncChips("#qTier", val); break;
      case "qpurpose": qDraft.purpose = qDraft.purpose === val ? "" : val; syncChips("#qPurpose", qDraft.purpose); break;
      case "qpot": qDraft.potential = qDraft.potential === val ? "" : val; syncChips("#qPot", qDraft.potential); break;
      case "quickadd": quickAdd(); break;

      case "queuetier": {
        var p = state.contacts.filter(function (x) { return x.pending; });
        var person = p[queueIndex];
        if (person) {
          queueHistory.push({ id: person.id, tier: person.tier });
          person.tier = val; person.pending = false; touch(person);
          commit();
        }
        break;
      }
      case "queueskip": {
        var q = state.contacts.filter(function (x) { return x.pending; });
        if (q.length) queueIndex = (queueIndex + 1) % q.length;
        render();
        break;
      }
      case "queueback": {
        if (queueHistory.length) {
          var last = queueHistory.pop();
          var back = byId(last.id);
          if (back) {
            back.pending = true; back.tier = last.tier; touch(back);
            commitQuiet();
            var list = state.contacts.filter(function (x) { return x.pending; });
            for (var k = 0; k < list.length; k++) if (list[k].id === back.id) queueIndex = k;
          }
          render();
        } else if (queueIndex > 0) {
          queueIndex--; render();
        }
        break;
      }

      /* import preview */
      case "pvdupe": importPreview.dupeMode = val; render(); break;
      case "pvrespect": importPreview.respectFile = (val === "true"); render(); break;
      case "pvdefault": importPreview.defaultTier = val; render(); break;
      case "pvgroupby": importPreview.groupBy = val; importPreview.groups = {}; render(); break;
      case "pvgroup": {
        var g = el.dataset.g;
        importPreview.groups[g] = importPreview.groups[g] === val ? "" : val;
        render();
        break;
      }
      case "pvconfirm": applyImport(); break;
      case "pvcancel": importPreview = null; render(); toast("Import cancelled"); break;

      /* sync */
      case "syncon": {
        var pass = (document.getElementById("syncPass") || {}).value || "";
        if (pass.length < 8) { syncMsg = "Use at least 8 characters."; render(); break; }
        FNSync.enable(pass);
        syncMsg = "Sync on — uploading…";
        render();
        doSync(false);
        break;
      }
      case "syncjoin": {
        var jid = ((document.getElementById("syncJoin") || {}).value || "").trim();
        var jpass = ((document.getElementById("syncPass") || {}).value || "");
        if (!jid || !jpass) { syncMsg = "Paste the sync code and your passphrase."; render(); break; }
        syncBusy = true; syncMsg = "Joining…"; render();
        FNSync.adopt(jid, jpass).then(function (remote) {
          syncBusy = false;
          state = migrate(FNSync.merge(state, migrate(remote)));
          save();
          syncMsg = "Joined — " + state.contacts.length + " contacts after merge.";
          render(); toast("Sync joined");
        }).catch(function (err) {
          syncBusy = false;
          syncMsg = err.message === "WRONG_PASSPHRASE" ? "Wrong passphrase."
            : err.message === "NO_SUCH_SYNC" ? "No sync found for that code."
            : "Could not join: " + err.message;
          render();
        });
        break;
      }
      case "syncnow": doSync(false); break;
      case "syncoff":
        if (confirm("Turn off sync on this device? Your contacts stay here; the encrypted copy stays on the server until overwritten.")) {
          FNSync.disable(); syncMsg = ""; render(); toast("Sync off");
        }
        break;

      case "clopen": cleanup = { filter: "untagged", marked: {}, q: "" }; tab = "add"; render(); break;
      case "clexit": cleanup = null; render(); break;
      case "clfilter": cleanup.filter = val; render(); break;
      case "clnone": cleanup.marked = {}; render(); break;
      case "clmark":
        cleanup.marked[id] = !cleanup.marked[id];
        if (!cleanup.marked[id]) delete cleanup.marked[id];
        render();
        break;
      case "cldelete": {
        var ids = Object.keys(cleanup.marked).filter(function (k) { return cleanup.marked[k]; });
        if (!ids.length) break;
        if (!confirm("Delete " + ids.length + " contact" + (ids.length === 1 ? "" : "s") + "? You get one undo.")) break;
        var removed = state.contacts.filter(function (c) { return ids.indexOf(c.id) !== -1; });
        state.contacts = state.contacts.filter(function (c) { return ids.indexOf(c.id) === -1; });
        removed.forEach(function (c) { state.deleted.push({ id: c.id, at: nowISO() }); });
        lastDeleted = { bulk: removed };
        cleanup.marked = {};
        commit();
        clearTimeout(undoTimer);
        undoTimer = setTimeout(function () { lastDeleted = null; }, 10000);
        toast("Deleted " + removed.length, "Undo", "undodelete");
        break;
      }
      case "export": exportCSV(); break;
    }
  });

  function syncChips(sel, val) {
    var nodes = document.querySelectorAll(sel + " .chip");
    for (var i = 0; i < nodes.length; i++) nodes[i].classList.toggle("on", nodes[i].dataset.val === val);
  }

  document.addEventListener("input", function (e) {
    var el = e.target.closest("[data-act]");
    if (!el || !el.dataset.id) return;
    var c = byId(el.dataset.id);
    if (!c) return;
    var map = {
      setloc: "location", setnotes: "notes", setco: "company", setsc: "school",
      setphone: "phone", setemail: "email", setroleother: "roleOther"
    };
    var field = map[el.dataset.act];
    if (field) { c[field] = el.value; touch(c); commitQuiet(); }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && e.target.id === "qName") { e.preventDefault(); quickAdd(); }
  });

  function val(id) {
    var el = document.getElementById(id);
    return el && el.value ? el.value.trim() : "";
  }

  /* ============================================================
     Mutations
     ============================================================ */
  function deleteContact(c) {
    if (!c) return;
    var idx = state.contacts.indexOf(c);
    lastDeleted = { contact: c, index: idx };
    state.contacts.splice(idx, 1);
    state.deleted.push({ id: c.id, at: nowISO() });
    commit();
    clearTimeout(undoTimer);
    undoTimer = setTimeout(function () { lastDeleted = null; }, 6000);
    toast("Deleted " + (c.name || "contact"), "Undo", "undodelete");
  }
  function undoDelete() {
    if (!lastDeleted) { toast("Nothing to undo"); return; }
    if (lastDeleted.bulk) {
      var back = lastDeleted.bulk;
      back.forEach(function (c) { touch(c); state.contacts.push(c); });
      var ids = back.map(function (c) { return c.id; });
      state.deleted = state.deleted.filter(function (x) { return ids.indexOf(x.id) === -1; });
      lastDeleted = null;
      commit();
      toast("Restored " + back.length + " contacts");
      return;
    }
    var d = lastDeleted;
    state.contacts.splice(Math.min(d.index, state.contacts.length), 0, d.contact);
    state.deleted = state.deleted.filter(function (x) { return x.id !== d.contact.id; });
    touch(d.contact);
    lastDeleted = null;
    commit();
    toast("Restored " + (d.contact.name || "contact"));
  }

  function quickAdd() {
    var name = val("qName");
    if (!name) { toast("Add a name first"); return; }
    var loc = val("qLoc");
    state.contacts.unshift(blankContact({
      name: name, tier: qDraft.tier, purpose: qDraft.purpose, potential: qDraft.potential,
      company: val("qCo"), school: val("qSc"), location: loc,
      locationConfirmed: loc ? today() : "", notes: val("qNotes"), added: today()
    }));
    qDraft = { tier: "Middle", purpose: "", potential: "" };
    commit();
    toast("Saved " + name);
    var n = document.getElementById("qName");
    if (n) n.focus();
  }

  /* ============================================================
     Import / export
     ============================================================ */
  function splitCSVLine(line) {
    var out = [], cur = "", q = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      if (ch === '"') {
        if (q && line.charAt(i + 1) === '"') { cur += '"'; i++; }
        else q = !q;
      } else if (ch === "," && !q) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out.map(function (s) { return s.trim(); });
  }

  function parseCSV(text) {
    var lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (lines.length < 2) return [];
    var headerIdx = 0;
    for (var i = 0; i < Math.min(lines.length, 8); i++) {
      if (/first name|full name|^name,/i.test(lines[i])) { headerIdx = i; break; }
    }
    var headers = splitCSVLine(lines[headerIdx]).map(function (h) { return h.toLowerCase().replace(/^﻿/, ""); });
    return lines.slice(headerIdx + 1).map(function (line) {
      var cells = splitCSVLine(line), row = {};
      headers.forEach(function (h, i) { row[h] = cells[i] || ""; });
      var name = row.name || row["full name"] ||
        [row["first name"], row["last name"]].filter(Boolean).join(" ");
      var hasTier = TIERS.indexOf(row.tier) !== -1;
      return blankContact({
        name: name,
        tier: hasTier ? row.tier : "Acquaintance",
        purpose: PURPOSES.indexOf(row.purpose) !== -1 ? row.purpose : "",
        company: row.company || row.organization || "",
        school: row.school || "",
        location: row.location || row.city || "",
        notes: row.notes || row.position || "",
        phone: row.phone || row["phone number"] || "",
        email: row["email address"] || row.email || "",
        roleOther: row.role || "",
        pending: !hasTier,
        added: ""
      });
    }).filter(function (c) { return c.name; });
  }

  function parseVCF(text) {
    var cards = text.split(/END:VCARD/i), out = [];
    cards.forEach(function (card) {
      if (!/BEGIN:VCARD/i.test(card)) return;
      var name = (card.match(/^FN[^:]*:(.+)$/im) || [])[1] || "";
      var tel = (card.match(/^TEL[^:]*:(.+)$/im) || [])[1] || "";
      var em = (card.match(/^EMAIL[^:]*:(.+)$/im) || [])[1] || "";
      var org = (card.match(/^ORG[^:]*:(.+)$/im) || [])[1] || "";
      if (!name.trim()) return;
      out.push(blankContact({
        name: name.trim(), tier: "Acquaintance", company: org.split(";")[0].trim(),
        phone: tel.trim(), email: em.trim(), pending: true
      }));
    });
    return out;
  }

  function handleFile(e) {
    var f = e.target.files && e.target.files[0];
    if (!f) return;
    var status = document.getElementById("importStatus");
    var reader = new FileReader();
    reader.onload = function (ev) {
      var text = String(ev.target.result || "");
      var rows;
      try {
        rows = /\.vcf$/i.test(f.name) || /BEGIN:VCARD/i.test(text.slice(0, 200))
          ? parseVCF(text) : parseCSV(text);
      } catch (err) { rows = []; }
      if (!rows.length) {
        if (status) status.textContent = "Could not read any contacts from that file.";
        return;
      }
      var idx = buildDupeIndex();
      importPreview = {
        rows: rows.map(function (c) {
          var hit = null;
          dupeKeys(c).some(function (k) { if (idx[k]) { hit = idx[k]; return true; } return false; });
          return { c: c, dupe: hit ? hit.id : null };
        }),
        dupeMode: "skip", defaultTier: "Unsorted", groupBy: "school", groups: {}, respectFile: true
      };
      e.target.value = "";
      render();
    };
    reader.readAsText(f);
  }

  function applyImport() {
    var P = importPreview, added = 0, updated = 0, skipped = 0;
    P.rows.forEach(function (r) {
      if (r.dupe) {
        if (P.dupeMode === "update") {
          var ex = byId(r.dupe);
          if (ex) {
            ["company", "school", "location", "phone", "email"].forEach(function (f) {
              if (!ex[f] && r.c[f]) ex[f] = r.c[f];
            });
            if (r.c.notes && ex.notes.indexOf(r.c.notes) === -1) {
              ex.notes = ex.notes ? ex.notes + " · " + r.c.notes : r.c.notes;
            }
            touch(ex); updated++;
          }
        } else skipped++;
        return;
      }
      var t = effTier(P, r);
      var c = r.c;
      if (t === "Unsorted") { c.pending = true; c.tier = "Acquaintance"; }
      else { c.pending = false; c.tier = t; }
      touch(c);
      state.contacts.push(c);
      added++;
    });
    importPreview = null;
    queueHistory = []; queueIndex = 0;
    commit();
    toast("Imported " + added + (updated ? ", updated " + updated : "") + (skipped ? ", skipped " + skipped : ""));
  }

  function exportCSV() {
    var cols = ["name", "tier", "role", "purpose", "potential", "company", "school",
                "location", "locationConfirmed", "lastContact", "notes", "phone", "email"];
    var lines = [cols.join(",")];
    state.contacts.forEach(function (c) {
      lines.push(cols.map(function (k) {
        var v = k === "role" ? (c.roles || []).concat(c.roleOther ? [c.roleOther] : []).join("; ") : (c[k] == null ? "" : c[k]);
        v = String(v);
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(","));
    });
    var blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "field-notes-" + today() + ".csv";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    state.settings.lastExport = today();
    commit();
    toast("Exported " + state.contacts.length + " contacts");
  }

  /* ============================================================
     Install prompt
     ============================================================ */
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredPrompt = e;
    var b = document.getElementById("installBtn");
    if (b) b.hidden = false;
  });
  var installBtn = document.getElementById("installBtn");
  if (installBtn) {
    installBtn.addEventListener("click", function () {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      deferredPrompt = null;
      installBtn.hidden = true;
    });
  }

  /* ============================================================
     Boot
     ============================================================ */
  state = load();
  save();
  var firstNudge = nudgeCandidate();
  nudgeFor = firstNudge ? firstNudge.id : null;
  render();
  if (window.FNSync && FNSync.enabled()) doSync(true);
})();
