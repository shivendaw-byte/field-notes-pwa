/* Field Notes — a private relationship tracker.
   Contacts live in this browser. If sync is on, they are encrypted on this
   device before upload (see sync.js) — the server never sees plaintext. */

(function () {
  "use strict";

  /* ============================================================
     Constants
     ============================================================ */
  var TIERS = ["Close", "Middle", "Acquaintance", "Networking"];
  /* Five levels: Rare and Low are the extremes, with three usable steps between
     so "Some" stops absorbing everything ambiguous. Existing Some ratings are
     deliberately left alone — nothing silently rewrites a judgement you made. */
  var POTENTIAL = [
    { key: "Rare",     lvl: 5, blurb: "the standout — rare" },
    { key: "Strong",   lvl: 4, blurb: "clear pull toward more" },
    { key: "Moderate", lvl: 3, blurb: "genuine, worth tending" },
    { key: "Some",     lvl: 2, blurb: "could go somewhere" },
    { key: "Low",      lvl: 1, blurb: "fine as it is" }
  ];
  var POT_STEPS = 5;
  /* Notes shortcuts. These are NOT structured fields — tapping one types plain
     text into the notes box, so ordinary search still finds it and nothing has
     to be filled in for a contact to be complete. Revealed only when the user
     types the trigger word, so the form stays empty by default. */
  var NOTE_CHIPS = {
    role:     ["Family", "Friend", "Professional"],
    quality:  ["\ud83e\udde0 Intellectual", "\ud83c\udf31 Present", "\u2600\ufe0f Positive",
               "\u26a1 Spontaneous", "\ud83d\ude80 Growth-oriented"],
    outreach: ["\ud83d\udcac Talk", "\ud83c\udf89 Do", "\ud83e\udd1d Build", "\u2764\ufe0f Care"]
  };
  var NOTE_TRIGGERS = ["role", "quality", "outreach"];

  /* How long before someone counts as going cold. Close and Middle only —
     Networking and Acquaintance are deliberately absent, so the 800-odd people
     in those tiers can never generate a reminder.

     The clock does NOT require logging. It starts when someone enters a tracked
     tier and resets whenever you confirm you are in touch, so this works fine
     for someone who never logs a single conversation. */
  /* Days before someone becomes an opportunity, by tier and by how much
     potential you gave them. Higher potential surfaces sooner. */
  var COLD_TABLE = {
    Close:        { Rare: 14,  Strong: 21,  Moderate: 28,  Some: 35  },
    Middle:       { Rare: 40,  Strong: 60,  Moderate: 75,  Some: 90  },
    Acquaintance: { Rare: 60,  Strong: 100, Moderate: 125, Some: 150 },
    Networking:   { Rare: 120, Strong: 180, Moderate: 210, Some: 240 }
  };
  var SNOOZE_DAYS = 10;
  var MIN_POTENTIAL = 2;   // Some/Strong/Rare surface; Low and unset never do.

  /* Three independent display settings: nav labels, tier labels, and whether
     the explanatory subheadings show at all. Symbol mode also means nobody
     glancing at the screen can read what any of it is. */
  var SYMBOLS = {
    tiering: "\u227B", log: "\u03A3", past: "\u222B",
    reconnect: "\u22C8", add: "\u2295", insights: "\u0394"
  };
  /* Close, Middle and Acquaintance are degrees of closeness. Networking is a
     different purpose entirely, so it gets a connector rather than a degree. */
  var TIER_SYMBOL = { Close: "1\u00B0", Middle: "2\u00B0", Acquaintance: "3\u00B0", Networking: "\u21C4" };
  var TIER_EMOJI  = { Close: "\uD83D\uDC9B", Middle: "\uD83C\uDF3F", Acquaintance: "\uD83D\uDC4B", Networking: "\uD83E\uDD1D" };

  function setting(k, dflt) {
    return (state && state.settings && state.settings[k]) || dflt;
  }
  function navLabel(key, text) {
    var mode = setting("navMode", "text"), sym = SYMBOLS[key];
    if (!sym || mode === "text") return esc(text);
    if (mode === "symbol") return '<span class="sym" title="' + esc(text) + '">' + sym + "</span>";
    return '<span class="sym">' + sym + '</span><span class="symtext">' + esc(text) + "</span>";
  }
  function tierLabel(t) {
    var mode = setting("tierMode", "name");
    if (mode === "symbol") return TIER_SYMBOL[t] || t;
    if (mode === "emoji") return TIER_EMOJI[t] || t;
    return t;
  }
  /* Subheadings are the one-line explanations under each screen title. Once you
     know the app they are noise, so they can be switched off entirely. */
  function subLine(text) {
    return setting("showSub", "on") === "on" ? '<p class="sub">' + text + "</p>" : "";
  }

  var APP_VERSION = "9.1";
  var KEY = "field-notes-v4";     // kept: migrates older saves in place
  var BACKUP_NAG_DAYS = 30;

  /* ============================================================
     State
     ============================================================ */
  var memoryFallback = null;
  var state, tab = "tiering", openId = null;
  var browseBy = "tier", tierFilter = "Close", groupFilter = "";
  var tierQuery = "", logQuery = "", searchAll = false;
  var orderSnapshot = null;   // frozen contact order for the current tier/grouping
  var logSub = "daily";        // daily | past
  var calMonth = null;         // Date anchored to the 1st of the shown month
  var calDay = "";             // selected day in the past view
  var nudgeFor = null;   // contact id currently shown in the reminder card
  var cleanup = null;    // { filter, marked:{id:true} } when the purge screen is open
  var queueIndex = 0, queueHistory = [];
  var qDraft = { tier: "Middle", potential: "" };
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
  /* Whole days from a to b; negative when b precedes a. */
  function daysBetween(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }
  /* Interaction dates are stored ascending, unique, one per day. */
  function dedupeDates(list) {
    var seen = {}, out = [];
    (list || []).forEach(function (d) {
      if (!d || seen[d]) return;
      seen[d] = 1;
      out.push(d);
    });
    return out.sort();
  }
  function logInteraction(c, date) {
    c.interactions = dedupeDates((c.interactions || []).concat(date || today()));
    c.lastContact = c.interactions[c.interactions.length - 1];
  }
  function unlogInteraction(c, date) {
    var d = date || today();
    c.interactions = (c.interactions || []).filter(function (x) { return x !== d; });
    c.lastContact = c.interactions.length ? c.interactions[c.interactions.length - 1] : "";
  }
  function interactionCount(c) { return (c.interactions || []).length; }

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
      id: uid(), name: "", tier: "Acquaintance", potential: "",
      company: "", school: "", location: "", locationConfirmed: "",
      notes: "", phone: "", email: "", pending: false, added: "",
      interactions: [], lastContact: "", tierLog: [],
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
    if (!s.settings.navMode) s.settings.navMode = "text";      // text | both | symbol
    if (!s.settings.tierMode) s.settings.tierMode = "name";     // name | symbol | emoji
    if (!s.settings.showSub) s.settings.showSub = "on";         // on | off
    /* Display preferences. Defaults reproduce the behaviour that shipped, so an
       existing install sees no change until it opts in. */
    if (!s.settings.subtitle || typeof s.settings.subtitle !== "object") {
      s.settings.subtitle = { location: true, notes: false, company: false, school: false, potential: false };
    }
    if (!s.settings.reconnect) s.settings.reconnect = "on";   // on | background | off
    if (!s.updatedAt) s.updatedAt = nowISO();
    s.version = 5;
    s.contacts.forEach(function (c) {
      // Role and "reach out for" were removed; keep what was typed by moving it
      // into notes, where the chip shortcuts now live.
      var carried = [].concat(Array.isArray(c.roles) ? c.roles : [],
                              c.roleOther ? [c.roleOther] : [],
                              (c.purpose && c.purpose !== "Networking") ? [c.purpose] : [])
                      .filter(Boolean);
      if (carried.length) {
        var add = carried.filter(function (v) { return (c.notes || "").indexOf(v) === -1; });
        if (add.length) c.notes = (c.notes ? c.notes.replace(/\s*$/, "") + " " : "") + add.join(" ");
      }
      delete c.roles; delete c.roleOther; delete c.purpose; delete c.showOther;
      /* v9: lastContact/prevContact/touches collapse into a dated history.
         Nothing is discarded - every date already recorded becomes an entry. */
      if (!Array.isArray(c.interactions)) {
        var seed = [];
        if (c.prevContact) seed.push(c.prevContact);
        if (c.lastContact && c.lastContact !== c.prevContact) seed.push(c.lastContact);
        c.interactions = seed;
      }
      c.interactions = dedupeDates(c.interactions);
      c.lastContact = c.interactions.length ? c.interactions[c.interactions.length - 1] : "";
      delete c.prevContact;
      delete c.touches;
      if (!Array.isArray(c.tierLog)) c.tierLog = [];
      if (c.snoozedUntil === undefined) c.snoozedUntil = "";
      // Baseline for the reconnect clock when nothing has ever been logged.
      if (!c.tierSince) c.tierSince = c.lastContact || c.added || today();
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
    // Notes are searched whole, so chip text is found by ordinary search.
    return [c.name, c.company, c.school, c.location, c.potential, c.notes, c.tier]
      .filter(Boolean).join(" ");
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
  function potBlurb(p) {
    for (var i = 0; i < POTENTIAL.length; i++) if (POTENTIAL[i].key === p) return POTENTIAL[i].blurb;
    return "";
  }
  function potMeter(p) {
    var found = null;
    POTENTIAL.forEach(function (x) { if (x.key === p) found = x; });
    if (!found) return "";
    var bars = "";
    for (var i = 1; i <= POT_STEPS; i++) {
      bars += '<i class="' + (i <= found.lvl ? "on" : "") + '"></i>';
    }
    return '<span class="pot lv' + found.lvl + '" title="' + esc(found.key + " \u2014 " + found.blurb) +
      '" aria-label="Potential ' + found.lvl + ' of ' + POT_STEPS + '">' + bars + "</span>";
  }
  function tierBadge(t) {
    return '<span class="badge t-' + t.toLowerCase() + '" title="' + t + '">' + tierLabel(t) + "</span>";
  }
  function digits(s) { return String(s || "").replace(/[^\d+]/g, ""); }

  function activeTriggers(text) {
    var low = (text || "").toLowerCase();
    return NOTE_TRIGGERS.filter(function (w) {
      return new RegExp("(^|[^a-z])" + w + "([^a-z]|$)", "i").test(low);
    });
  }

  function noteChipsHTML(c) {
    var trig = activeTriggers(c.notes);
    if (!trig.length) {
      return '<p class="hint" style="margin-top:6px">Type <strong>role</strong>, <strong>quality</strong> ' +
        'or <strong>outreach</strong> in the notes for shortcuts. Nothing here is required.</p>';
    }
    return trig.map(function (k) {
      return '<div class="notechips"><span class="nc-lbl">' + k + "</span>" +
        NOTE_CHIPS[k].map(function (v) {
          return '<button class="chip sm" data-act="notechip" data-id="' + c.id +
            '" data-k="' + k + '" data-val="' + esc(v) + '">' + esc(v) + "</button>";
        }).join("") + "</div>";
    }).join("");
  }

  /* null means "not tracked": pending, unrated, or rated Low. Everyone else
     has a clock even if never logged — it falls back to when they entered
     the tier. Window depends on tier AND potential (see COLD_TABLE). */
  function coldInfo(c) {
    var byTier = COLD_TABLE[c.tier];
    var limit = byTier ? byTier[c.potential] : 0;
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
  function reconnectMode() { return (state.settings && state.settings.reconnect) || "on"; }
  function reconnectVisible() { return reconnectMode() === "on"; }
  function reconnectActive() { return reconnectMode() !== "off"; }

  function nudgeCandidate() {
    if (!reconnectActive()) return null;
    var best = null, bestOver = -1;
    state.contacts.forEach(function (c) {
      if (potLevel(c.potential) < MIN_POTENTIAL) return;
      var i = coldInfo(c);
      if (!i || !i.cold || i.snoozed) return;
      if (i.over > bestOver) { best = c; bestOver = i.over; }
    });
    return best;
  }

  /* Opening a contact is a deliberate act, so the timeline lives here rather
     than on the list. Oldest first: it reads as the arc of the relationship. */
  function historyHTML(c) {
    var h = c.interactions || [];
    var items = h.map(function (d, i) {
      var gap = i > 0 ? daysBetween(h[i - 1], d) : null;
      return '<li><span class="hdate">' + esc(d) + "</span>" +
        (i === 0 ? '<span class="hgap">first logged</span>'
                 : '<span class="hgap">' + gap + " days later</span>") + "</li>";
    }).join("");
    return '<div class="field"><label class="f">Interactions' +
        (h.length ? ' <span class="n">' + h.length + "</span>" : "") + "</label>" +
      (h.length ? '<ol class="history">' + items + "</ol>"
                : '<p class="hint" style="margin:0 0 8px">Nothing logged yet.</p>') +
      '<button class="btn-ghost sm" data-act="logpast" data-id="' + c.id + '">Log a past date</button></div>';
  }

  function rowHTML(c) {
    /* Subtitle rule: facts only. No emoji, no "unconfirmed", and never anything
       about when you last spoke — recency lives in Reconnect, not on every row,
       because seeing it everywhere is what turns this into a guilt tracker. */
    var sub = [];
    /* What appears here is entirely user-controlled (Settings > Row subtitle).
       Notes stay searchable regardless of whether they are shown. */
    var subCfg = state.settings.subtitle || {};
    if (subCfg.location && c.location) sub.push("<span>" + esc(c.location) + "</span>");
    if (subCfg.company && c.company) sub.push("<span>" + esc(c.company) + "</span>");
    if (subCfg.school && c.school) sub.push("<span>" + esc(c.school) + "</span>");
    if (subCfg.potential && c.potential) sub.push("<span>" + esc(c.potential) + " potential</span>");
    if (subCfg.notes && c.notes) {
      sub.push('<span style="opacity:.8">' + esc(c.notes.slice(0, 64)) + (c.notes.length > 64 ? "\u2026" : "") + "</span>");
    }

    return '<div class="row' + (openId === c.id ? " open" : "") + '" data-id="' + c.id + '">' +
      '<button class="row-head" data-act="toggle" data-id="' + c.id + '" aria-expanded="' + (openId === c.id) + '">' +
        '<span style="flex:1;min-width:0">' +
          '<span class="row-meta">' +
            '<span class="row-name">' + (esc(c.name) || "Unnamed") + "</span>" +
            tierBadge(c.tier) +
            (c.company ? '<span class="tag co">' + esc(c.company) + "</span>" : "") +
            (c.school ? '<span class="tag sc">' + esc(c.school) + "</span>" : "") +
            potMeter(c.potential) +
          "</span>" +
          (sub.length ? '<span class="row-sub">' + sub.join("") + "</span>" : "") +
        "</span>" +
        '<span class="caret" aria-hidden="true">▾</span>' +
      "</button>" +
      '<div class="row-body">' +
        '<div class="field"><label class="f">Tier — tap to move</label><div class="chips">' +
          TIERS.map(function (t) {
            return '<button class="chip' + (c.tier === t ? " on" : "") + '" data-t="' + t + '" data-act="settier" data-id="' + c.id + '" data-val="' + t + '">' + t + "</button>";
          }).join("") +
        "</div></div>" +
        '<div class="field"><label class="f">Potential to deepen</label><div class="chips">' +
          POTENTIAL.map(function (p) {
            return '<button class="chip' + (c.potential === p.key ? " on" : "") + '" data-p="1" data-act="setpot" data-id="' + c.id + '" data-val="' + p.key + '" title="' + p.blurb + '">' + p.key + "</button>";
          }).join("") +
        "</div></div>" +
        '<div class="field"><label class="f">Name</label>' +
          '<input type="text" value="' + esc(c.name) + '" data-act="setname" data-id="' + c.id + '" placeholder="Their name"></div>' +
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
        '<div class="field"><label class="f">Notes</label>' +
          '<textarea id="notes-' + c.id + '" rows="3" data-act="setnotes" data-id="' + c.id +
          '" placeholder="Where you met, what you talked about \u2014 anything you want.">' + esc(c.notes) + "</textarea>" +
          noteChipsHTML(c) + "</div>" +
        ((c.phone || c.email) ? '<div class="field" style="display:flex;gap:14px;flex-wrap:wrap">' +
          (c.phone ? '<a class="contactlink" href="tel:' + esc(digits(c.phone)) + '">Call</a>' : "") +
          (c.email ? '<a class="contactlink" href="mailto:' + esc(c.email) + '">Email</a>' : "") +
        "</div>" : "") +
        historyHTML(c) +
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

  /* Highest potential first, unrated last, alphabetical within a level. */
  function byPotential(a, b) {
    var pa = potLevel(a.potential), pb = potLevel(b.potential);
    if (pa !== pb) return pb - pa;
    return (a.name || "").localeCompare(b.name || "");
  }

  /* Rating someone mid-pass used to yank them up the list under your finger and
     lose your place. So the order is captured once per context and held until
     you leave it — switch tab, tier, or grouping and it recomputes. Contacts
     added since the snapshot sort to the end rather than jumping the queue. */
  function rankList(base) {
    if (!orderSnapshot) {
      var sorted = base.slice().sort(byPotential);
      orderSnapshot = sorted.map(function (c) { return c.id; });
      return sorted;
    }
    var pos = {};
    orderSnapshot.forEach(function (id, i) { pos[id] = i; });
    return base.slice().sort(function (a, b) {
      var ia = pos[a.id], ib = pos[b.id];
      if (ia === undefined && ib === undefined) return byPotential(a, b);
      if (ia === undefined) return 1;
      if (ib === undefined) return -1;
      return ia - ib;
    });
  }

  /* True when a rating changed since the snapshot, so the list is now out of
     order — used to offer a re-sort instead of silently doing nothing. */
  function orderIsStale(base) {
    if (!orderSnapshot) return false;
    var current = rankList(base);
    var fresh = base.slice().sort(byPotential);
    for (var i = 0; i < fresh.length; i++) {
      if (!current[i] || current[i].id !== fresh[i].id) return true;
    }
    return false;
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
      var field = browseBy === "school" ? "school"
        : browseBy === "city" ? "location" : "company";
      base = groupFilter
        ? state.contacts.filter(function (c) { return (c[field] || "") === groupFilter; })
        : [];
      heading = groupFilter || "";
    }

    /* Rank the whole tier first, then filter by search, so searching never
       reshuffles anyone. The ranking is frozen while you work (see rankList). */
    var list = searchContacts(rankList(base), tierQuery);

    // Never hide matches silently: if this tier has none but others do, say so.
    var elsewhere = 0;
    if (tierQuery && !list.length && !searchAll) {
      elsewhere = searchContacts(state.contacts, tierQuery).length;
    }

    var stale = orderIsStale(base);

    var filtersHTML;
    if (browseBy === "tier") {
      filtersHTML = TIERS.map(function (t) {
        var n = state.contacts.filter(function (c) { return c.tier === t && !c.pending; }).length;
        return '<button class="filter' + (tierFilter === t ? " on" : "") + '" data-act="filter" data-val="' + t + '" title="' + t + '">' + tierLabel(t) + '<span class="n">' + n + "</span></button>";
      }).join("") + (pending.length
        ? '<button class="filter' + (tierFilter === "Unsorted" ? " on" : "") + '" data-act="filter" data-val="Unsorted">Unsorted<span class="n">' + pending.length + "</span></button>"
        : "");
    } else {
      var vals = groupValues(browseBy === "school" ? "school"
        : browseBy === "city" ? "location" : "company");
      filtersHTML = vals.length
        ? vals.map(function (v) {
            return '<button class="filter' + (groupFilter === v.key ? " on" : "") + '" data-act="group" data-val="' + esc(v.key) + '">' + esc(v.key) + '<span class="n">' + v.n + "</span></button>";
          }).join("")
        : '<span class="note">No ' + browseBy + ' tags yet — add them on any contact.</span>';
    }

    return '<div class="eyebrow">Everyone, sorted</div><h2>Tiering</h2>' +
      subLine("Search covers names, notes and tags.") +
      onboardingHTML() +
      (pending.length ? '<div class="card warn rowsplit"><p class="note" style="margin:0">' + pending.length + ' imported contacts are waiting to be sorted.</p><button class="btn-ghost" data-act="gotoadd">Sort them →</button></div>' : "") +
      '<div class="seg" role="group" aria-label="Browse by">' +
        ["tier", "school", "company", "city"].map(function (b) {
          return '<button class="' + (browseBy === b ? "on" : "") + '" data-act="browseby" data-val="' + b + '">By ' + b + "</button>";
        }).join("") +
      "</div>" +
      (searchAll && tierQuery ? "" : '<div class="filters">' + filtersHTML + "</div>") +
      '<div class="searchwrap"><input type="search" id="tierSearch" value="' + esc(tierQuery) + '" placeholder="Search name, company, school, notes…" autocomplete="off" enterkeyhint="search">' +
        (tierQuery ? '<button class="clearx" data-act="clearsearch" aria-label="Clear search">×</button>' : "") +
      "</div>" +
      (stale
        ? '<div class="rowsplit resortbar"><p class="hint" style="margin:0">Ratings changed — order updates when you leave this list.</p>' +
          '<button class="btn-ghost sm" data-act="resort">Re-sort now</button></div>'
        : "") +
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

  /* Rows for the two screens where tracking is allowed to be visible: the Log
     (you chose to open it) and Reconnect (you chose to be prompted). Never on
     the contact list itself. */
  function logRowHTML(c, mode) {
    var d = daysSince(c.lastContact);
    var since = !c.lastContact ? "not logged yet"
      : d === 0 ? "logged today"
      : d === 1 ? "yesterday"
      : d + " days ago";
    return '<div class="logrow' + (d === 0 ? " donetoday" : "") + '">' +
      '<span class="body" data-act="opencontact" data-id="' + c.id + '">' +
        '<span class="t">' + (esc(c.name) || "Unnamed") + "</span>" +
        '<span class="d">' + tierBadge(c.tier) + "<span>" + since + "</span>" + potMeter(c.potential) + "</span>" +
      "</span>" +
      (mode === "undo"
        ? '<button class="logbtn undo" data-act="marktouch" data-id="' + c.id + '">Undo</button>'
        : '<button class="logbtn" data-act="marktouch" data-id="' + c.id + '">Log</button>') +
    "</div>";
  }

  function logTabsHTML() {
    return '<div class="seg">' +
      ["daily", "past"].map(function (k) {
        var txt = k === "daily" ? "Daily" : "Past";
        var sym = k === "daily" ? SYMBOLS.log : SYMBOLS.past;
        var mode = setting("navMode", "text");
        var shown = mode === "text" ? txt
          : mode === "symbol" ? '<span class="sym" title="' + txt + '">' + sym + "</span>"
          : '<span class="sym">' + sym + '</span><span class="symtext">' + txt + "</span>";
        return '<button class="' + (logSub === k ? "on" : "") + '" data-act="logsub" data-val="' + k + '">' + shown + "</button>";
      }).join("") + "</div>";
  }

  /* Which contacts were logged on a given day. */
  function contactsOn(date) {
    return state.contacts.filter(function (c) {
      return (c.interactions || []).indexOf(date) !== -1;
    }).sort(function (a, b) { return (a.name || "").localeCompare(b.name || ""); });
  }

  function viewPast() {
    if (!calMonth) { calMonth = new Date(); calMonth.setDate(1); }
    var y = calMonth.getFullYear(), m = calMonth.getMonth();
    var first = new Date(y, m, 1), startDow = first.getDay();
    var daysInMonth = new Date(y, m + 1, 0).getDate();
    var todayStr = today();

    var counts = {};
    state.contacts.forEach(function (c) {
      (c.interactions || []).forEach(function (d) { counts[d] = (counts[d] || 0) + 1; });
    });

    var cells = "";
    for (var i = 0; i < startDow; i++) cells += '<span class="cal-pad"></span>';
    for (var d = 1; d <= daysInMonth; d++) {
      var iso = y + "-" + String(m + 1).padStart(2, "0") + "-" + String(d).padStart(2, "0");
      var n = counts[iso] || 0;
      var cls = "cal-day" + (n ? " has" : "") + (iso === calDay ? " sel" : "") + (iso === todayStr ? " today" : "");
      cells += '<button class="' + cls + '" data-act="calday" data-val="' + iso + '">' + d +
        (n ? '<i class="dot"></i>' : "") + "</button>";
    }

    var picked = calDay ? contactsOn(calDay) : [];

    return '<div class="eyebrow">Past</div><h2>' + navLabel("past", "Past logs") + "</h2>" +
      subLine("Days you logged someone. Tap a day to see who.") +
      logTabsHTML() +
      '<div class="calhead">' +
        '<button class="btn-ghost sm" data-act="calprev">\u2039</button>' +
        "<span>" + calMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" }) + "</span>" +
        '<button class="btn-ghost sm" data-act="calnext">\u203A</button>' +
      "</div>" +
      '<div class="calgrid">' + ["S","M","T","W","T","F","S"].map(function (w) {
        return '<span class="cal-dow">' + w + "</span>";
      }).join("") + cells + "</div>" +
      (calDay
        ? (picked.length
            ? '<h3 class="logsec">' + esc(calDay) + ' <span class="n">' + picked.length + "</span></h3>" +
              '<div class="loglist">' + picked.map(function (c) {
                return '<div class="logrow"><span class="body" data-act="opencontact" data-id="' + c.id + '">' +
                  '<span class="t">' + (esc(c.name) || "Unnamed") + "</span>" +
                  '<span class="d">' + tierBadge(c.tier) + "</span></span>" +
                  '<button class="logbtn undo" data-act="unlogday" data-id="' + c.id + '" data-val="' + calDay + '">Remove</button>' +
                "</div>";
              }).join("") + "</div>"
            : '<div class="card"><p class="note" style="margin:0">Nothing logged on ' + esc(calDay) + ".</p></div>")
        : "");
  }

  function viewLog() {
    if (logSub === "past") return viewPast();
    var t = today();
    var active = state.contacts.filter(function (c) { return !c.pending; });
    var loggedToday = active.filter(function (c) { return c.lastContact === t; });
    loggedToday.sort(function (a, b) { return (a.name || "").localeCompare(b.name || ""); });
    var results = logQuery.trim()
      ? searchContacts(active, logQuery).filter(function (c) { return c.lastContact !== t; }).slice(0, 15)
      : [];

    return '<div class="eyebrow">Today</div><h2>' + navLabel("log", "Daily log") + "</h2>" +
      subLine("Log whoever you had a real conversation with.") +
      logTabsHTML() +

      '<div class="searchwrap"><input type="search" id="logSearch" value="' + esc(logQuery) +
        '" placeholder="Search a name to log them" autocomplete="off" enterkeyhint="search">' +
        (logQuery ? '<button class="clearx" data-act="clearlog" aria-label="Clear">\u00d7</button>' : "") +
      "</div>" +

      (logQuery.trim()
        ? (results.length
            ? '<div class="loglist">' + results.map(function (c) { return logRowHTML(c, "log"); }).join("") + "</div>"
            : '<div class="empty">Nobody matches \u201c' + esc(logQuery) + '\u201d.</div>')
        : "") +

      (loggedToday.length
        ? '<h3 class="logsec">Logged today <span class="n">' + loggedToday.length + "</span></h3>" +
          '<div class="loglist">' + loggedToday.map(function (c) { return logRowHTML(c, "undo"); }).join("") + "</div>"
        : (logQuery.trim() ? "" :
            '<div class="card"><h3>Nothing logged yet today</h3>' +
            '<p class="note">Search a name above and tap Log. Skipping days costs you nothing \u2014 ' +
            'an empty day just means nothing worth recording happened.</p></div>'));
  }

  /* Reconnect is framed as opportunity, not debt: it only ever lists people you
     yourself rated as worth deepening, ordered by that rating. */
  function worthReaching() {
    return state.contacts.filter(function (c) {
      if (potLevel(c.potential) < MIN_POTENTIAL) return false;
      var i = coldInfo(c);
      return i && i.cold;
    }).sort(function (a, b) {
      var pa = potLevel(a.potential), pb = potLevel(b.potential);
      if (pa !== pb) return pb - pa;
      return coldInfo(b).over - coldInfo(a).over;
    });
  }

  function reachRowHTML(c) {
    var where = [c.company, c.school, c.location].filter(Boolean).join(" \u00b7 ");
    return '<div class="logrow reach">' +
      '<span class="body" data-act="opencontact" data-id="' + c.id + '">' +
        '<span class="t">' + (esc(c.name) || "Unnamed") + "</span>" +
        '<span class="d">' + tierBadge(c.tier) + (where ? "<span>" + esc(where) + "</span>" : "") + "</span>" +
        '<span class="reach-why">' + potMeter(c.potential) + "<span>" + esc(potBlurb(c.potential)) + "</span></span>" +
      "</span>" +
      '<button class="logbtn" data-act="marktouch" data-id="' + c.id + '">Log</button>' +
    "</div>";
  }

  function viewReconnect() {
    var list = worthReaching();
    var rated = state.contacts.filter(function (c) {
      return potLevel(c.potential) >= MIN_POTENTIAL && !c.pending;
    }).length;

    return '<div class="eyebrow">Opportunities</div><h2>Worth reaching out to</h2>' +
      subLine("Rated worth deepening, not logged lately.") +

      (!rated
        ? '<div class="card"><h3>Nothing rated yet</h3><p class="note">Open anyone and set ' +
          '<strong>Potential to deepen</strong>. Only Some, Strong and Rare ever appear here \u2014 ' +
          'that rating is what makes this more than a contact list.</p></div>'
        : list.length
          ? '<div class="loglist">' + list.map(reachRowHTML).join("") + "</div>" +
            '<p class="hint" style="margin-top:14px">' + rated + " people are rated worth deepening. " +
            "Logging someone in the Daily log clears them from here.</p>"
          : '<div class="card ok-card"><h3>Nothing to chase</h3><p class="note">All ' + rated +
            " of the people you rated worth deepening have been logged recently.</p></div>");
  }

  var SUBTITLE_FIELDS = [
    { key: "location",  label: "City" },
    { key: "company",   label: "Company" },
    { key: "school",    label: "School" },
    { key: "potential", label: "Potential level" },
    { key: "notes",     label: "Notes preview" }
  ];

  function viewSettings() {
    var st = state.settings;
    var sub = st.subtitle || {};
    var mode = reconnectMode();
    var rated = state.contacts.filter(function (c) { return c.potential === "Some"; }).length;
    var total = state.contacts.length;
    var age = daysSince(st.lastExport);

    function toggleRow(key, label, on, act) {
      return '<button class="setrow" data-act="' + act + '" data-val="' + key + '">' +
        '<span class="setrow-label">' + label + "</span>" +
        '<span class="switch' + (on ? " on" : "") + '"><i></i></span></button>';
    }

    return '<div class="eyebrow">Everything, in one place</div><h2>Settings</h2>' +
      subLine("Nothing here changes your contacts \u2014 only what the app shows you and how it behaves.") +

      /* --- what a row shows --- */
      '<div class="card"><h3>Row subtitle</h3>' +
        '<p class="note">The small grey line under each name in your contact list. ' +
        'Notes stay searchable whether or not you show them here.</p>' +
        SUBTITLE_FIELDS.map(function (f) {
          return toggleRow(f.key, f.label, !!sub[f.key], "setsub");
        }).join("") +
        (Object.keys(sub).filter(function (k) { return sub[k]; }).length === 0
          ? '<p class="hint">All off \u2014 rows will show names and badges only.</p>' : "") +
      "</div>" +

      /* --- reconnect behaviour --- */
      '<div class="card"><h3>Reconnect</h3>' +
        '<p class="note">Surfaces people you rated worth deepening who you have not logged in a while.</p>' +
        '<div class="chips">' +
          [["on", "Tab + reminder"], ["background", "Reminder only"], ["off", "Off"]].map(function (o) {
            return '<button class="chip' + (mode === o[0] ? " on" : "") + '" data-act="setrecon" data-val="' + o[0] + '">' + o[1] + "</button>";
          }).join("") +
        "</div>" +
        '<p class="hint">' +
          (mode === "on" ? "The Reach tab is visible and one reminder card appears when you open the app."
           : mode === "background" ? "The Reach tab is hidden. Tracking continues and you still get the reminder card on open."
           : "Fully off. No tab, no reminder. Field Notes behaves as a plain contact tracker.") +
        "</p>" +
      "</div>" +

      /* --- potential scale --- */
      '<div class="card"><h3>Potential scale</h3>' +
        '<p class="note">Five levels, strongest first. Only Some and above ever appear in Reconnect.</p>' +
        POTENTIAL.map(function (x) {
          return '<div class="scalerow">' + potMeter(x.key) +
            '<span class="scalekey">' + x.key + "</span>" +
            '<span class="scaleblurb">' + esc(x.blurb) + "</span></div>";
        }).join("") +
        (rated ? '<p class="hint">' + rated + ' contact' + (rated === 1 ? " is" : "s are") +
          ' still rated <strong>Some</strong> from the old four-level scale. Moderate now sits above it, ' +
          'so re-rate them as you come across them \u2014 nothing was changed automatically.</p>' : "") +
      "</div>" +

      /* --- cleanup, moved out of Add --- */
      '<div class="card"><h3>Clean up contacts</h3>' +
        '<p class="note">Bulk-remove people who are no longer part of your life. Opens on contacts with ' +
        'no school or company tag \u2014 usually the oldest ones.</p>' +
        '<div class="field"><button class="btn-ghost" data-act="clopen">Start cleaning up \u2192</button></div>' +
      "</div>" +

      /* --- backup, moved out of Add --- */
      '<div class="card"><h3>Trends</h3>' +
        '<p class="note">Three months of activity. Not a scoreboard.</p>' +
        '<div class="field"><button class="btn-ghost" data-act="opentrends">View trends</button></div>' +
      "</div>" +

      '<div class="card"><h3>Display</h3>' +
        '<p class="note">Symbol mode makes the app unreadable at a glance to anyone else.</p>' +
        '<div class="field"><label class="f">Navigation</label><div class="chips">' +
          [["text", "Text"], ["both", "Symbol + text"], ["symbol", "Symbol"]].map(function (o) {
            return '<button class="chip' + (setting("navMode", "text") === o[0] ? " on" : "") +
              '" data-act="navmode" data-val="' + o[0] + '">' + o[1] + "</button>";
          }).join("") +
        "</div></div>" +
        '<div class="field"><label class="f">Tiers</label><div class="chips">' +
          [["name", "Names"], ["symbol", "Symbols"], ["emoji", "Emoji"]].map(function (o) {
            return '<button class="chip' + (setting("tierMode", "name") === o[0] ? " on" : "") +
              '" data-act="tiermode" data-val="' + o[0] + '">' + o[1] + "</button>";
          }).join("") +
        "</div></div>" +
        '<div class="field"><label class="f">Subheadings</label><div class="chips">' +
          [["on", "Show"], ["off", "Hide"]].map(function (o) {
            return '<button class="chip' + (setting("showSub", "on") === o[0] ? " on" : "") +
              '" data-act="showsub" data-val="' + o[0] + '">' + o[1] + "</button>";
          }).join("") +
        "</div></div>" +
        '<p class="hint">' + SYMBOLS.tiering + " Tiering &nbsp; " + SYMBOLS.log + " Log &nbsp; " +
          SYMBOLS.past + " Past &nbsp; " + SYMBOLS.reconnect + " Reach &nbsp; " + SYMBOLS.add + " Add<br>" +
          TIER_SYMBOL.Close + " Close &nbsp; " + TIER_SYMBOL.Middle + " Middle &nbsp; " +
          TIER_SYMBOL.Acquaintance + " Acquaintance &nbsp; " + TIER_SYMBOL.Networking + " Networking</p>" +
      "</div>" +

      '<div class="card"><h3>Backup</h3>' +
        '<p class="note">Your ' + total + ' contacts live in this browser only. Export writes a CSV you can ' +
        'keep in cloud storage; importing it back restores everything.</p>' +
        '<div class="field"><button class="btn-ghost" data-act="export">Export everything as CSV</button></div>' +
        '<div class="field"><input type="file" id="fileIn" accept=".csv,.vcf"></div>' +
        '<p class="note" id="importStatus"></p>' +
        '<p class="hint' + (!st.lastExport || age > 30 ? " stale" : "") + '">' +
          (st.lastExport ? "Last export " + esc(st.lastExport) + " (" + age + " days ago)." : "You have never exported a backup.") +
        "</p>" +
      "</div>" +

      syncCardHTML() +

      '<div class="card"><h3>About</h3>' +
        '<p class="note">Field Notes v' + APP_VERSION + '</p>' +
        '<p class="hint">Contacts never leave this device unless you turn on sync, and sync uploads only ' +
        'ciphertext. Nothing is sent anywhere else.</p>' +
      "</div>";
  }

  /* Insights counts only what happened in-app: contacts you entered yourself
     and tier moves you made. Bulk imports are excluded so one CSV cannot make
     a month look like you met four hundred people. */
  function monthKey(iso) { return (iso || "").slice(0, 7); }

  function insightsFor(offset) {
    var d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - (offset || 0));
    var key = d.toISOString().slice(0, 7);

    var added = state.contacts.filter(function (c) { return monthKey(c.added) === key; });
    var moves = [];
    state.contacts.forEach(function (c) {
      (c.tierLog || []).forEach(function (m) {
        if (monthKey(m.date) === key) moves.push({ c: c, from: m.from, to: m.to });
      });
    });
    var logged = 0;
    state.contacts.forEach(function (c) {
      (c.interactions || []).forEach(function (dt) { if (monthKey(dt) === key) logged++; });
    });

    var rank = { Acquaintance: 0, Networking: 0, Middle: 1, Close: 2 };
    var deepened = moves.filter(function (m) { return rank[m.to] > rank[m.from]; });
    return {
      key: key,
      monthName: d.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
      monthShort: d.toLocaleDateString(undefined, { month: "short" }),
      added: added, moves: moves, deepened: deepened, logged: logged
    };
  }

  function viewInsights() {
    var now = insightsFor(0), prev = insightsFor(1), prev2 = insightsFor(2);

    function trend(label, a, b, c) {
      var dir = a === b ? "level" : a > b ? "up" : "down";
      return '<div class="trend"><div class="trendl">' + label + "</div>" +
        '<div class="trendrow"><span class="t2">' + prev2.monthShort + " " + c + "</span>" +
        '<span class="t2">' + prev.monthShort + " " + b + "</span>" +
        '<span class="t1 ' + dir + '">' + now.monthShort + " " + a + "</span></div></div>";
    }

    return '<button class="back" data-act="settings">Back to settings</button>' +
      '<div class="eyebrow">' + esc(now.monthName) + "</div><h2>Trends</h2>" +
      '<p class="sub">Three months of activity, for noticing patterns. These are not scores. ' +
      'Fewer new people can mean you went deeper with the ones you have, and none of this sees how any of it felt.</p>' +

      '<div class="trends">' +
        trend("New people entered", now.added.length, prev.added.length, prev2.added.length) +
        trend("Moved closer", now.deepened.length, prev.deepened.length, prev2.deepened.length) +
        trend("Conversations logged", now.logged, prev.logged, prev2.logged) +
      "</div>" +

      (now.deepened.length
        ? '<h3 class="logsec">Moved closer this month</h3><div class="loglist">' +
          now.deepened.map(function (m) {
            return '<div class="logrow"><span class="body" data-act="opencontact" data-id="' + m.c.id + '">' +
              '<span class="t">' + (esc(m.c.name) || "Unnamed") + "</span>" +
              '<span class="d">' + esc(m.from) + " \u2192 " + esc(m.to) + "</span></span></div>";
          }).join("") + "</div>"
        : "") +

      '<p class="hint" style="margin-top:18px">Counts people entered in the app and tier changes made here. ' +
      'Imported contacts are excluded.</p>';
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
      subLine("Tap anyone you no longer want. Nothing is deleted until you confirm.") +

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
    if (importPreview) return viewImportPreview();

    var pending = state.contacts.filter(function (c) { return c.pending; });
    if (queueIndex >= pending.length) queueIndex = Math.max(0, pending.length - 1);
    var cur = pending[queueIndex];

    return '<div class="eyebrow">Tonight\'s log</div><h2>Add</h2>' +
      subLine("Who did you meet? A name and a tier is enough. Potential and notes take five more seconds and are worth it while it is fresh.") +
      backupNagHTML() +
      '<div class="card"><h3>Just met someone</h3>' +
        '<input type="text" id="qName" placeholder="Name" autocomplete="off" enterkeyhint="done">' +
        '<div class="field"><label class="f">Tier</label><div class="chips" id="qTier">' +
          TIERS.map(function (t) { return '<button class="chip' + (qDraft.tier === t ? " on" : "") + '" data-t="' + t + '" data-act="qtier" data-val="' + t + '">' + t + "</button>"; }).join("") +
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
          '<div><label class="f">Where / what</label><input type="text" id="qNotes" placeholder="Where you met, what you talked about" autocomplete="off"></div>' +
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

      /* Cleanup, backup and sync now live in Settings so this tab stays about
         one thing: getting a person into the app. */
      '<div class="card"><h3>Bringing people in</h3>' +
        '<p class="note">Importing a CSV, backing up, cleaning out old contacts and device sync all moved ' +
        'to Settings — the gear icon at the top right.</p>' +
        '<div class="field"><button class="btn-ghost" data-act="opensettings">Open Settings →</button></div>' +
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
    if (tab === "reconnect" && !reconnectVisible()) tab = "tiering";
    document.getElementById("totalCount").textContent = state.contacts.length + " contacts";
    var pend = state.contacts.filter(function (c) { return c.pending; }).length;
    var pill = document.getElementById("pendingPill");
    pill.hidden = !pend;
    pill.textContent = pend;

    var coldN = state.contacts.filter(function (c) { var i = coldInfo(c); return i && i.cold && !c.pending; }).length;
    var cpill = document.getElementById("coldPill");
    if (cpill) { cpill.hidden = !coldN; cpill.textContent = coldN; }

    var TAB_TEXT = { tiering: "Tiering", log: "Log", reconnect: "Reach", add: "Add" };
    var tabs = document.querySelectorAll(".tab");
    for (var t = 0; t < tabs.length; t++) {
      var key = tabs[t].dataset.tab, pill = tabs[t].querySelector(".pill");
      tabs[t].firstChild && (tabs[t].textContent = "");
      tabs[t].insertAdjacentHTML("afterbegin", navLabel(key, TAB_TEXT[key] || key));
      if (pill) tabs[t].appendChild(pill);
    }
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].dataset.tab === tab;
      tabs[i].classList.toggle("on", on);
      tabs[i].setAttribute("aria-selected", on ? "true" : "false");
      if (tabs[i].dataset.tab === "reconnect") tabs[i].hidden = !reconnectVisible();
    }
    var gear = document.getElementById("settingsBtn");
    if (gear) gear.classList.toggle("on", tab === "settings");

    var boot = document.getElementById("bootMsg");
    if (boot && boot.parentNode) boot.parentNode.removeChild(boot);

    document.getElementById("view").innerHTML =
      tab === "tiering" ? viewTiering() :
      cleanup ? viewCleanup() :
      tab === "settings" ? viewSettings() :
      tab === "insights" ? viewInsights() :
      tab === "log" ? viewLog() :
      tab === "reconnect" ? viewReconnect() :
      viewAdd();

    var ts = document.getElementById("tierSearch");
    if (ts && tab === "tiering") {
      ts.addEventListener("input", function () { tierQuery = ts.value; renderListOnly(); });
    }
    var lg = document.getElementById("logSearch");
    if (lg && tab === "log") {
      lg.addEventListener("input", function () { logQuery = lg.value; renderListOnly(); });
    }
    var cl = document.getElementById("clSearch");
    if (cl && cleanup) {
      cl.addEventListener("input", function () { cleanup.q = cl.value; renderListOnly(); });
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
        '<span class="nudge-lbl">Worth reaching out to</span>' +
        '<strong>' + esc(c.name) + "</strong>" +
        '<span class="nudge-sub">' + c.tier + " · " + esc(potBlurb(c.potential)) + "</span>" +
      "</div>" +
      '<div class="nudge-acts">' +
        '<button class="tbtn primary" data-act="marktouch" data-id="' + c.id + '">Spoke recently</button>' +
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
    if (tabBtn) { tab = tabBtn.dataset.tab; openId = null; importPreview = null; cleanup = null; orderSnapshot = null; render(); return; }

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
      case "browseby": browseBy = val; groupFilter = ""; tierQuery = ""; searchAll = false; openId = null; orderSnapshot = null; render(); break;
      case "filter": tierFilter = val; tierQuery = ""; searchAll = false; openId = null; orderSnapshot = null; render(); break;
      case "filterclose": tab = "tiering"; browseBy = "tier"; tierFilter = "Close"; render(); break;
      case "group": groupFilter = groupFilter === val ? "" : val; tierQuery = ""; openId = null; orderSnapshot = null; render(); break;
      case "clearsearch": tierQuery = ""; searchAll = false; render(); break;
      case "logsub": logSub = val; calDay = ""; render(); break;
      case "calprev": calMonth.setMonth(calMonth.getMonth() - 1); calDay = ""; render(); break;
      case "calnext": calMonth.setMonth(calMonth.getMonth() + 1); calDay = ""; render(); break;
      case "calday": calDay = (calDay === val ? "" : val); render(); break;
      case "unlogday": {
        var uc = byId(id);
        if (uc) { unlogInteraction(uc, val); touch(uc); commit(); toast("Removed"); }
        break;
      }
      case "opentrends": tab = "insights"; render(); break;
      case "navmode": state.settings.navMode = val; commit(); break;
      case "tiermode": state.settings.tierMode = val; commit(); break;
      case "showsub": state.settings.showSub = val; commit(); break;
      case "resort": orderSnapshot = null; render(); toast("Re-sorted by potential"); break;
      case "toggleall": searchAll = !searchAll; orderSnapshot = null; render(); break;
      case "gotoadd": tab = "add"; render(); break;
      case "dismissonboard": state.settings.onboarded = true; commit(); break;

      case "settier":
        if (c.tier !== val) {
          c.tierSince = today();                     // new tier, fresh clock
          c.tierLog = (c.tierLog || []).concat({ date: today(), from: c.tier, to: val });
        }
        c.tier = val; c.pending = false; c.snoozedUntil = "";
        touch(c); commit();
        break;
      case "setpot": c.potential = c.potential === val ? "" : val; touch(c); commit(); break;
      case "notechip": {
        // Swap the trigger word for the chosen label, leaving plain searchable text.
        var k = el.dataset.k;
        var re = new RegExp("(^|[^a-z])" + k + "([^a-z]|$)", "i");
        var cur = c.notes || "";
        c.notes = re.test(cur)
          ? cur.replace(re, function (m, a, b) { return a + val + b; })
          : (cur ? cur.replace(/\s*$/, "") + " " + val : val);
        touch(c); commit();
        break;
      }
      case "confirmloc": c.locationConfirmed = today(); touch(c); commit(); toast("City confirmed"); break;
      case "marktouch": case "logtalk": {
        var first = (c.name || "").split(" ")[0];
        if (c.lastContact === today()) {          // tapped again, undo a misclick
          unlogInteraction(c);
          touch(c); commit();
          toast("Unmarked " + first);
          break;
        }
        logInteraction(c);
        c.snoozedUntil = "";
        touch(c);
        if (nudgeFor === c.id) nudgeFor = null;
        commit();
        toast("Marked " + first + " today");
        break;
      }
      case "logpast": {
        var pd = prompt("Date of that conversation (YYYY-MM-DD)", today());
        if (!pd) break;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(pd) || isNaN(new Date(pd).getTime())) {
          toast("Use the format 2026-08-14");
          break;
        }
        if (daysBetween(pd, today()) < 0) { toast("That date is in the future"); break; }
        logInteraction(c, pd);
        touch(c); commit();
        toast("Logged " + (c.name || "").split(" ")[0] + " on " + pd);
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

      case "opensettings": tab = "settings"; openId = null; importPreview = null; cleanup = null; render(); break;
      case "setsub":
        state.settings.subtitle[val] = !state.settings.subtitle[val];
        commit();
        break;
      case "setrecon":
        state.settings.reconnect = val;
        if (val !== "on" && tab === "reconnect") tab = "tiering";
        if (val === "off") nudgeFor = null;
        commit();
        break;
      case "clearlog": logQuery = ""; render(); break;
      case "clopen": cleanup = { filter: "untagged", marked: {}, q: "" }; tab = "settings"; render(); break;
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
      setphone: "phone", setemail: "email", setname: "name"
    };
    var field = map[el.dataset.act];
    if (!field) return;
    var wasTriggers = field === "notes" ? activeTriggers(c[field]).join(",") : null;
    c[field] = el.value;
    touch(c);
    commitQuiet();
    // Typing a trigger word has to reveal its chips, but only re-render when the
    // set actually changes, so ordinary typing never redraws under the cursor.
    if (field === "notes" && activeTriggers(el.value).join(",") !== wasTriggers) renderListOnly();
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
      name: name, tier: qDraft.tier, potential: qDraft.potential,
      company: val("qCo"), school: val("qSc"), location: loc,
      locationConfirmed: loc ? today() : "", notes: val("qNotes"), added: today()
    }));
    qDraft = { tier: "Middle", potential: "" };
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
        company: row.company || row.organization || "",
        school: row.school || "",
        location: row.location || row.city || "",
        notes: [row.notes || row.position || "", row.role || ""].filter(Boolean).join(" "),
        phone: row.phone || row["phone number"] || "",
        email: row["email address"] || row.email || "",
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
    var cols = ["name", "tier", "potential", "company", "school",
                "location", "locationConfirmed", "lastContact", "notes", "phone", "email"];
    var lines = [cols.join(",")];
    state.contacts.forEach(function (c) {
      lines.push(cols.map(function (k) {
        var v = c[k] == null ? "" : c[k];
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
