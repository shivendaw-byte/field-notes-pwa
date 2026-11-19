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

  /* How long before someone counts as going cold. Reminders (the card on open
     and the Reach count) are for Close and Middle only — see tracked(). The
     Acquaintance and Networking rows here only feed a folded "further out"
     list on the Reach tab, so the 800-odd people in those tiers never nag.

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
    reconnect: "\u22C8", add: "\u2295", insights: "\u0394",
    settings: "\u2699", cleanup: "\u2296"
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
  /* Symbol mode is for when you already know the app: the eyebrow and the
     spelled-out title are both noise at that point. */
  function pageHead(key, eyebrow, title) {
    if (setting("navMode", "text") === "symbol" && SYMBOLS[key]) {
      return '<h2 class="symhead" title="' + esc(title) + '">' + SYMBOLS[key] + "</h2>";
    }
    return '<div class="eyebrow">' + esc(eyebrow) + "</div><h2>" + navLabel(key, title) + "</h2>";
  }

  function tierLabel(t) {
    if (state && state.settings && state.settings.discreet) return TIER_SYMBOL[t] || t;
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

  var APP_VERSION = "9.12";
  /* Test mode exists only on a local dev server with ?fntest=1. It uses its
     own storage key so the test suite can never read or write real contacts. */
  var TEST = /[?&]fntest=1/.test(location.search) &&
             /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  var KEY = TEST ? "field-notes-TEST" : "field-notes-v4";   // v4 kept: migrates older saves in place
  var PREV_KEY = KEY + ".prev";   // one-step rollback copy, written before each update
  var VER_KEY = KEY + ".ver";     // last app version that ran on this device
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
  var qDraft = { tier: "Acquaintance", potential: "" };
  var qOpen = false;          // "More details" on the Add tab
  var qPenn = null;           // Penn toggle on the Add card; null = use the remembered default
  var qFamily = false;        // Family toggle on the Add card; resets after each save
  var lastMark = null;        // undo for Select -> + Penn / + Family
  var lastQueued = null;      // undo for "Sort one by one"
  var pennOnly = false;       // "Penn only" filter on the contact lists
  var lastAdded = null;       // id of the person just captured, for the follow-up card
  var dupeOk = "";            // name the user confirmed adding twice
  var LIST_STEP = 150;
  var listLimit = LIST_STEP;  // long lists draw this many rows until asked for more
  var deferredPrompt = null;
  var lastDeleted = null, undoTimer = null;
  var importPreview = null;
  var lastImport = null;              // { batch, ids } for the undo toast
  var selectMode = false, selected = {}, lastMove = null;
  var lastTagged = null, lastFollow = null, lastMerge = null;
  var syncBusy = false, syncMsg = "", syncTimer = null, syncBad = false;

  function uid() {
    return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  }
  function today() { return new Date().toISOString().slice(0, 10); }
  function nowISO() { return new Date().toISOString(); }
  function ago(iso) {
    var s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (isNaN(s)) return "";
    if (s < 90) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400 * 2) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " days ago";
  }
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
      notes: "", followUp: "", phone: "", email: "", pending: false, added: "",
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
    /* v9.10, once: Penn lives in School. Anyone whose company, email or name
       says Penn, or who was marked Penn, gets "Penn" in an empty School.
       A School that already names somewhere is never overwritten, and
       anyone marked "not Penn" is left alone. */
    if (!s.settings.pennInSchool) {
      s.contacts.forEach(function (c) {
        if (c.penn === false || String(c.school || "").trim()) return;
        if (c.penn === true || detectPenn(c)) {
          c.school = "Penn";
          delete c.penn;
          c.updatedAt = nowISO();
        }
      });
      s.settings.pennInSchool = true;
    }
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
  /* ---------- Penn ----------
     Worked out from the company or school already saved, so 900 imported
     contacts are labelled without anyone touching them. `c.penn` exists only
     when you overrode that: true = from Penn, false = not. Nothing is written
     for people the detection already gets right. */
  var PENN_RE = /(^|[^a-z])(u\.?\s?penn|penn|univ(\.|ersity)?\s+of\s+pennsylvania|wharton|perelman)([^a-z]|$)/i;
  var NOT_PENN_RE = new RegExp([
    "penn\\s*state", "pennsylvania state", "\\bpsu\\b", "indiana university of pennsylvania", "\\biup\\b",
    "penn\\s*mutual", "penn\\s*dot", "penn national", "penn hills", "penn manor", "penn foster", "penn highlands",
    "penn west", "penn college", "pennsylvania college of technology", "penn station", "penn entertainment",
    "west penn", "penn yan", "penn treaty", "penn charter", "penn wood", "penn view", "penn valley",
    "penn township", "penn'?s landing", "penn[- ]trafford", "penn cambria", "penn ridge", "pennridge",
    "penncrest", "penn tech", "wharton (county|junior|high|middle|elementary|isd|independent)",
    "wharton,? (tx|texas|nj|new jersey|oh|ohio)"
  ].join("|"), "i");
  function pennText(v) { return !!v && PENN_RE.test(v) && !NOT_PENN_RE.test(v); }
  /* Any upenn.edu address: sas., wharton., seas., engineering., nursing. ... */
  var PENN_MAIL_RE = /@([a-z0-9-]+\.)*upenn\.(edu|com)$/i;
  function pennMail(v) { return !!v && PENN_MAIL_RE.test(String(v).trim()); }
  /* Phone contacts often carry the place in the name: "Sam Lee Penn",
     "Sam Lee Wharton", "Sam Lee - Penn '28". A Penn word anywhere after the
     first word counts. A first word of "Penn" is a first name (Penn Badgley). */
  var PENN_NAME_RE = /(^|[^a-z])(u\.?\s?penn|penn|wharton)([^a-z]|$)/i;
  function pennName(n) {
    var rest = String(n || "").trim().replace(/^\S+\s*/, "");
    return !!rest && PENN_NAME_RE.test(rest) && !NOT_PENN_RE.test(rest);
  }
  function detectPenn(c) { return pennText(c.school) || pennText(c.company) || pennMail(c.email) || pennName(c.name); }
  function isPenn(c) { return c.penn === true || (c.penn !== false && detectPenn(c)); }
  function pennWhy(c) {
    if (c.penn === true) return "Marked by you.";
    if (c.penn === false) return "Marked not Penn by you.";
    if (pennText(c.school)) return "Saved in School as " + c.school + ".";
    if (pennText(c.company)) return "Worked out from the company: " + c.company + ".";
    if (pennMail(c.email)) return "Worked out from the Penn email address.";
    if (pennName(c.name)) return "Worked out from the name.";
    return "Nothing saved says Penn.";
  }
  /* Penn lives in the School field, the way the first 648 were saved. Turning
     it on writes "Penn" into an empty School; if School already names
     somewhere else, that is kept and the person is marked Penn on top.
     Turning it off clears a School of plain "Penn" and, if the name, company
     or email still says Penn, marks the person as not Penn. */
  var PLAIN_PENN_RE = /^\s*(u\.?\s?penn|penn|upenn|university of pennsylvania)\s*$/i;
  function setPenn(c, on) {
    if (on) {
      if (!String(c.school || "").trim()) c.school = "Penn";
      if (pennText(c.school)) delete c.penn; else c.penn = true;
    } else {
      if (PLAIN_PENN_RE.test(c.school || "")) c.school = "";
      if (detectPenn(c)) c.penn = false; else delete c.penn;
    }
    touch(c);
  }
  function togglePenn(c) { setPenn(c, !isPenn(c)); }

  /* Family is a mark you set yourself, never guessed: phone names like
     "Sam Lee Mom" usually mean a friend's mother. */
  function isFamily(c) { return c.family === true; }
  function setFamily(c, on) {
    if (on) c.family = true; else delete c.family;
    touch(c);
  }
  function capturePennDefault() {
    var d = state && state.settings ? state.settings.capturePenn : undefined;
    return d === undefined ? true : !!d;
  }
  function qPennOn() { return qPenn === null ? capturePennDefault() : qPenn; }
  /* "Save as Penn" in the sort queue: on unless you turned it off. */
  function sortPennOn() {
    var d = state && state.settings ? state.settings.sortPenn : undefined;
    return d === undefined ? true : !!d;
  }

  function haystack(c) {
    // Notes are searched whole, so chip text is found by ordinary search.
    return [c.name, c.company, c.school, c.location, c.potential, c.notes, c.tier, isPenn(c) ? "Penn" : "", isFamily(c) ? "Family" : ""]
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
      if (potLevel(c.potential) < MIN_POTENTIAL || !tracked(c)) return;
      var i = coldInfo(c);
      if (!i || !i.cold || i.snoozed) return;
      if (i.over > bestOver) { best = c; bestOver = i.over; }
    });
    return best;
  }

  /* Only the most recent interaction lives on the profile. The full history is
     in the Past calendar, so a contact never reads as a tally of what you owe. */
  function historyHTML(c) {
    var h = c.interactions || [];
    var last = h.length ? h[h.length - 1] : "";
    var ago = last ? daysSince(last) : null;
    var line = !last ? "Nothing logged yet."
      : ago === 0 ? "Last spoke today."
      : ago === 1 ? "Last spoke yesterday."
      : "Last spoke " + ago + " days ago, on " + last + ".";
    if (c.added) line += " Added " + c.added + ".";
    return '<div class="field"><label class="f">Last interaction</label>' +
      '<p class="hint" style="margin:0 0 8px">' + esc(line) + "</p>" +
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
            /* "University of Pennsylvania" in the company becomes one short
               Penn badge; the full text is still in the open row. */
            (isFamily(c) ? '<span class="tag fam">Family</span>' : "") +
            (isPenn(c) ? '<span class="tag pn">Penn</span>' : "") +
            (c.company && !(isPenn(c) && pennText(c.company)) ? '<span class="tag co">' + esc(c.company) + "</span>" : "") +
            (c.school && !(isPenn(c) && pennText(c.school)) ? '<span class="tag sc">' + esc(c.school) + "</span>" : "") +
            tagsOf(c).slice(0, 2).map(function (t) { return '<span class="tag tg">' + esc(t) + "</span>"; }).join("") +
            potMeter(c.potential) +
          "</span>" +
          (sub.length ? '<span class="row-sub">' + sub.join("") + "</span>" : "") +
        "</span>" +
        '<span class="caret" aria-hidden="true">▾</span>' +
      "</button>" +
      /* Only the open row carries its form. Drawing fifteen inputs for each of
         900 collapsed rows made every tap rebuild megabytes of HTML. */
      (openId !== c.id ? "" :
      '<div class="row-body">' +
        '<div class="field"><label class="f">Tier — tap to move</label><div class="chips">' +
          TIERS.map(function (t) {
            return '<button class="chip' + (c.tier === t ? " on" : "") + '" data-t="' + t + '" data-act="settier" data-id="' + c.id + '" data-val="' + t + '">' + t + "</button>";
          }).join("") +
        "</div></div>" +
        // Right under the tier, so tier + Penn are two taps at the top of the row.
        pennChipHTML(c) +
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
          '" placeholder="Where you met, what you talked about. A word with # groups people: #geoclub">' + esc(c.notes) + "</textarea>" +
          noteChipsHTML(c) + "</div>" +
        '<div class="field"><label class="f">Something I said I would do <span class="n">optional</span></label>' +
          '<input type="text" value="' + esc(c.followUp || "") + '" data-act="setfollow" data-id="' + c.id +
          '" placeholder="e.g. send her the article" autocomplete="off"></div>' +
        ((c.phone || c.email) ? '<div class="field" style="display:flex;gap:14px;flex-wrap:wrap">' +
          (c.phone ? '<a class="contactlink" href="tel:' + esc(digits(c.phone)) + '">Call</a>' : "") +
          (c.email ? '<a class="contactlink" href="mailto:' + esc(c.email) + '">Email</a>' : "") +
        "</div>" : "") +
        historyHTML(c) +
        '<div class="field"><button class="btn-danger" data-act="delete" data-id="' + c.id + '">Delete contact</button></div>' +
      "</div>") + "</div>";
  }

  /* The two marks, side by side, on every place a person can be edited:
     the open row, the card after adding, and the sort queue. */
  function pennChipHTML(c) {
    var on = isPenn(c), fam = isFamily(c);
    return '<div class="field"><label class="f">Marks</label><div class="chips">' +
      '<button class="chip pennchip' + (on ? " on" : "") + '" data-act="togglepenn" data-id="' + c.id + '">' +
        (on ? "\u2713 From Penn" : "From Penn") + "</button>" +
      '<button class="chip famchip' + (fam ? " on" : "") + '" data-act="togglefamily" data-id="' + c.id + '">' +
        (fam ? "\u2713 Family" : "Family") + "</button></div>" +
      '<p class="hint" style="margin:6px 0 0">' + (isPenn(c) || c.penn === false ? "Penn: " + esc(pennWhy(c)) : "Not marked Penn.") + "</p></div>";
  }

  /* ============================================================
     Views
     ============================================================ */
  /* #tags typed anywhere in notes group people without a new field:
     #geoclub, #hall, #classboard. Lower-cased so #Hall and #hall are one group. */
  function tagsOf(c) {
    var m = String(c.notes || "").match(/#[a-z0-9][a-z0-9_-]*/gi) || [], seen = {}, out = [];
    m.forEach(function (t) { t = t.toLowerCase(); if (!seen[t]) { seen[t] = 1; out.push(t); } });
    return out;
  }
  function tagValues() {
    var map = {};
    state.contacts.forEach(function (c) { tagsOf(c).forEach(function (t) { map[t] = (map[t] || 0) + 1; }); });
    return Object.keys(map).sort(function (a, b) { return map[b] - map[a] || a.localeCompare(b); })
      .map(function (k) { return { key: k, n: map[k] }; });
  }
  function cleanTag(raw) {
    var t = String(raw || "").trim().toLowerCase().replace(/^#+/, "").replace(/[^a-z0-9_-]+/g, "");
    return t ? "#" + t : "";
  }

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
             '<button class="btn-ghost sm" data-act="exportjson">Back up →</button>') +
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
      '</p><button class="btn-ghost" data-act="exportjson">Back up</button></div>';
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
        : tierFilter === "Imported"
          ? justImported()
          : tierFilter === "Family"
            ? state.contacts.filter(isFamily)
            : state.contacts.filter(function (c) { return c.tier === tierFilter && !c.pending; });
      heading = tierFilter === "Imported" ? "the last import" : tierFilter;
    } else if (browseBy === "tag") {
      base = groupFilter
        ? state.contacts.filter(function (c) { return tagsOf(c).indexOf(groupFilter) !== -1; })
        : [];
      heading = groupFilter || "";
    } else {
      var field = browseBy === "school" ? "school"
        : browseBy === "city" ? "location" : "company";
      base = groupFilter
        ? state.contacts.filter(function (c) { return (c[field] || "") === groupFilter; })
        : [];
      heading = groupFilter || "";
    }

    var baseAll = base;
    if (pennOnly) base = base.filter(isPenn);
    var pennHere = pennOnly ? base.length : baseAll.filter(isPenn).length;

    /* Rank the whole tier first, then filter by search, so searching never
       reshuffles anyone. The ranking is frozen while you work (see rankList). */
    var list = searchContacts(rankList(base), tierQuery);

    // Never hide matches silently: if this tier has none but others do, say so.
    var elsewhere = 0;
    if (tierQuery && !list.length && !searchAll) {
      elsewhere = searchContacts(state.contacts, tierQuery).length;
    }

    var stale = orderIsStale(base);

    // Draw the first screens' worth; the open row always stays visible.
    var total = list.length, capped = false;
    if (!selectMode && total > listLimit) {
      var openAt = -1;
      for (var oi = 0; oi < total; oi++) if (list[oi].id === openId) { openAt = oi; break; }
      if (openAt < listLimit) { capped = true; }
    }
    var drawn = capped ? list.slice(0, listLimit) : list;

    var filtersHTML;
    if (browseBy === "tier") {
      filtersHTML = TIERS.map(function (t) {
        var n = state.contacts.filter(function (c) { return c.tier === t && !c.pending; }).length;
        return '<button class="filter' + (tierFilter === t ? " on" : "") + '" data-act="filter" data-val="' + t + '" title="' + t + '">' + tierLabel(t) + '<span class="n">' + n + "</span></button>";
      }).join("") + (pending.length
        ? '<button class="filter' + (tierFilter === "Unsorted" ? " on" : "") + '" data-act="filter" data-val="Unsorted">Unsorted<span class="n">' + pending.length + "</span></button>"
        : "") +
        /* Family is its own list, across every tier. Always shown, so there is
           somewhere obvious to look even before anyone is marked. */
        '<button class="filter famfilter' + (tierFilter === "Family" ? " on" : "") + '" data-act="filter" data-val="Family">Family<span class="n">' +
          state.contacts.filter(isFamily).length + "</span></button>" +
        (justImported().length
        ? '<button class="filter' + (tierFilter === "Imported" ? " on" : "") + '" data-act="filter" data-val="Imported">Just imported<span class="n">' + justImported().length + "</span></button>"
        : "");
    } else {
      var vals = browseBy === "tag" ? tagValues() : groupValues(browseBy === "school" ? "school"
        : browseBy === "city" ? "location" : "company");
      filtersHTML = vals.length
        ? vals.map(function (v) {
            return '<button class="filter' + (groupFilter === v.key ? " on" : "") + '" data-act="group" data-val="' + esc(v.key) + '">' + esc(v.key) + '<span class="n">' + v.n + "</span></button>";
          }).join("")
        : browseBy === "tag"
          ? '<span class="note">No tags yet. Type a word with # in anyone\'s notes, like #geoclub or #hall, ' +
            'or use Select → Tag to tag several people at once.</span>'
          : '<span class="note">No ' + browseBy + ' set on anyone yet — add it on any contact.</span>';
    }

    if (!state.contacts.length) {
      return pageHead("tiering", "Welcome", "Field Notes") +
        '<div class="card start"><h3>Start with one person</h3>' +
        '<p class="note">Type a name on the Add tab and press Enter. That is all an entry needs. ' +
        'Tiers, ratings and notes are there when you want them and never required.</p>' +
        '<div class="field"><button class="btn" data-act="gotoadd">Add someone</button></div>' +
        '<div class="field"><button class="btn-ghost" data-act="opensettings">Bring in a contacts file or a backup</button></div>' +
        '<p class="hint">Everything stays on this device. Nothing is uploaded unless you turn on sync, and then only in encrypted form.</p>' +
        "</div>";
    }

    return pageHead("tiering", "Everyone, sorted", "Tiering") +
      subLine("Search covers names, notes and tags.") +
      onboardingHTML() +
      (pending.length ? '<div class="card warn rowsplit"><p class="note" style="margin:0">' + pending.length + ' imported contacts are waiting to be sorted.</p><button class="btn-ghost" data-act="gotoadd">Sort them →</button></div>' : "") +
      '<div class="seg" role="group" aria-label="Browse by">' +
        ["tier", "school", "company", "city", "tag"].map(function (b) {
          return '<button class="' + (browseBy === b ? "on" : "") + '" data-act="browseby" data-val="' + b + '">' +
            b.charAt(0).toUpperCase() + b.slice(1) + "</button>";
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
      (baseAll.length
        ? '<div class="rowsplit selbar-top"><p class="hint" style="margin:0">' +
            (selectMode ? Object.keys(selected).length + " selected" : list.length + (pennOnly ? " from Penn" : " here")) + "</p>" +
            '<span style="display:flex;gap:8px">' +
              '<button class="btn-ghost sm pennf' + (pennOnly ? " on" : "") + '" data-act="pennonly">' +
                (pennOnly ? "\u2713 Penn only" : "Penn only") + ' <span class="n">' + pennHere + "</span></button>" +
              (selectMode ? '<button class="btn-ghost sm" data-act="selall" data-ids="' + list.map(function (c) { return c.id; }).join(",") + '">All / none</button>' : "") +
              '<button class="btn-ghost sm" data-act="selmode">' + (selectMode ? "Cancel" : "Select") + "</button>" +
            "</span></div>"
        : "") +
      '<div class="' + (selectMode ? "loglist" : "rowlist") + '">' +
        (list.length ? drawn.map(selectMode ? selRowHTML : rowHTML).join("") +
            (capped ? '<button class="btn-ghost showmore" data-act="showmore">Show ' + Math.min(LIST_STEP, total - listLimit) +
              " more (" + (total - listLimit) + " not shown)</button>" : "")
          : '<div class="empty">' +
              (elsewhere
                ? "Nothing in " + esc(heading) + " matches “" + esc(tierQuery) + "”.<br>" +
                  '<button class="btn-ghost" style="margin-top:10px" data-act="toggleall">' + elsewhere + " match" + (elsewhere === 1 ? "" : "es") + " elsewhere — search everyone</button>"
                : browseBy !== "tier" && !groupFilter
                  ? "Pick a " + browseBy + " above to see who's there."
                  : (tierQuery ? "Nothing here matches “" + esc(tierQuery) + "”." : "No one in " + esc(heading) + " yet.")) +
            "</div>") +
      "</div>" +
      (tierFilter === "Imported" && browseBy === "tier" && !selectMode && justImported().length
        ? '<div class="field"><button class="btn" data-act="sortimported">Sort these ' + justImported().length +
          " one by one</button></div>" : "") +
      (pennOnly && !list.length && !tierQuery && baseAll.length
        ? '<p class="hint" style="text-align:center">Nobody in ' + esc(heading) + ' is marked as Penn. ' +
          'Tap Penn only to see everyone.</p>' : "") +
      (selectMode && Object.keys(selected).length
        ? '<div class="cleanbar movebar"><span class="hint" style="margin:0">Move ' + Object.keys(selected).length + " to</span>" +
            '<div class="chips">' + TIERS.map(function (t) {
              return '<button class="chip" data-t="' + t + '" data-act="selmove" data-val="' + t + '">' + tierLabel(t) + "</button>";
            }).join("") + '<button class="chip" data-act="seltag">+ Tag</button>' +
              '<button class="chip pennchip" data-act="selmark" data-val="penn">+ Penn</button>' +
              '<button class="chip famchip" data-act="selmark" data-val="family">+ Family</button>' +
              '<button class="chip" data-act="selsort">Sort one by one</button>' + "</div></div>"
        : "");
  }

  /* Contacts from the most recent import that are still sitting in
     Acquaintance — i.e. the ones you have not promoted yet. */
  function justImported() {
    var b = state.settings.lastImport;
    if (!b) return [];
    return state.contacts.filter(function (c) {
      return c.importBatchId === b && c.tier === "Acquaintance" && !c.pending;
    });
  }

  function selRowHTML(c) {
    var on = !!selected[c.id];
    var meta = [c.tier], pn = isPenn(c);
    if (pn) meta.push("Penn");
    if (c.school && !(pn && pennText(c.school))) meta.push(c.school);
    if (c.company && !(pn && pennText(c.company))) meta.push(c.company);
    return '<div class="logrow clean pick' + (on ? " marked" : "") + '" data-act="selpick" data-id="' + c.id + '">' +
      '<span class="clbox">' + (on ? "✓" : "") + "</span>" +
      '<span class="body"><span class="t">' + (esc(c.name) || "Unnamed") + "</span>" +
      '<span class="d">' + esc(meta.join(" · ")) + "</span></span>" +
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

    return pageHead("past", "Past", "Past logs") +
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
    var quick = logQuery.trim() ? [] : quickLogList(active, t);

    return pageHead("log", "Today", "Daily log") +
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

      (quick.length
        ? '<h3 class="logsec">People you talk to most</h3>' +
          '<div class="loglist">' + quick.map(function (c) { return logRowHTML(c, "log"); }).join("") + "</div>"
        : "") +

      (loggedToday.length
        ? '<h3 class="logsec">Logged today <span class="n">' + loggedToday.length + "</span></h3>" +
          '<div class="loglist">' + loggedToday.map(function (c) { return logRowHTML(c, "undo"); }).join("") + "</div>"
        : (logQuery.trim() ? "" :
            '<div class="card"><h3>Nothing logged yet today</h3>' +
            '<p class="note">Search a name above and tap Log. Skipping days costs you nothing \u2014 ' +
            'an empty day just means nothing worth recording happened.</p></div>'));
  }

  /* The handful of people most likely to be logged, so the common case needs
     no typing: recent conversations count most, then Close, then Middle.
     People already logged today drop out. */
  function quickLogList(active, t) {
    var cut = addDays(t, -90);
    return active.map(function (c) {
      var recent = (c.interactions || []).filter(function (d) { return d >= cut; }).length;
      var score = recent * 2 + (c.tier === "Close" ? 3 : c.tier === "Middle" ? 1 : 0);
      return { c: c, score: score };
    }).filter(function (x) { return x.score > 0 && x.c.lastContact !== t; })
      .sort(function (a, b) { return b.score - a.score || (a.c.name || "").localeCompare(b.c.name || ""); })
      .slice(0, 8).map(function (x) { return x.c; });
  }

  /* Reconnect is framed as opportunity, not debt: it only ever lists people you
     yourself rated as worth deepening, ordered by that rating. */
  function tracked(c) { return c.tier === "Close" || c.tier === "Middle"; }

  /* Overdue and rated worth deepening. `trackedOnly` true gives Close and
     Middle (the people reminders are about); false gives everyone else. */
  function worthReaching(trackedOnly) {
    return state.contacts.filter(function (c) {
      if (potLevel(c.potential) < MIN_POTENTIAL) return false;
      if (tracked(c) !== !!trackedOnly) return false;
      var i = coldInfo(c);
      return i && i.cold;
    }).sort(function (a, b) {
      var pa = potLevel(a.potential), pb = potLevel(b.potential);
      if (pa !== pb) return pb - pa;
      return coldInfo(b).over - coldInfo(a).over;
    });
  }

  function fmtDay(iso) {
    var d = new Date(String(iso).slice(0, 10) + "T12:00:00");
    return isNaN(d.getTime()) ? String(iso || "") : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  /* Median days between logged conversations; 0 until there are three. */
  function usualGap(c) {
    var h = c.interactions || [];
    if (h.length < 3) return 0;
    var gaps = [];
    for (var i = 1; i < h.length; i++) gaps.push(daysBetween(h[i - 1], h[i]));
    gaps.sort(function (x, y) { return x - y; });
    return gaps[Math.floor(gaps.length / 2)];
  }
  /* One plain sentence on why this person is showing up today. Facts only. */
  function whyNow(c) {
    var parts = [];
    if (c.lastContact) {
      var d = daysSince(c.lastContact);
      parts.push("Last talked " + (d <= 0 ? "today" : d === 1 ? "yesterday" : d + " days ago"));
      var g = usualGap(c);
      if (g > 1 && d > g * 1.5) parts.push("you usually talk every " + g + " days");
    } else if (c.tierSince) {
      parts.push("In " + tierLabel(c.tier) + " since " + fmtDay(c.tierSince) + ", nothing logged yet");
    }
    return parts.join(" · ");
  }
  function snippet(text, n) {
    var t = String(text || "").replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  }

  function reachRowHTML(c) {
    var why = whyNow(c);
    return '<div class="logrow reach">' +
      '<span class="body" data-act="opencontact" data-id="' + c.id + '">' +
        '<span class="t">' + (esc(c.name) || "Unnamed") + "</span>" +
        '<span class="d">' + tierBadge(c.tier) + potMeter(c.potential) + "</span>" +
        (why ? '<span class="reach-why"><span>' + esc(why) + "</span></span>" : "") +
        (c.notes ? '<span class="reach-ctx">' + esc(snippet(c.notes, 70)) + "</span>" : "") +
      "</span>" +
      '<button class="logbtn" data-act="marktouch" data-id="' + c.id + '">Log</button>' +
    "</div>";
  }

  /* ---------- promises: "I said I would..." ---------- */
  function promises() {
    return state.contacts.filter(function (c) { return (c.followUp || "").trim(); })
      .sort(function (a, b) { return (a.name || "").localeCompare(b.name || ""); });
  }
  function promiseRowHTML(c) {
    return '<div class="logrow reach">' +
      '<span class="body" data-act="opencontact" data-id="' + c.id + '">' +
        '<span class="t">' + (esc(c.name) || "Unnamed") + "</span>" +
        '<span class="reach-why"><span>' + esc(snippet(c.followUp, 90)) + "</span></span>" +
      "</span>" +
      '<button class="logbtn" data-act="followdone" data-id="' + c.id + '">Done</button>' +
    "</div>";
  }

  /* ---------- the Penn calendar ----------
     Breaks are when people outside Philadelphia are reachable, and a new term
     is when last term's new faces fade. Known dates for 2026-27 come from the
     University calendar; other years use the usual pattern. Nothing here needs
     setting up, and a prompt only appears if it has someone to show. */
  function nthWeekday(year, month, weekday, n) {
    var d = new Date(year, month, 1, 12);
    var shift = (weekday - d.getDay() + 7) % 7;
    d.setDate(1 + shift + (n - 1) * 7);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function seasonWindows(y) {
    var tg = nthWeekday(y, 10, 4, 4);                 // fourth Thursday of November
    var sb = nthWeekday(y, 2, 6, 1);                  // first Saturday of March
    var w = [
      { key: "term-spring", kind: "term", label: "New semester", start: y + "-01-14", end: y + "-01-28" },
      { key: "spring", kind: "break", label: "Spring break", start: sb, end: addDays(sb, 8) },
      { key: "summer", kind: "break", label: "Summer", start: y + "-05-18", end: y + "-08-23" },
      { key: "term-fall", kind: "term", label: "New semester", start: y + "-08-25", end: y + "-09-08" },
      { key: "thanksgiving", kind: "break", label: "Thanksgiving break", start: addDays(tg, -1), end: addDays(tg, 3) },
      { key: "winter", kind: "break", label: "Winter break", start: y + "-12-23", end: (y + 1) + "-01-13" },
      { key: "winter", kind: "break", label: "Winter break", start: (y - 1) + "-12-23", end: y + "-01-13" }
    ];
    // 2026-27 as published: spring classes start Jan 20, 2027.
    if (y === 2026) w[5].end = "2027-01-19";
    if (y === 2027) { w[6].end = "2027-01-19"; w[0].start = "2027-01-20"; w[0].end = "2027-02-03"; }
    return w;
  }
  /* The window we are in, or one starting within 5 days. */
  function seasonNow(t) {
    t = t || today();
    var w = seasonWindows(Number(t.slice(0, 4))), soon = null;
    for (var i = 0; i < w.length; i++) {
      if (t >= w[i].start && t <= w[i].end) return { key: w[i].key, kind: w[i].kind, label: w[i].label, start: w[i].start, end: w[i].end, startsIn: 0 };
      var lead = daysBetween(t, w[i].start);
      if (w[i].kind === "break" && lead > 0 && lead <= 5 && (!soon || lead < soon.startsIn)) {
        soon = { key: w[i].key, kind: w[i].kind, label: w[i].label, start: w[i].start, end: w[i].end, startsIn: lead };
      }
    }
    return soon;
  }
  var CAMPUS_RE = /philadelphia|philly|\bpenn\b|upenn|university city/i;
  function seasonPeople(season, t) {
    t = t || today();
    var list;
    if (season.kind === "break") {
      var recent = addDays(t, -14);
      list = state.contacts.filter(function (c) {
        return tracked(c) && !c.pending && potLevel(c.potential) >= MIN_POTENTIAL &&
          (c.location || "").trim() && !CAMPUS_RE.test(c.location) &&
          !(c.lastContact && c.lastContact >= recent);
      });
    } else {
      var since = addDays(t, -150);
      list = state.contacts.filter(function (c) {
        return !c.pending && potLevel(c.potential) >= MIN_POTENTIAL &&
          c.added && c.added >= since && !c.lastContact;
      });
    }
    return list.sort(byPotential).slice(0, 5);
  }
  function seasonHTML() {
    var s = seasonNow();
    if (!s) return "";
    var people = seasonPeople(s);
    if (!people.length) return "";
    var head = s.label + (s.startsIn ? " starts in " + s.startsIn + " day" + (s.startsIn === 1 ? "" : "s")
                                     : s.kind === "break" ? ", until " + fmtDay(s.end) : "");
    var line = s.kind === "break"
      ? "People you rated who are not in Philadelphia. A break is the easy time to see or message them."
      : "People you added last term and rated, with nothing logged since.";
    return '<div class="card season"><h3>' + esc(head) + "</h3>" +
      '<p class="note">' + line + "</p>" +
      '<div class="loglist">' + people.map(reachRowHTML).join("") + "</div></div>";
  }

  function viewReconnect() {
    var list = worthReaching(true), further = worthReaching(false), owed = promises();
    var rated = state.contacts.filter(function (c) {
      return potLevel(c.potential) >= MIN_POTENTIAL && !c.pending;
    }).length;
    var season = seasonHTML();

    return pageHead("reconnect", "Opportunities", "Worth reaching out to") +
      subLine("People you rated worth deepening, with a reason for each.") +

      (owed.length
        ? '<h3 class="logsec">You said you would <span class="n">' + owed.length + "</span></h3>" +
          '<div class="loglist">' + owed.map(promiseRowHTML).join("") + "</div>"
        : "") +

      season +

      (!rated
        ? (owed.length || season ? "" :
          '<div class="card"><h3>Nothing rated yet</h3><p class="note">Open anyone and set ' +
          '<strong>Potential to deepen</strong>. Only Some, Moderate, Strong and Rare ever appear here — ' +
          'that rating is what makes this more than a contact list.</p></div>')
        : list.length
          ? '<h3 class="logsec">Close and Middle <span class="n">' + list.length + "</span></h3>" +
            '<div class="loglist">' + list.map(reachRowHTML).join("") + "</div>"
          : '<div class="card ok-card"><h3>All current</h3><p class="note">Everyone in Close and Middle that you ' +
            "rated worth deepening was logged recently.</p></div>") +

      (further.length
        ? '<details class="more"><summary>Rated, but further out (' + further.length + ")</summary>" +
          '<p class="hint">Acquaintance and Networking. Listed here only; they never trigger a reminder.</p>' +
          '<div class="loglist">' + further.map(reachRowHTML).join("") + "</div></details>"
        : "") +

      (rated ? '<p class="hint" style="margin-top:14px">Logging someone clears them from here.</p>' : "");
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

    return pageHead("settings", "Everything, in one place", "Settings") +
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
        (function () {
          var nd = dupeGroups().length;
          return nd ? '<div class="field"><button class="btn-ghost" data-act="opendupes">Review ' + nd + " possible duplicate" + (nd === 1 ? "" : "s") + " \u2192</button></div>" : "";
        })() +
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
        '<div class="field"><label class="f">Discreet</label><div class="chips">' +
          [["off", "Off"], ["on", "On"]].map(function (o) {
            return '<button class="chip' + ((st.discreet ? "on" : "off") === o[0] ? " on" : "") +
              '" data-act="discreet" data-val="' + o[0] + '">' + o[1] + "</button>";
          }).join("") +
        "</div><p class=\"hint\">Hides tier names and potential ratings everywhere. Tapping the Field Notes title switches it too.</p></div>" +
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
        'keep in cloud storage.</p>' +
        '<div class="field"><button class="btn-ghost" data-act="exportjson">Save a full backup</button></div>' +
        '<p class="hint">A full backup restores everything exactly: tiers, ratings, history and reconnect clocks.</p>' +
        '<div class="field"><button class="btn-ghost" data-act="export">Export as CSV (for spreadsheets)</button></div>' +
        '<div class="field"><label class="f">Import contacts or restore a backup</label>' +
          '<input type="file" id="fileIn" accept=".csv,.vcf,.json"></div>' +
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
        (rollbackInfo()
          ? '<p class="hint">A copy of your data from before the last update (' + esc(rollbackInfo()) + ') is kept on this device.</p>' +
            '<div class="field"><button class="btn-ghost sm" data-act="rollback">Go back to that copy</button></div>'
          : "") +
      "</div>";
  }

  function normName(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

  /* ---------- who is the same person ----------
     One rule for imports, for duplicate cards inside a file, and for the
     Duplicates screen. Same person when any of these hold:
       - the same full name, ignoring case, spaces and punctuation
       - an email address in common
       - the same first and last word of the name ("Sam J. Lee" = "Sam Lee")
       - a phone number in common AND the same first name, or one first name
         is the start of the other ("Sam" / "Sammy"), or one has no name.
         A shared number alone is not enough, and neither is a shared last
         name: siblings and parents share both. */
  function nameWords(s) {
    var t = String(s || "");
    try { t = t.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); } catch (e) {}
    return t.toLowerCase().split(/[^a-z0-9']+/).map(function (w) { return w.replace(/'/g, ""); })
      .filter(function (w) { return w.length > 0; });
  }
  function phonesOf(c) {
    return (c._phones || [c.phone]).map(function (p) { return digits(p).replace(/\D/g, "").slice(-10); })
      .filter(function (p) { return p.length >= 7; });
  }
  function emailsOf(c) {
    return (c._emails || [c.email]).map(function (e) { return String(e || "").toLowerCase().trim(); })
      .filter(function (e) { return e.indexOf("@") > 0; });
  }
  function personKeys(c) {
    var keys = [], n = normName(c.name), w = nameWords(c.name);
    if (n) keys.push("n:" + n);
    if (w.length >= 2) keys.push("fl:" + w[0] + "|" + w[w.length - 1]);
    emailsOf(c).forEach(function (e) { keys.push("e:" + e); });
    phonesOf(c).forEach(function (p) { keys.push("p:" + p); });
    return keys;
  }
  function overlap(a, b) { for (var i = 0; i < a.length; i++) if (b.indexOf(a[i]) !== -1) return true; return false; }
  function samePerson(a, b) {
    var na = normName(a.name), nb = normName(b.name);
    if (na && na === nb) return true;
    if (overlap(emailsOf(a), emailsOf(b))) return true;
    var wa = nameWords(a.name), wb = nameWords(b.name);
    if (wa.length >= 2 && wb.length >= 2 && wa[0] === wb[0] && wa[wa.length - 1] === wb[wb.length - 1]) {
      // "Sam J Lee" = "Sam Lee", but "Sam J Lee" is not "Sam K Lee", and
      // numbered entries ("Lab 1 Room", "Lab 2 Room") stay separate.
      var ma = wa.slice(1, -1).join(" "), mb = wb.slice(1, -1).join(" ");
      if (!ma || !mb || ma === mb || ma.indexOf(mb) === 0 || mb.indexOf(ma) === 0) return true;
    }
    if (overlap(phonesOf(a), phonesOf(b))) {
      if (!wa.length || !wb.length) return true;
      var fa = wa[0], fb = wb[0];
      if (fa === fb) return true;
      var shorter = fa.length < fb.length ? fa : fb, longer = shorter === fa ? fb : fa;
      return shorter.length >= 3 && longer.indexOf(shorter) === 0;
    }
    return false;
  }
  function personIndex(list) {
    var idx = {};
    list.forEach(function (c) {
      personKeys(c).forEach(function (k) { (idx[k] = idx[k] || []).push(c); });
    });
    return idx;
  }
  function findSame(c, idx, skip) {
    var keys = personKeys(c);
    for (var i = 0; i < keys.length; i++) {
      var cands = idx[keys[i]] || [];
      for (var j = 0; j < cands.length; j++) {
        if (cands[j] !== c && cands[j] !== skip && samePerson(c, cands[j])) return cands[j];
      }
    }
    return null;
  }

  /* Fold `from` into `into` without losing anything: blanks are filled,
     different notes are kept side by side, histories are unioned, the higher
     potential wins. Tier, clock and snooze stay with `into`. Returns the
     fields that changed, with their old values, so it can be undone. */
  var FILL_FIELDS = ["company", "school", "location", "locationConfirmed", "phone", "email"];
  function absorb(into, from) {
    var prev = {};
    function set(k, v) { if (!(k in prev)) prev[k] = into[k]; into[k] = v; }
    FILL_FIELDS.forEach(function (k) {
      if (!String(into[k] || "").trim() && String(from[k] || "").trim()) set(k, from[k]);
    });
    // A Penn address is worth more than whatever email was there, but only
    // when the existing one is not already a Penn address.
    if (pennMail(from.email) && !pennMail(into.email) && into.email && into.email !== from.email) {
      var extra = "Penn email: " + from.email;
      if ((into.notes || "").indexOf(from.email) === -1) set("notes", (into.notes ? into.notes.replace(/\s*$/, "") + " \u00b7 " : "") + extra);
    }
    // Compared as whole pieces, so "copy 1" is not mistaken for part of "copy 10".
    function has(text, piece, sep) {
      text = String(text || "").trim();
      return text === piece || text.split(sep).map(function (x) { return x.trim(); }).indexOf(piece) !== -1;
    }
    var fn = String(from.notes || "").trim(), inn = String(into.notes || "");
    if (fn && !has(inn, fn, " \u00b7 ")) set("notes", inn.trim() ? inn.replace(/\s*$/, "") + " \u00b7 " + fn : fn);
    var ff = String(from.followUp || "").trim(), inf = String(into.followUp || "").trim();
    if (ff && !inf) set("followUp", ff);
    else if (ff && !has(inf, ff, " / ")) set("followUp", inf + " / " + ff);
    if (potLevel(from.potential) > potLevel(into.potential)) set("potential", from.potential);
    if (into.penn === undefined && from.penn !== undefined) set("penn", from.penn);
    // Any sign of Penn on the incoming copy lands in an empty School.
    if (into.penn !== false && !String(into.school || "").trim() &&
        (from.penn === true || pennText(from.school) || pennText(from.company) || pennMail(from.email) || pennName(from.name))) {
      set("school", "Penn");
      if (into.penn === true) set("penn", undefined);
    }
    if (from.family === true && into.family !== true) set("family", true);
    var hist = dedupeDates((into.interactions || []).concat(from.interactions || []));
    if (hist.length !== (into.interactions || []).length) {
      set("interactions", hist);
      set("lastContact", hist.length ? hist[hist.length - 1] : "");
    }
    var seen = {}, log = [];
    (into.tierLog || []).concat(from.tierLog || []).forEach(function (m) {
      if (!m || !m.date) return;
      var k = m.date + "|" + m.from + "|" + m.to;
      if (!seen[k]) { seen[k] = 1; log.push(m); }
    });
    if (log.length !== (into.tierLog || []).length) set("tierLog", log.sort(function (x, y) { return x.date < y.date ? -1 : 1; }));
    if (from.added && (!into.added || from.added < into.added)) set("added", from.added);
    if (into.pending && !from.pending) set("pending", false);
    return prev;
  }

  /* ---------- duplicates already in the app ---------- */
  var TIER_RANK = { Close: 4, Middle: 3, Acquaintance: 2, Networking: 1 };
  function keeperOf(group) {
    function filled(c) { return ["company", "school", "location", "phone", "email", "notes"].filter(function (k) { return (c[k] || "").trim(); }).length; }
    return group.slice().sort(function (a, b) {
      return (TIER_RANK[b.tier] || 0) - (TIER_RANK[a.tier] || 0) ||
        potLevel(b.potential) - potLevel(a.potential) ||
        interactionCount(b) - interactionCount(a) ||
        filled(b) - filled(a) ||
        String(a.added || "9999").localeCompare(String(b.added || "9999"));
    })[0];
  }
  function dupeGroups() {
    var list = state.contacts, idx = personIndex(list), parent = {};
    function find(id) { while (parent[id] && parent[id] !== id) id = parent[id] = parent[parent[id]] || parent[id]; return id; }
    list.forEach(function (c) { parent[c.id] = c.id; });
    list.forEach(function (c) {
      personKeys(c).forEach(function (k) {
        (idx[k] || []).forEach(function (o) {
          if (o !== c && find(o.id) !== find(c.id) && samePerson(c, o)) parent[find(o.id)] = find(c.id);
        });
      });
    });
    var groups = {};
    list.forEach(function (c) { var r = find(c.id); (groups[r] = groups[r] || []).push(c); });
    return Object.keys(groups).map(function (k) { return groups[k]; })
      .filter(function (g) { return g.length > 1; })
      .sort(function (a, b) { return (keeperOf(a).name || "").localeCompare(keeperOf(b).name || ""); });
  }
  function mergeGroups(groups) {
    var snapshot = { contacts: JSON.stringify(state.contacts), deleted: JSON.stringify(state.deleted) };
    var gone = {}, n = 0;
    groups.forEach(function (g) {
      var keep = keeperOf(g);
      g.forEach(function (c) {
        if (c === keep) return;
        absorb(keep, c);
        gone[c.id] = true;
        state.deleted.push({ id: c.id, at: nowISO() });
        n++;
      });
      touch(keep);
    });
    state.contacts = state.contacts.filter(function (c) { return !gone[c.id]; });
    lastMerge = n ? snapshot : null;
    orderSnapshot = null;
    commit();
    return n;
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

    var keepN = P.respectFile ? preTiered : 0;
    var pennNew = newRows.filter(function (r) { return r.penn; }).length;
    var fills = P.rows.filter(function (r) { return r.dupe && r.fills; }).length;
    var splitPenn = pennNew > 0 && pennNew < newRows.length;
    return '<div class="eyebrow">Review before importing</div><h2>' + P.rows.length + " " + (P.rows.length === 1 ? "person" : "people") + " in this file</h2>" +
      '<p class="sub">Nothing has been saved yet.' +
        (P.fileMerged ? " " + P.fileMerged + " repeated card" + (P.fileMerged === 1 ? " was" : "s were") + " combined with the first copy." : "") + "</p>" +

      '<div class="card"><h3>' + newRows.length + " new " + (newRows.length === 1 ? "person" : "people") +
        (pennNew ? ' <span class="tag pn">' + pennNew + " from Penn</span>" : "") + "</h3>" +
        '<p class="note">' +
          (pennNew ? "The " + pennNew + " from Penn (by email, name or company) get School: Penn. " : "") +
          (newRows.length ? (newRows.length - keepN) + " go to Acquaintance" + (keepN ? " \u00b7 " + keepN + " keep the tier from the file" : "") + ". " : "") +
          (dupes ? dupes + " already here" + (P.dupeMode === "skip" ? ", left as they are. "
              : fills ? ": " + fills + " get empty fields filled in. Nothing you typed and no tier changes. " : ", nothing new to add. ") : "") +
          "Nobody is added twice.</p>" +
        (splitPenn
          ? '<div class="field"><button class="btn" data-act="pvquickpenn">Add the ' + pennNew + " Penn " + (pennNew === 1 ? "person" : "people") + "</button></div>" +
            '<div class="field"><button class="btn-ghost" data-act="pvsortpenn">Add the ' + pennNew + " Penn " + (pennNew === 1 ? "person" : "people") + " and sort them one by one</button></div>" +
            '<div class="field"><button class="btn-ghost" data-act="pvquick">Add all ' + newRows.length + " new people</button></div>"
          : newRows.length
            ? '<div class="field"><button class="btn" data-act="pvquick">Add ' + newRows.length + (keepN ? " \u2014 " + (newRows.length - keepN) + " as Acquaintance" : " as Acquaintance") + "</button></div>"
            : (fills && P.dupeMode === "update"
                ? '<div class="field"><button class="btn" data-act="pvquick">Fill in ' + fills + " existing " + (fills === 1 ? "person" : "people") + "</button></div>"
                : "")) +
        '<div class="field"><button class="btn-ghost" data-act="pvcancel">Cancel</button></div>' +
      "</div>" +

      '<details class="pvmore"><summary>Customize tiers before importing</summary>' +

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
          ? '<p class="note">' + dupes + ' of these already exist here (the same name, email, or a shared phone with a matching name).</p>' +
            '<div class="chips">' +
              [["update", "Fill in their empty fields"], ["skip", "Leave them as they are"]].map(function (o) {
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
        '<div class="field"><button class="btn" data-act="pvconfirm">Import ' + newRows.length + " with these tiers</button></div>" +
      "</div></details>";
  }

  /* ---------- add / queue ---------- */
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

  /* Rising: talked more in the last 45 days than the 45 before. Fading: Close
     or Middle, rated, talked at least twice in the 90 days before that and not
     since. Both are descriptions, never prompts. */
  function momentum() {
    var t = today(), a45 = addDays(t, -45), a90 = addDays(t, -90), a135 = addDays(t, -135);
    var rising = [], fading = [];
    state.contacts.forEach(function (c) {
      var h = c.interactions || [];
      if (!h.length || c.pending) return;
      var now = 0, before = 0, earlier = 0;
      h.forEach(function (d) {
        if (d > a45) now++;
        else if (d > a90) before++;
        if (d <= a45 && d > a135) earlier++;
      });
      if (now >= 2 && now > before) rising.push({ c: c, n: now });
      else if (!now && earlier >= 2 && tracked(c) && potLevel(c.potential) >= MIN_POTENTIAL) fading.push({ c: c, n: earlier });
    });
    function top(list) { return list.sort(function (x, y) { return y.n - x.n; }).slice(0, 5); }
    return { rising: top(rising), fading: top(fading) };
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
    function personRow(c, detail) {
      return '<div class="logrow"><span class="body" data-act="opencontact" data-id="' + c.id + '">' +
        '<span class="t">' + (esc(c.name) || "Unnamed") + "</span>" +
        '<span class="d">' + tierBadge(c.tier) + "<span>" + esc(detail) + "</span></span></span></div>";
    }

    // Tier balance
    var active = state.contacts.filter(function (c) { return !c.pending; });
    var total = active.length || 1;
    var balance = TIERS.map(function (t) {
      var n = active.filter(function (c) { return c.tier === t; }).length;
      return '<div class="balrow"><span class="ball">' + tierLabel(t) + '</span>' +
        '<span class="balbar"><i class="t-' + t.toLowerCase() + '" style="width:' + Math.max(n ? 2 : 0, Math.round(n / total * 100)) + '%"></i></span>' +
        '<span class="baln">' + n + "</span></div>";
    }).join("");

    // Who this month
    var key = now.key, month = [];
    active.forEach(function (c) {
      var n = (c.interactions || []).filter(function (d) { return monthKey(d) === key; }).length;
      if (n) month.push({ c: c, n: n });
    });
    month.sort(function (x, y) { return y.n - x.n || (x.c.name || "").localeCompare(y.c.name || ""); });

    var mo = momentum();
    var tags = tagValues().slice(0, 8);

    return '<button class="btn-ghost sm" data-act="opensettings">← Settings</button>' +
      '<div class="eyebrow">' + esc(now.monthName) + "</div><h2>Trends</h2>" +
      subLine("For noticing patterns. These are not scores, and none of this sees how any of it felt.") +

      '<div class="trends">' +
        trend("New people entered", now.added.length, prev.added.length, prev2.added.length) +
        trend("Moved closer", now.deepened.length, prev.deepened.length, prev2.deepened.length) +
        trend("Conversations logged", now.logged, prev.logged, prev2.logged) +
      "</div>" +

      '<h3 class="logsec">Your circle</h3><div class="card balance">' + balance +
        '<p class="hint" style="margin:8px 0 0">' + active.filter(isPenn).length + " of " + active.length + " are from Penn" +
          (active.filter(isFamily).length ? ", " + active.filter(isFamily).length + " are family" : "") + ".</p></div>" +

      (month.length
        ? '<h3 class="logsec">Talked to this month <span class="n">' + month.length + "</span></h3><div class=\"loglist\">" +
          month.slice(0, 10).map(function (x) { return personRow(x.c, x.n === 1 ? "once" : x.n + " times"); }).join("") + "</div>" +
          (month.length > 10 ? '<p class="hint">And ' + (month.length - 10) + " more.</p>" : "")
        : "") +

      (mo.rising.length
        ? '<h3 class="logsec">Rising</h3><p class="hint" style="margin-top:-4px">Talking more in the last 45 days than the 45 before.</p><div class="loglist">' +
          mo.rising.map(function (x) { return personRow(x.c, x.n + " recent conversations"); }).join("") + "</div>"
        : "") +
      (mo.fading.length
        ? '<h3 class="logsec">Gone quiet</h3><p class="hint" style="margin-top:-4px">Close or Middle, talked regularly before, nothing in 45 days.</p><div class="loglist">' +
          mo.fading.map(function (x) { return personRow(x.c, whyNow(x.c)); }).join("") + "</div>"
        : "") +

      (now.deepened.length
        ? '<h3 class="logsec">Moved closer this month</h3><div class="loglist">' +
          now.deepened.map(function (m) { return personRow(m.c, m.from + " → " + m.to); }).join("") + "</div>"
        : "") +

      (tags.length
        ? '<h3 class="logsec">Groups</h3><div class="filters">' + tags.map(function (v) {
            return '<button class="filter" data-act="opentag" data-val="' + esc(v.key) + '">' + esc(v.key) + '<span class="n">' + v.n + "</span></button>";
          }).join("") + "</div>"
        : "") +

      '<p class="hint" style="margin-top:18px">Counts people entered in the app and tier changes made here. ' +
      'Imported contacts are excluded from "new people".</p>';
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

  function cleanFiltersHTML() {
    var nd = dupeGroups().length;
    return '<div class="filters">' + CLEAN_FILTERS.map(function (f) {
        var n = state.contacts.filter(function (c) { return !c.pending && f.test(c); }).length;
        return '<button class="filter' + (cleanup.filter === f.key ? " on" : "") + '" data-act="clfilter" data-val="' + f.key + '">' +
          f.label + '<span class="n">' + n + "</span></button>";
      }).join("") +
      '<button class="filter' + (cleanup.filter === "dupes" ? " on" : "") + '" data-act="clfilter" data-val="dupes">Duplicates<span class="n">' + nd + "</span></button>" +
      "</div>";
  }

  function viewDupes() {
    var groups = dupeGroups();
    function meta(c) {
      var m = [c.tier];
      if (isPenn(c)) m.push("Penn");
      if (c.school && !pennText(c.school)) m.push(c.school);
      if (c.company && !pennText(c.company)) m.push(c.company);
      if (c.phone) m.push("\u2026" + digits(c.phone).replace(/\D/g, "").slice(-4));
      if (c.email) m.push(c.email.split("@")[1] || "");
      if (interactionCount(c)) m.push(interactionCount(c) + " logged");
      return m.filter(Boolean).join(" \u00b7 ");
    }
    return pageHead("cleanup", "Prune the list", "Duplicates") +
      subLine("The same person saved more than once. Merging keeps the closest tier, every note and every logged conversation.") +
      cleanFiltersHTML() +
      (!groups.length
        ? '<div class="card ok-card"><h3>No duplicates</h3><p class="note">Nobody here is saved twice.</p></div>'
        : '<div class="rowsplit" style="margin-bottom:10px"><p class="hint" style="margin:0">' + groups.length + " " +
            (groups.length === 1 ? "person is" : "people are") + " saved more than once.</p>" +
            '<button class="btn-ghost sm" data-act="mergeall">Merge all</button></div>' +
          groups.map(function (g) {
            var keep = keeperOf(g);
            var ordered = [keep].concat(g.filter(function (c) { return c !== keep; }));
            return '<div class="card dupegroup">' +
              ordered.map(function (c, i) {
                return '<div class="duperow"><span class="t">' + (esc(c.name) || "Unnamed") +
                  (i === 0 ? ' <span class="keeps">keeps</span>' : "") + "</span>" +
                  '<span class="d">' + esc(meta(c)) + "</span></div>";
              }).join("") +
              '<div class="field"><button class="btn-ghost sm" data-act="mergegroup" data-val="' +
                g.map(function (c) { return c.id; }).join(",") + '">Merge into one</button></div>' +
            "</div>";
          }).join("")) +
      '<div class="cleanbar"><button class="btn-ghost" data-act="clexit">Done</button></div>';
  }

  function viewCleanup() {
    if (cleanup.filter === "dupes") return viewDupes();
    var list = cleanupCandidates();
    var markedIds = Object.keys(cleanup.marked).filter(function (k) { return cleanup.marked[k]; });
    var shown = searchContacts(list, cleanup.q || "");

    return pageHead("cleanup", "Prune the list", "Clean up") +
      subLine("Tap anyone you no longer want. Nothing is deleted until you confirm.") +
      cleanFiltersHTML() +

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

    var captureCard =
      '<div class="card capture"><h3>Just met someone</h3>' +
        '<input type="text" id="qLine" placeholder="Sam Lee at Geography Club" autocomplete="off" ' +
          'autocapitalize="words" enterkeyhint="done" aria-label="Name, and where you met">' +
        '<p class="hint" style="margin:8px 0 0">Name, then where you met if you like. Enter saves. Nothing else is needed.</p>' +
        '<div class="field caprow"><button class="chip pennchip' + (qPennOn() ? " on" : "") + '" id="qPenn" data-act="qpenn">' +
          (qPennOn() ? "\u2713 From Penn" : "From Penn") + "</button>" +
          '<button class="chip famchip' + (qFamily ? " on" : "") + '" id="qFamily" data-act="qfamily">' +
          (qFamily ? "\u2713 Family" : "Family") + "</button></div>" +
        '<p class="hint" id="qPennHint" style="margin:6px 0 0">' + capturePennHint() + "</p>" +
        '<div class="field"><button class="btn" data-act="quickadd">Save</button></div>' +
        '<details class="more"' + (qOpen ? " open" : "") + ' id="qMore"><summary>More details</summary>' +
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
            '<div><label class="f">Notes</label><input type="text" id="qNotes" placeholder="Optional" autocomplete="off"></div>' +
          "</div>" +
        "</details>" +
      "</div>" +
      justAddedHTML() +
      backupNagHTML();

    var sortCard = (!pending.length && !queueHistory.length ? "" :
      '<div class="card sortcard"><h3>Sort imported contacts</h3>' +
        (!pending.length
          ? '<p class="ok">All caught up — nothing waiting.</p>' +
            (queueHistory.length ? '<div class="field"><button class="btn-ghost" data-act="queueback">← Undo last sort</button></div>' : "")
          /* Everything needed to sort someone sits under their name: the Penn
             setting (stays on from person to person), Family, and the tier
             buttons that save and move on. Details are folded below. */
          : '<span class="queue-pos">' + (queueIndex + 1) + " of " + pending.length + "</span>" +
            '<div class="queue-name">' + esc(cur.name) +
              (isFamily(cur) ? ' <span class="tag fam">Family</span>' : "") +
              (isPenn(cur) ? ' <span class="tag pn">Penn</span>' : "") + "</div>" +
            (cur.notes ? '<p class="note">' + esc(cur.notes) + "</p>" : "") +
            '<div class="field caprow">' +
              '<button class="chip pennchip' + (sortPennOn() ? " on" : "") + '" id="sortPenn" data-act="sortpenn">' +
                (sortPennOn() ? "✓ Save as Penn" : "Save as Penn") + "</button>" +
              '<button class="chip famchip' + (isFamily(cur) ? " on" : "") + '" data-act="togglefamily" data-id="' + cur.id + '">' +
                (isFamily(cur) ? "✓ Family" : "Family") + "</button>" +
            "</div>" +
            '<p class="hint" style="margin:6px 0 0">' + (sortPennOn()
              ? "Everyone you save here gets School: Penn. Stays on until you turn it off."
              : "Off. Each person keeps whatever Penn they already have.") + "</p>" +
            '<div class="field"><label class="f">Save as — one tap saves and shows the next person</label><div class="chips">' +
              TIERS.map(function (t) { return '<button class="chip" data-t="' + t + '" data-act="queuetier" data-val="' + t + '">' + t + "</button>"; }).join("") +
            "</div></div>" +
            '<div class="queue-nav">' +
              '<button class="btn-ghost" data-act="queueback"' + (queueHistory.length || queueIndex ? "" : " disabled") + '>← Back</button>' +
              '<button class="btn-ghost" data-act="queueskip">Skip →</button>' +
            "</div>" +
            '<details class="more"><summary>Edit details</summary>' +
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
            '<div class="field"><button class="btn-danger" data-act="queuedelete" data-id="' + cur.id + '">Delete this contact</button></div>' +
            "</details>") +
      "</div>");

    /* While people are waiting to be sorted, their card comes first so the
       Save as Penn and tier buttons are at the top of the screen. */
    return pageHead("add", "New person", "Add") +
      (pending.length
        ? sortCard + captureCard
        : subLine("Type a name and press Enter. That is a complete entry.") + captureCard + sortCard) +

      /* Import, backup and sync live in Settings so this tab stays about one
         thing: getting a person into the app. */
      '<div class="field"><button class="btn-ghost" data-act="opensettings">Import a file, back up or sync →</button></div>' +
      '<p class="hint" style="text-align:center">Field Notes v' + APP_VERSION + "</p>";
  }

  function syncCardHTML() {
    var on = window.FNSync && FNSync.enabled();
    var cfg = on ? FNSync.config() : null;
    if (!on) {
      return '<div class="card"><h3>Sync across devices</h3>' +
        '<p class="note">Off. Turn it on to edit from your phone and laptop and have both stay current. ' +
        'Your contacts are encrypted on this device with your passphrase before upload — the server only ever stores gibberish.</p>' +
        '<div class="field"><label class="f">Passphrase</label>' +
          '<input type="password" id="syncPass" placeholder="At least 8 characters" autocomplete="new-password"></div>' +
        '<div class="field"><label class="f">Passphrase again</label>' +
          '<input type="password" id="syncPass2" placeholder="Only needed when turning sync on" autocomplete="new-password"></div>' +
        '<div class="warnbox"><strong>This passphrase cannot be recovered or reset.</strong> Nobody else has it, including the ' +
          'server. If you forget it, the synced copy can never be read again. Write it down or save it in a password manager ' +
          'before you turn sync on. Your contacts on this device are not affected either way.</div>' +
        '<div class="field"><button class="btn" data-act="syncon">Turn on sync</button></div>' +
        '<div class="field"><label class="f">Already synced on another device?</label>' +
          '<input type="text" id="syncJoin" placeholder="Paste the sync code from that device" autocomplete="off"></div>' +
        '<div class="field"><button class="btn-ghost" data-act="syncjoin">Join that sync</button></div>' +
        (syncMsg ? '<p class="note ' + (/fail|wrong|could not|no sync|do not match|at least|paste/i.test(syncMsg) ? "bad" : "ok") + '">' + esc(syncMsg) + "</p>" : "") +
      "</div>";
    }
    return '<div class="card"><h3>Sync <span class="dot-on"></span></h3>' +
      '<p class="note">On. ' + (cfg.lastSync
        ? "Last synced " + esc(ago(cfg.lastSync)) + " (" + esc(new Date(cfg.lastSync).toLocaleString()) + ")."
        : "Not uploaded yet.") + " Syncs by itself a few seconds after each change and when the app opens.</p>" +
      '<div class="field"><label class="f">Sync code — paste this on your other device</label>' +
        '<input type="text" readonly value="' + esc(cfg.id) + '" id="syncId" onclick="this.select()"></div>' +
      '<p class="hint">The code alone is useless without your passphrase.</p>' +
      '<div class="field"><button class="btn"' + (syncBusy ? " disabled" : "") + ' data-act="syncnow">' + (syncBusy ? "Syncing…" : "Sync now") + "</button></div>" +
      (syncMsg ? '<p class="note ' + (/fail|wrong|could not|error|paused/i.test(syncMsg) ? "bad" : "ok") + '">' + esc(syncMsg) + "</p>" : "") +
      '<p class="hint">The passphrase cannot be recovered or reset. Keep a full backup (above) as well; sync is not a backup.</p>' +
      '<div class="field"><button class="btn-ghost" data-act="syncoff">Turn off sync on this device</button></div>' +
    "</div>";
  }

  /* ============================================================
     Render
     ============================================================ */
  function render() {
    if (tab === "reconnect" && !reconnectVisible()) tab = "tiering";
    var syncOn = window.FNSync && FNSync.enabled();
    document.getElementById("totalCount").textContent = state.contacts.length + " contacts" +
      (!syncOn ? "" : syncBad ? " \u00b7 sync problem, see Settings"
        : FNSync.config().lastSync ? " \u00b7 synced " + ago(FNSync.config().lastSync) : " \u00b7 not synced yet");
    var pend = state.contacts.filter(function (c) { return c.pending; }).length;
    var pill = document.getElementById("pendingPill");
    pill.hidden = !pend;
    pill.textContent = pend;

    var coldN = worthReaching(true).length + promises().length;
    document.body.classList.toggle("discreet", !!state.settings.discreet);
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
      /* cleanup and the import preview are modes, not tabs: they take over
         whatever screen you launched them from, including Settings. */
      cleanup ? viewCleanup() :
      importPreview ? viewImportPreview() :
      tab === "tiering" ? viewTiering() :
      tab === "settings" ? viewSettings() :
      tab === "insights" ? viewInsights() :
      tab === "log" ? viewLog() :
      tab === "reconnect" ? viewReconnect() :
      viewAdd();

    /* Give every field an accessible name. Visible labels sit beside the inputs
       rather than wrapping them, so screen readers would otherwise announce
       "edit text" for all of them. */
    var fields = document.getElementById("view").querySelectorAll("input:not([aria-label]), textarea:not([aria-label])");
    for (var f = 0; f < fields.length; f++) {
      var fe = fields[f];
      var lab = fe.previousElementSibling && fe.previousElementSibling.tagName === "LABEL" ? fe.previousElementSibling
              : fe.parentNode ? fe.parentNode.querySelector("label") : null;
      var nm = (lab && lab.textContent) || fe.getAttribute("placeholder") || "";
      if (nm) fe.setAttribute("aria-label", nm.replace(/\s+/g, " ").trim());
    }
    var pressed = document.getElementById("view").querySelectorAll(".chip, .filter, .seg button");
    for (var pz = 0; pz < pressed.length; pz++) pressed[pz].setAttribute("aria-pressed", pressed[pz].classList.contains("on") ? "true" : "false");

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
    // Never over the Add tab (it would sit on what you are typing) or the
    // Reach tab (the same person is already in the list underneath).
    if (!c || !i || !i.cold || tab === "add" || tab === "reconnect" || importPreview || cleanup) { host.hidden = true; host.innerHTML = ""; return; }
    host.hidden = false;
    host.innerHTML =
      '<div class="nudge-body">' +
        '<span class="nudge-lbl">Worth reaching out to</span>' +
        '<strong>' + esc(c.name) + "</strong>" +
        '<span class="nudge-sub">' + tierLabel(c.tier) + " · " + esc(whyNow(c) || potBlurb(c.potential)) + "</span>" +
        ((c.followUp || c.notes) ? '<span class="nudge-ctx">' + esc(snippet(c.followUp ? "You said: " + c.followUp : c.notes, 80)) + "</span>" : "") +
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
    var stampAtStart = state.updatedAt, sent = state;
    FNSync.syncNow(state).then(function (res) {
      syncBusy = false;
      /* Anything you changed while the request was in flight is not in the
         result. Fold the result into what is on screen now instead of
         replacing it, then sync again to upload the difference. */
      var changedMeanwhile = state !== sent || state.updatedAt !== stampAtStart;
      state = migrate(changedMeanwhile ? FNSync.merge(state, res.state, stampAtStart) : res.state);
      save();
      syncBad = false;
      syncMsg = "Synced " + new Date().toLocaleTimeString();
      // Do not redraw under someone who is typing; the next action will.
      var a = document.activeElement;
      if (!(a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && a.type !== "file")) render();
      if (!quiet) toast("Synced");
      if (changedMeanwhile) scheduleSync();
    }).catch(function (err) {
      syncBusy = false;
      syncBad = true;
      var m = err && err.message ? err.message : "unknown";
      syncMsg = m === "WRONG_PASSPHRASE"
        ? "Wrong passphrase for this sync code."
        : m === "RATE_LIMITED"
          ? "Sync is paused for a few minutes (too many requests). Your changes are saved on this device."
        : m === "TOO_LARGE"
          ? "Sync failed: the data is over the 3 MB limit. Your changes are saved on this device; clean up old contacts or long notes."
        : /failed to fetch|networkerror|load failed/i.test(m)
          // Offline is the common case, and it is harmless: every edit is
          // already written to this device before sync is ever attempted.
          ? "No connection — your changes are saved on this device and will sync next time."
          : "Sync failed: " + m;
      if (/^No connection/.test(syncMsg)) syncBad = false;   // offline is normal, not a problem
      var a2 = document.activeElement;
      if (!(a2 && /^(INPUT|TEXTAREA)$/.test(a2.tagName) && a2.type !== "file")) render();
      if (!quiet) toast(syncMsg);
    });
  }

  /* ============================================================
     Events
     ============================================================ */
  document.addEventListener("click", function (e) {
    var tabBtn = e.target.closest(".tab");
    if (tabBtn) {
      tab = tabBtn.dataset.tab; selectMode = false; selected = {}; openId = null;
      importPreview = null; cleanup = null; orderSnapshot = null; listLimit = LIST_STEP;
      render();
      focusCapture();
      return;
    }

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
      case "browseby": listLimit = LIST_STEP; selectMode = false; selected = {}; browseBy = val; groupFilter = ""; tierQuery = ""; searchAll = false; openId = null; orderSnapshot = null; render(); break;
      case "showmore": listLimit += LIST_STEP; render(); break;
      case "filter": listLimit = LIST_STEP; selectMode = false; selected = {}; tierFilter = val; tierQuery = ""; searchAll = false; openId = null; orderSnapshot = null; render(); break;
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
      case "gotoadd": tab = "add"; render(); focusCapture(); break;
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
      case "qpenn": {
        // A tap is a choice, so it becomes the default for the next people too.
        qPenn = !qPennOn();
        state.settings.capturePenn = qPenn;
        commitQuiet();
        setCapturePennChip();
        break;
      }
      case "togglepenn": {
        if (!c) break;
        togglePenn(c);
        commit();
        toast(isPenn(c) ? "Marked " + (c.name || "").split(" ")[0] + " as Penn" : "Marked " + (c.name || "").split(" ")[0] + " as not Penn");
        break;
      }
      case "togglefamily": {
        if (!c) break;
        setFamily(c, !isFamily(c));
        commit();
        toast(isFamily(c) ? (c.name || "").split(" ")[0] + " is in Family" : (c.name || "").split(" ")[0] + " is out of Family");
        break;
      }
      case "qfamily": {
        // Per person: it resets after each save.
        qFamily = !qFamily;
        if (qFamily && qPenn === null && capturePennDefault()) qPenn = false;   // family is rarely from Penn
        else if (!qFamily && qPenn === false && capturePennDefault()) qPenn = null;
        setCapturePennChip();
        break;
      }
      case "selmark": {
        var mids = Object.keys(selected);
        if (!mids.length) break;
        lastMark = mids.map(function (mid) {
          var mc = byId(mid);
          return mc ? { id: mid, school: mc.school, penn: mc.penn, family: mc.family } : null;
        }).filter(Boolean);
        lastMark.forEach(function (m) {
          var mc = byId(m.id);
          if (val === "penn") setPenn(mc, true); else setFamily(mc, true);
        });
        selected = {}; selectMode = false;
        commit();
        toast("Marked " + lastMark.length + (val === "penn" ? " as Penn" : " as Family"), "Undo", "undomark");
        break;
      }
      case "undomark": {
        if (!lastMark) { toast("Nothing to undo"); break; }
        lastMark.forEach(function (m) {
          var mc = byId(m.id);
          if (!mc) return;
          mc.school = m.school;
          if (m.penn === undefined) delete mc.penn; else mc.penn = m.penn;
          if (m.family === undefined) delete mc.family; else mc.family = m.family;
          touch(mc);
        });
        var un2 = lastMark.length; lastMark = null;
        commit();
        toast("Put back " + un2);
        break;
      }
      case "pennonly":
        pennOnly = !pennOnly; state.settings.pennOnly = pennOnly;
        orderSnapshot = null; listLimit = LIST_STEP; selected = {};
        commitQuiet(); render();
        break;
      case "quickadd": quickAdd(); break;
      case "addanyway": dupeOk = val; quickAdd(val); break;
      case "dismissadded": lastAdded = null; render(); break;

      case "queuetier": {
        var p = state.contacts.filter(function (x) { return x.pending; });
        var person = p[queueIndex];
        if (person) {
          queueHistory.push({ id: person.id, tier: person.tier, school: person.school, penn: person.penn, hadPenn: "penn" in person });
          if (sortPennOn()) setPenn(person, true);
          person.tier = val; person.pending = false; touch(person);
          commit();
        }
        break;
      }
      case "sortpenn":
        // A setting, not a per-person tick: it stays as you leave it.
        state.settings.sortPenn = !sortPennOn();
        commit();
        break;
      case "selsort":
      case "sortimported": {
        var sendIds = act === "selsort" ? Object.keys(selected) : justImported().map(function (x) { return x.id; });
        if (!sendIds.length) break;
        lastQueued = sendIds.filter(function (qid) { var qc = byId(qid); return qc && !qc.pending; });
        lastQueued.forEach(function (qid) { var qc = byId(qid); qc.pending = true; touch(qc); });
        selected = {}; selectMode = false;
        queueIndex = 0; queueHistory = [];
        tab = "add"; openId = null; orderSnapshot = null;
        commit();
        toast(lastQueued.length + " waiting to be sorted", "Undo", "undoqueue");
        break;
      }
      case "undoqueue": {
        if (!lastQueued) { toast("Nothing to undo"); break; }
        lastQueued.forEach(function (qid) { var qc = byId(qid); if (qc && qc.pending) { qc.pending = false; touch(qc); } });
        var nq = lastQueued.length; lastQueued = null;
        commit();
        toast("Took " + nq + " back out of the sort queue");
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
            back.pending = true; back.tier = last.tier;
            if ("school" in last) {
              back.school = last.school;
              if (last.hadPenn) back.penn = last.penn; else delete back.penn;
            }
            touch(back);
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
      case "pvconfirm": applyImport(false); break;
      case "pvquick": applyImport(true); break;
      case "pvquickpenn": applyImport(true, true); break;
      case "pvsortpenn": applyImport(true, true, true); break;
      case "mergegroup": {
        var gids = (val || "").split(",");
        var grp = dupeGroups().filter(function (g) { return g.some(function (x) { return gids.indexOf(x.id) !== -1; }); });
        var mn = mergeGroups(grp);
        toast("Merged " + (mn + 1) + " into one", mn ? "Undo" : null, "undomerge");
        break;
      }
      case "mergeall": {
        var all = dupeGroups();
        if (!all.length) break;
        var extra = all.reduce(function (s2, g) { return s2 + g.length - 1; }, 0);
        if (!confirm("Merge " + all.length + " groups? " + extra + " duplicate records fold into the one you keep. " +
                     "Nothing typed is lost, and you get one undo.")) break;
        mergeGroups(all);
        toast("Merged " + all.length + " groups", "Undo", "undomerge");
        break;
      }
      case "undomerge": {
        if (!lastMerge) { toast("Nothing to undo"); break; }
        state.contacts = JSON.parse(lastMerge.contacts);
        state.deleted = JSON.parse(lastMerge.deleted);
        lastMerge = null; orderSnapshot = null;
        commit();
        toast("Merge undone");
        break;
      }
      case "opendupes": cleanup = { filter: "dupes", marked: {}, q: "" }; tab = "settings"; render(); break;
      case "undoimport": undoImport(); break;
      case "undomove": undoMove(); break;
      case "selmode": selectMode = !selectMode; selected = {}; openId = null; render(); break;
      case "selpick":
        if (selected[id]) delete selected[id]; else selected[id] = true;
        render();
        break;
      case "selall": {
        var allNow = el.dataset.ids ? el.dataset.ids.split(",") : [];
        var every = allNow.every(function (x) { return selected[x]; });
        selected = {};
        if (!every) allNow.forEach(function (x) { selected[x] = true; });
        render();
        break;
      }
      case "seltag": {
        var tids = Object.keys(selected);
        if (!tids.length) break;
        var tg = cleanTag(prompt("Tag for " + tids.length + (tids.length === 1 ? " person" : " people") + " (one word, e.g. geoclub)", ""));
        if (!tg) break;
        lastTagged = [];
        tids.forEach(function (tid) {
          var tc = byId(tid);
          if (!tc || tagsOf(tc).indexOf(tg) !== -1) return;
          lastTagged.push({ id: tc.id, notes: tc.notes });
          tc.notes = (tc.notes ? tc.notes.replace(/\s*$/, "") + " " : "") + tg;
          touch(tc);
        });
        selected = {}; selectMode = false;
        commit();
        toast("Tagged " + lastTagged.length + " " + tg, lastTagged.length ? "Undo" : null, "undotag");
        break;
      }
      case "undotag": {
        if (!lastTagged) { toast("Nothing to undo"); break; }
        lastTagged.forEach(function (m) { var uc2 = byId(m.id); if (uc2) { uc2.notes = m.notes; touch(uc2); } });
        var un = lastTagged.length; lastTagged = null;
        commit();
        toast("Removed the tag from " + un);
        break;
      }
      case "opentag":
        tab = "tiering"; browseBy = "tag"; groupFilter = val; tierQuery = ""; searchAll = false;
        openId = null; orderSnapshot = null; listLimit = LIST_STEP;
        render();
        break;
      case "followdone": {
        if (!c) break;
        lastFollow = { id: c.id, text: c.followUp };
        c.followUp = ""; touch(c); commit();
        toast("Done", "Undo", "undofollow");
        break;
      }
      case "undofollow": {
        var fc = lastFollow ? byId(lastFollow.id) : null;
        if (fc) { fc.followUp = lastFollow.text; touch(fc); commit(); toast("Put back"); }
        lastFollow = null;
        break;
      }
      case "discreet":
        state.settings.discreet = val ? val === "on" : !state.settings.discreet;
        commit();
        toast(state.settings.discreet ? "Discreet on \u2014 tier names and ratings hidden" : "Discreet off");
        break;
      case "selmove": {
        var sids = Object.keys(selected);
        if (sids.length) bulkMove(sids, val);
        break;
      }
      case "pvcancel": importPreview = null; render(); toast("Import cancelled"); break;

      /* sync */
      case "syncon": {
        var pass = (document.getElementById("syncPass") || {}).value || "";
        if (pass.length < 8) { syncMsg = "Use at least 8 characters."; render(); break; }
        if (pass !== ((document.getElementById("syncPass2") || {}).value || "")) {
          syncMsg = "The two passphrases do not match. Nothing was turned on."; render(); break;
        }
        if (!confirm("This passphrase cannot be recovered or reset.\n\nIf you forget it, the synced copy can never be read. " +
                     "Have you saved it somewhere safe?")) break;
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
          state = migrate(FNSync.merge(state, migrate(remote), null));
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
      case "exportjson": exportJSON(); break;
      case "rollback": rollbackData(); break;
      case "reloadapp": location.reload(); break;
    }
  });

  function syncChips(sel, val) {
    var nodes = document.querySelectorAll(sel + " .chip");
    for (var i = 0; i < nodes.length; i++) nodes[i].classList.toggle("on", nodes[i].dataset.val === val);
  }

  /* Typing "Penn", "UPenn" or "Wharton" in the capture line switches the
     toggle on for this person. It never switches it off, and it does not
     change the remembered default. */
  function capturePennHint() {
    var on = qPennOn(), def = capturePennDefault();
    var penn = on
      ? (qPenn === true && !def ? "Penn is on for this person." : "Penn stays on for everyone you add until you turn it off.")
      : (qFamily && def ? "Penn is off for this family member." : "Penn is off. It turns on by itself if you type Penn or Wharton.");
    return penn + (qFamily ? " Family is on for this person." : "");
  }
  function setCapturePennChip() {
    var b = document.getElementById("qPenn");
    if (!b) return;
    var on = qPennOn();
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.textContent = on ? "\u2713 From Penn" : "From Penn";
    var f = document.getElementById("qFamily");
    if (f) {
      f.classList.toggle("on", qFamily);
      f.setAttribute("aria-pressed", qFamily ? "true" : "false");
      f.textContent = qFamily ? "\u2713 Family" : "Family";
    }
    var h = document.getElementById("qPennHint");
    if (h) h.textContent = capturePennHint();
  }
  document.addEventListener("input", function (e) {
    if (e.target && e.target.id === "qLine" && !qPennOn() && pennText(e.target.value)) {
      qPenn = true;
      setCapturePennChip();
    }
  });

  document.addEventListener("input", function (e) {
    var el = e.target.closest("[data-act]");
    if (!el || !el.dataset.id) return;
    var c = byId(el.dataset.id);
    if (!c) return;
    var map = {
      setloc: "location", setnotes: "notes", setco: "company", setsc: "school",
      setphone: "phone", setemail: "email", setname: "name", setfollow: "followUp"
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
    if (e.key === "Enter" && e.target.id === "qLine") { e.preventDefault(); quickAdd(); }
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

  /* "Sam Lee at Geography Club" -> name "Sam Lee", context "Met at Geography Club".
     The first " at ", " from ", " in ", " via ", "@", dash, comma or #tag ends
     the name. Anything it cannot split is treated as just a name. */
  function parseCapture(text) {
    var t = String(text || "").replace(/\s+/g, " ").trim().replace(/^(just\s+)?met\s+/i, "");
    if (!t) return { name: "", context: "" };
    var m = /^(.+?)(\s+(?:at|from|in|via)\s+|\s+@\s*|\s+[-\u2013\u2014]\s+|\s*,\s+|\s+(?=#))(.+)$/i.exec(t);
    var name = m ? m[1].trim() : t, context = "";
    if (m) {
      var sep = m[2].trim().toLowerCase(), rest = m[3].trim();
      context = /^(at|from|in|via)$/.test(sep) ? "Met " + sep + " " + rest
              : sep === "@" ? "Met at " + rest
              : rest;
    }
    // A phone keyboard often leaves a name in lower case.
    if (name === name.toLowerCase()) {
      name = name.replace(/(^|[\s-])([a-z])/g, function (x, a, b) { return a + b.toUpperCase(); });
    }
    return { name: name, context: context };
  }

  function focusCapture() {
    if (tab !== "add" || importPreview || cleanup) return;
    // Sorting: no keyboard popping up over the sort card.
    if (state.contacts.some(function (c) { return c.pending; })) return;
    var el = document.getElementById("qLine");
    if (el) el.focus();
  }

  function quickAdd(lineOverride) {
    var line = lineOverride || val("qLine");
    var p = parseCapture(line);
    if (!p.name) { toast("Type a name first"); focusCapture(); return; }

    // Same name already here: say so once instead of silently doubling up.
    var key = normName(p.name);
    if (dupeOk !== line) {
      var twin = null;
      for (var i = 0; i < state.contacts.length; i++) {
        if (normName(state.contacts[i].name) === key) { twin = state.contacts[i]; break; }
      }
      if (twin) {
        toast(twin.name + " is already here (" + twin.tier + ")", "Add anyway", "addanyway");
        var btn = document.querySelector("#toast .toast-act");
        if (btn) btn.dataset.val = line;
        return;
      }
    }
    dupeOk = "";

    var more = document.getElementById("qMore");
    qOpen = !!(more && more.open);
    var loc = val("qLoc");
    var c = blankContact({
      name: p.name, tier: qDraft.tier, potential: qDraft.potential,
      company: val("qCo"), school: val("qSc"), location: loc,
      locationConfirmed: loc ? today() : "",
      notes: [p.context, val("qNotes")].filter(Boolean).join(". "),
      added: today(), tierSince: today()
    });
    // Toggle on (or the line mentions Penn): "Penn" goes into School.
    if (qPennOn() || pennText(line)) setPenn(c, true);
    if (qFamily) c.family = true;
    state.contacts.unshift(c);
    lastAdded = c.id;
    qDraft = { tier: "Acquaintance", potential: "" };
    qPenn = null;
    qFamily = false;
    commit();
    toast("Added " + p.name);
    focusCapture();
  }

  /* After a capture, the two judgements worth making while it is fresh are one
     tap each, right under the box. Ignoring the card is a complete answer. */
  function justAddedHTML() {
    var c = lastAdded ? byId(lastAdded) : null;
    if (!c) return "";
    return '<div class="card justadded">' +
      '<div class="rowsplit"><h3 style="margin:0">' + esc(c.name) + ' <span class="n">added</span></h3>' +
        '<button class="btn-ghost sm" data-act="dismissadded">Done</button></div>' +
      (c.notes ? '<p class="note">' + esc(c.notes) + "</p>" : "") +
      '<div class="field"><label class="f">Tier</label><div class="chips">' +
        TIERS.map(function (t) {
          return '<button class="chip' + (c.tier === t ? " on" : "") + '" data-t="' + t + '" data-act="settier" data-id="' + c.id + '" data-val="' + t + '">' + tierLabel(t) + "</button>";
        }).join("") + "</div></div>" +
      '<div class="field"><label class="f">Potential to deepen</label><div class="chips">' +
        POTENTIAL.map(function (x) {
          return '<button class="chip' + (c.potential === x.key ? " on" : "") + '" data-p="1" data-act="setpot" data-id="' + c.id + '" data-val="' + x.key + '" title="' + x.blurb + '">' + x.key + "</button>";
        }).join("") + "</div></div>" +
      pennChipHTML(c) +
      '<div class="field"><button class="btn-ghost sm" data-act="delete" data-id="' + c.id + '">Remove ' + esc(c.name.split(" ")[0]) + "</button></div>" +
    "</div>";
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
        potential: potLevel(row.potential) ? row.potential : "",
        locationConfirmed: row.locationconfirmed || "",
        followUp: row.followup || "",
        penn: /^(yes|y|true|1)$/i.test(row.penn || "") ? true : /^(no|n|false|0)$/i.test(row.penn || "") ? false : undefined,
        family: /^(yes|y|true|1)$/i.test(row.family || "") ? true : undefined,
        company: row.company || row.organization || "",
        school: row.school || "",
        location: row.location || row.city || "",
        notes: [row.notes || row.position || "", row.role || ""].filter(Boolean).join(" "),
        phone: row.phone || row["phone number"] || "",
        email: row["email address"] || row.email || "",
        interactions: dedupeDates((row.interactions || "").split(";").filter(Boolean)),
        tierLog: (row.tierchanges || "").split(";").filter(Boolean).map(function (x) {
          var q = x.split(">");
          return { date: q[0], from: q[1] || "", to: q[2] || "" };
        }),
        pending: !hasTier,
        added: ""
      });
    }).filter(function (c) { return c.name; });
  }

  /* vCard 3.0/4.0 as phones and iCloud export it: long lines are folded onto
     the next line, Apple prefixes fields with "item1.", a card can have many
     phones and emails, and photos make the file huge. Photos are skipped.
     Extra phones and emails are kept only for matching duplicates. */
  function vUnescape(s) { return String(s || "").replace(/\\n/gi, " ").replace(/\\([,;:\\])/g, "$1").trim(); }
  function vParts(raw) {
    return String(raw || "").replace(/\\\\/g, "\u0002").replace(/\\;/g, "\u0001").split(";")
      .map(function (p) { return vUnescape(p.replace(/\u0001/g, "\\;").replace(/\u0002/g, "\\\\")); });
  }
  function parseVCF(text) {
    var unfolded = String(text).replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "");
    var cards = unfolded.split(/END:VCARD/i), out = [];
    cards.forEach(function (card) {
      if (!/BEGIN:VCARD/i.test(card)) return;
      var props = {};
      card.split("\n").forEach(function (line) {
        var m = /^(?:[A-Za-z0-9-]+\.)?([A-Za-z-]+)((?:;[^:]*)?):(.*)$/.exec(line);
        if (!m) return;
        var k = m[1].toUpperCase();
        if (k === "PHOTO" || k === "LOGO" || k === "SOUND" || k === "KEY") return;
        (props[k] = props[k] || []).push(m[3]);
      });
      var name = vUnescape((props.FN || [""])[0]);
      if (!name && props.N) {
        var n = vParts(props.N[0]);   // Last;First;Middle;Prefix;Suffix
        name = [n[3], n[1], n[2], n[0], n[4]].filter(Boolean).join(" ");
      }
      name = name.replace(/\s+/g, " ").trim();
      if (!name) return;
      var emails = (props.EMAIL || []).map(function (e) { return vUnescape(e).replace(/^mailto:/i, "").toLowerCase(); }).filter(Boolean);
      var phones = (props.TEL || []).map(function (t) { return vUnescape(t).replace(/^tel:/i, ""); }).filter(Boolean);
      var penn = emails.filter(pennMail);
      var org = props.ORG ? vParts(props.ORG[0]).filter(Boolean).join(" \u00b7 ") : "";
      out.push(blankContact({
        name: name, tier: "Acquaintance", company: org,
        phone: phones[0] || "", email: penn[0] || emails[0] || "",
        notes: props.NOTE ? vUnescape(props.NOTE[0]) : "",
        pending: true, _phones: phones, _emails: emails
      }));
    });
    return out;
  }

  /* Cards for the same person inside one file become one row. */
  function mergeWithinFile(rows) {
    var kept = [], idx = {}, merged = 0;
    rows.forEach(function (c) {
      var twin = findSame(c, idx);
      if (twin) {
        absorb(twin, c);
        twin._phones = (twin._phones || [twin.phone]).concat(c._phones || [c.phone]).filter(Boolean);
        twin._emails = (twin._emails || [twin.email]).concat(c._emails || [c.email]).filter(Boolean);
        if (!pennMail(twin.email)) { var pm = twin._emails.filter(pennMail)[0]; if (pm) twin.email = pm; }
        if (twin.pending && !c.pending) { twin.pending = false; twin.tier = c.tier; }
        merged++;
      } else {
        kept.push(c);
      }
      personKeys(twin || c).forEach(function (k) {
        var l = idx[k] = idx[k] || [];
        if (l.indexOf(twin || c) === -1) l.push(twin || c);
      });
    });
    return { rows: kept, merged: merged };
  }

  function handleFile(e) {
    var f = e.target.files && e.target.files[0];
    if (!f) return;
    var status = document.getElementById("importStatus");
    var reader = new FileReader();
    reader.onload = function (ev) {
      var text = String(ev.target.result || "");
      if (/\.json$/i.test(f.name) || /^\s*\{/.test(text.slice(0, 50))) {
        e.target.value = "";
        restoreJSON(text, status);
        return;
      }
      var rows;
      try {
        rows = /\.vcf$/i.test(f.name) || /BEGIN:VCARD/i.test(text.slice(0, 200))
          ? parseVCF(text) : parseCSV(text);
      } catch (err) { rows = []; }
      if (!rows.length) {
        if (status) status.textContent = "Could not read any contacts from that file.";
        return;
      }
      var inFile = mergeWithinFile(rows);
      var idx = personIndex(state.contacts);
      importPreview = {
        fileMerged: inFile.merged,
        rows: inFile.rows.map(function (c) {
          var hit = findSame(c, idx);
          // Dry run on a copy: would filling in change anything on that person?
          var fills = hit ? Object.keys(absorb(Object.assign({}, hit), importable(c))).length > 0 : false;
          return { c: c, dupe: hit ? hit.id : null, penn: isPenn(c), fills: fills };
        }),
        /* v9.3: everyone lands in Acquaintance by default. Sorting is something
           you do later, for the people who matter, not a queue you must clear.
           v9.9: people already here get their blanks filled by default; that
           never changes a tier or anything you typed. */
        dupeMode: "update", defaultTier: "Acquaintance", groupBy: "school", groups: {}, respectFile: true
      };
      e.target.value = "";
      render();
    };
    reader.readAsText(f);
  }

  function applyImport(quick, onlyPenn, toQueue) {
    var P = importPreview, added = 0, updated = 0, skipped = 0, left = 0;
    if (quick) { P.defaultTier = "Acquaintance"; P.groups = {}; }
    var batch = "imp-" + uid(), addedIds = [], filled = [];
    P.rows.forEach(function (r) {
      var c = r.c;
      if (r.dupe) {
        var ex = P.dupeMode === "update" ? byId(r.dupe) : null;
        if (ex) {
          var stamp = ex.updatedAt;
          var prev = absorb(ex, importable(c));
          if (Object.keys(prev).length) { filled.push({ id: ex.id, prev: prev, updatedAt: stamp }); touch(ex); updated++; }
        } else skipped++;
        return;
      }
      if (onlyPenn && !r.penn) { left++; return; }
      var t = effTier(P, r);
      if (t === "Unsorted") { c.pending = true; c.tier = "Acquaintance"; }
      else { c.pending = false; c.tier = t; }
      delete c._phones; delete c._emails;
      // Any sign of Penn on a new person is saved as School: Penn.
      if (c.penn !== false && isPenn(c)) setPenn(c, true);
      if (toQueue) c.pending = true;   // straight into the sort queue on the Add tab
      c.importBatchId = batch;
      c.importedAt = today();
      touch(c);
      state.contacts.push(c);
      addedIds.push(c.id);
      added++;
    });
    importPreview = null;
    queueHistory = []; queueIndex = 0;
    if (added) state.settings.lastImport = batch;
    lastImport = (added || filled.length) ? { batch: batch, ids: addedIds, filled: filled } : null;
    if (toQueue && added) { tab = "add"; openId = null; cleanup = null; }
    commit();
    toast("Added " + added + (updated ? ", filled in " + updated : "") + (left ? ", left out " + left + " not from Penn" : ""),
          lastImport ? "Undo" : null, "undoimport");
  }

  /* What an import may contribute to someone already here. Tier, clock and
     snooze are never on this list. */
  function importable(c) {
    return { name: c.name, company: c.company, school: c.school, location: c.location, phone: c.phone,
             email: c.email, notes: c.notes, penn: c.penn, family: c.family, potential: c.potential,
             interactions: c.interactions, tierLog: c.tierLog };
  }

  /* Removes exactly the contacts one import added, with tombstones so a sync
     from another device cannot bring them back, and puts back every field
     the import filled in on people who were already here. */
  function undoImport() {
    if (!lastImport) { toast("Nothing to undo"); return; }
    var ids = lastImport.ids;
    state.contacts = state.contacts.filter(function (c) { return ids.indexOf(c.id) === -1; });
    ids.forEach(function (id) { state.deleted.push({ id: id, at: nowISO() }); });
    (lastImport.filled || []).forEach(function (f) {
      var c = byId(f.id);
      if (!c) return;
      Object.keys(f.prev).forEach(function (k) { if (f.prev[k] === undefined) delete c[k]; else c[k] = f.prev[k]; });
      touch(c);
    });
    if (state.settings.lastImport === lastImport.batch) state.settings.lastImport = "";
    if (tierFilter === "Imported") tierFilter = "Acquaintance";
    var n = ids.length, m = (lastImport.filled || []).length;
    lastImport = null;
    commit();
    toast("Import undone" + (n ? ", removed " + n : "") + (m ? ", restored " + m : ""));
  }

  /* Multi-select "Move to". Bulk moves into a tracked tier stagger the clock
     start forward across two weeks, so a batch of 30 never comes due on the
     same day. Nobody is ever made due sooner than a single move would. */
  function bulkMove(ids, to) {
    var moved = [], n = ids.length;
    ids.forEach(function (id, i) {
      var c = byId(id);
      if (!c || (c.tier === to && !c.pending)) return;
      moved.push({ id: c.id, tier: c.tier, pending: c.pending, tierSince: c.tierSince,
                   logLen: (c.tierLog || []).length, snoozedUntil: c.snoozedUntil });
      if (c.tier !== to) c.tierLog = (c.tierLog || []).concat({ date: today(), from: c.tier, to: to });
      var offset = (n > 5 && (to === "Close" || to === "Middle")) ? Math.floor(i * 14 / n) : 0;
      c.tierSince = addDays(today(), offset);
      c.tier = to; c.pending = false; c.snoozedUntil = "";
      touch(c);
    });
    lastMove = moved.length ? moved : null;
    selected = {}; selectMode = false;
    orderSnapshot = null;
    commit();
    toast("Moved " + moved.length + " to " + to, moved.length ? "Undo" : null, "undomove");
  }
  function undoMove() {
    if (!lastMove) { toast("Nothing to undo"); return; }
    lastMove.forEach(function (m) {
      var c = byId(m.id);
      if (!c) return;
      c.tier = m.tier; c.pending = m.pending; c.tierSince = m.tierSince;
      c.snoozedUntil = m.snoozedUntil;
      c.tierLog = (c.tierLog || []).slice(0, m.logLen);
      touch(c);
    });
    var n = lastMove.length;
    lastMove = null;
    orderSnapshot = null;
    commit();
    toast("Moved " + n + " back");
  }

  /* ---------- full backup: lossless, unlike the CSV ---------- */
  function backupString() {
    return JSON.stringify({ app: "field-notes", appVersion: APP_VERSION, exportedAt: nowISO(), state: state });
  }
  function exportJSON() {
    state.settings.lastExport = today();
    var blob = new Blob([backupString()], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "field-notes-backup-" + today() + ".json";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    commit();
    toast("Backup saved \u2014 " + state.contacts.length + " contacts");
  }
  /* Returns the parsed state, or null if the text is not a Field Notes backup. */
  function parseBackup(text) {
    try {
      var j = JSON.parse(text);
      var s = j && j.app === "field-notes" ? j.state : j;
      if (!s || !Array.isArray(s.contacts)) return null;
      return s;
    } catch (err) { return null; }
  }
  function restoreJSON(text, status) {
    var s = parseBackup(text);
    if (!s) { if (status) status.textContent = "That file is not a Field Notes backup."; return; }
    if (!confirm("Restore " + s.contacts.length + " contacts from this backup?\n\n" +
                 "It replaces the " + state.contacts.length + " on this device. " +
                 "What you have now is kept as a rollback copy (Settings, About).")) return;
    keepRollback(JSON.stringify(state));
    applyRestored(s);
    toast("Restored " + state.contacts.length + " contacts");
  }
  function applyRestored(s) {
    state = migrate(s);
    orderSnapshot = null; openId = null; nudgeFor = null;
    save(); render(); scheduleSync();
  }

  /* ---------- one-step rollback copy ---------- */
  function keepRollback(raw) {
    try { localStorage.setItem(PREV_KEY, JSON.stringify({ at: nowISO(), from: lastRanVersion() || "", raw: raw })); return true; }
    catch (e) { return false; }   // storage full: the update still proceeds
  }
  function readRollback() {
    try { return JSON.parse(localStorage.getItem(PREV_KEY) || "null"); } catch (e) { return null; }
  }
  function rollbackInfo() {
    var r = readRollback();
    return r && r.raw ? String(r.at).slice(0, 10) + (r.from ? ", v" + r.from : "") : "";
  }
  function rollbackData() {
    var r = readRollback();
    var s = r && parseBackup(r.raw);
    if (!s) { toast("No earlier copy on this device"); return; }
    if (!confirm("Go back to the copy from " + String(r.at).slice(0, 10) + " (" + s.contacts.length +
                 " contacts)? Changes made since then are replaced. You can undo this once from the same button.")) return;
    var current = JSON.stringify(state);
    applyRestored(s);
    keepRollback(current);
    toast("Went back to the earlier copy");
  }
  function lastRanVersion() {
    try { return localStorage.getItem(VER_KEY) || ""; } catch (e) { return ""; }
  }

  function csvCell(v) {
    v = String(v == null ? "" : v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }

  /* interactions and tierLog are packed into single cells so a plain CSV
     round-trips the full history. Without these a backup silently loses
     every date you ever logged. */
  function csvString() {
    var cols = ["name", "tier", "potential", "penn", "family", "company", "school",
                "location", "locationConfirmed", "lastContact", "notes", "followUp", "phone", "email",
                "interactions", "tierchanges"];
    var lines = [cols.join(",")];
    state.contacts.forEach(function (c) {
      lines.push(cols.map(function (k) {
        if (k === "interactions") return csvCell((c.interactions || []).join(";"));
        // Only your overrides are written; blank means "work it out from company/school".
        if (k === "penn") return c.penn === true ? "yes" : c.penn === false ? "no" : "";
        if (k === "family") return c.family === true ? "yes" : "";
        if (k === "tierchanges") {
          return csvCell((c.tierLog || []).map(function (m) {
            return m.date + ">" + m.from + ">" + m.to;
          }).join(";"));
        }
        var v = c[k] == null ? "" : c[k];
        v = String(v);
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(","));
    });
    return lines.join("\n");
  }

  function exportCSV() {
    var blob = new Blob(["﻿" + csvString()], { type: "text/csv;charset=utf-8" });
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
  /* Before a new version touches stored data, keep the untouched copy. If a
     migration ever goes wrong, Settings > About can put it back. */
  var ranBefore = lastRanVersion(), rawBefore = null;
  try { rawBefore = localStorage.getItem(KEY); } catch (e) {}
  var isUpdate = !!rawBefore && ranBefore !== APP_VERSION;
  if (isUpdate) keepRollback(rawBefore);

  state = load();
  save();
  pennOnly = !!state.settings.pennOnly;
  try { localStorage.setItem(VER_KEY, APP_VERSION); } catch (e) {}
  var firstNudge = nudgeCandidate();
  nudgeFor = firstNudge ? firstNudge.id : null;

  /* Home-screen shortcuts and links: ?tab=add|log|reach, and ?add=Sam+Lee+at+X
     to open Add with the line filled in. The address is cleaned afterwards so a
     refresh does not repeat it. */
  var prefill = "";
  try {
    var qs = new URLSearchParams(location.search);
    var wantTab = qs.get("tab");
    prefill = qs.get("add") || "";
    if (prefill) wantTab = "add";
    if (wantTab === "reach") wantTab = "reconnect";
    if (wantTab === "add" || wantTab === "log" || wantTab === "reconnect") tab = wantTab;
    if ((qs.has("tab") || qs.has("add")) && history.replaceState) {
      qs.delete("tab"); qs.delete("add");
      var rest = qs.toString();
      history.replaceState(null, "", location.pathname + (rest ? "?" + rest : ""));
    }
  } catch (e) {}
  if (tab === "add") nudgeFor = null;   // you came to capture; the reminder can wait

  render();
  if (tab === "add") {
    var ql = document.getElementById("qLine");
    if (ql) { ql.value = prefill; ql.focus(); }
  }
  if (isUpdate && state.contacts.length) toast("Updated to v" + APP_VERSION);

  /* Called by index.html when a new service worker takes control. Reload at
     once unless you are mid-typing, in which case offer it instead. */
  window.FNUpdate = {
    ready: function () {
      var a = document.activeElement;
      var typing = a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && a.type !== "file" && a.value;
      if (typing) toast("New version ready", "Reload", "reloadapp");
      else location.reload();
    }
  };

  var brandEl = document.querySelector(".brand");
  if (brandEl) {
    brandEl.setAttribute("data-act", "discreet");
    brandEl.setAttribute("role", "button");
    brandEl.setAttribute("title", "Tap to hide or show tier names");
  }

  if (TEST) window.__FN = { eval: function (code) { return eval(code); } };

  if (window.FNSync && FNSync.enabled()) doSync(true);
})();
