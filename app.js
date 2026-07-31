/* Field Notes — a private relationship tracker.
   No network calls. All data lives in this browser. */

(function () {
  "use strict";

  /* ============================================================
     Constants
     ============================================================ */
  var TIERS = ["Close", "Middle", "Acquaintance", "Networking"];
  var PURPOSES = ["Chill hang", "Spontaneous hang", "Deep conversation", "Networking", "Unsure"];
  var POTENTIAL = [
    { key: "Rare",   lvl: 4, blurb: "the standout — rare" },
    { key: "Strong", lvl: 3, blurb: "clear pull toward more" },
    { key: "Some",   lvl: 2, blurb: "could go somewhere" },
    { key: "Low",    lvl: 1, blurb: "fine as it is" }
  ];
  var KEY = "field-notes-v4";

  /* ============================================================
     State + storage
     ============================================================ */
  var memoryFallback = null;
  var state, tab = "tiering", openId = null;
  var browseBy = "tier", tierFilter = "Close", groupFilter = "";
  var tierQuery = "", travelQuery = "", queueIndex = 0;
  var qDraft = { tier: "Middle", purpose: "", potential: "" };
  var deferredPrompt = null;

  function uid() {
    return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  }
  function today() { return new Date().toISOString().slice(0, 10); }
  function monthsSince(d) {
    if (!d) return null;
    return Math.round((Date.now() - new Date(d)) / 2592000000);
  }

  function seedToContact(s) {
    return {
      id: uid(), name: s.n || "", tier: s.t || "Acquaintance",
      purpose: "", potential: "", company: s.co || "", school: s.sc || "",
      location: s.l || "", locationConfirmed: "", notes: s.c || "",
      phone: s.ph || "", email: s.em || "", pending: false, added: ""
    };
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* storage blocked — fall through */ }
    if (memoryFallback) return memoryFallback;
    var seed = (window.SEED_CONTACTS || []).map(seedToContact);
    return { contacts: seed, version: 4 };
  }
  function save() {
    memoryFallback = state;
    try { localStorage.setItem(KEY, JSON.stringify(state)); return true; }
    catch (e) { return false; }
  }
  function commit() { save(); render(); }

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
  function tolerance(len) {
    if (len <= 3) return 0;
    if (len <= 5) return 1;
    if (len <= 8) return 2;
    return 3;
  }
  function fuzzyHit(haystack, term) {
    if (!term) return true;
    var h = (haystack || "").toLowerCase(), t = term.toLowerCase();
    if (h.indexOf(t) !== -1) return true;
    if (t.length < 4) return false;
    var tol = tolerance(t.length);
    var words = h.split(/[^a-z0-9']+/);
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
    return [c.name, c.company, c.school, c.location, c.purpose, c.potential, c.notes, c.tier]
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
  function potMeter(p) {
    var found = null;
    for (var i = 0; i < POTENTIAL.length; i++) if (POTENTIAL[i].key === p) found = POTENTIAL[i];
    if (!found) return "";
    var bars = "";
    for (var j = 1; j <= 4; j++) bars += '<i class="' + (j <= found.lvl ? "f" : "") + '"></i>';
    return '<span class="pot" data-lvl="' + found.lvl + '" title="Potential: ' + esc(p) + '">' + bars + "</span>";
  }
  function tierBadge(t) {
    if (!t) return '<span class="tag">unsorted</span>';
    return '<span class="badge" data-t="' + esc(t) + '"><span class="dot"></span>' + esc(t) + "</span>";
  }
  function digits(s) { return String(s || "").replace(/[^\d+]/g, ""); }

  function rowHTML(c) {
    var mo = monthsSince(c.locationConfirmed);
    var stale = c.location && mo !== null && mo >= 6;
    var never = c.location && !c.locationConfirmed;
    var sub = [];
    if (c.location) {
      sub.push('<span>◍ ' + esc(c.location) +
        (stale ? ' <span class="stale">· ' + mo + 'mo old</span>' : (never ? ' <span class="stale">· unconfirmed</span>' : "")) + "</span>");
    }
    if (c.notes) sub.push('<span style="opacity:.8">' + esc(c.notes.slice(0, 64)) + (c.notes.length > 64 ? "…" : "") + "</span>");

    return '<div class="row' + (openId === c.id ? " open" : "") + '" data-id="' + c.id + '">' +
      '<button class="row-head" data-act="toggle" data-id="' + c.id + '" aria-expanded="' + (openId === c.id) + '">' +
        '<span style="flex:1;min-width:0">' +
          '<span class="row-meta">' +
            '<span class="row-name">' + (esc(c.name) || "Unnamed") + "</span>" +
            tierBadge(c.tier) +
            (c.company ? '<span class="tag co">' + esc(c.company) + "</span>" : "") +
            (c.school ? '<span class="tag sc">' + esc(c.school) + "</span>" : "") +
            (c.purpose ? '<span class="tag">' + esc(c.purpose) + "</span>" : "") +
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
          '<div><label class="f">City</label><input type="text" value="' + esc(c.location) + '" data-act="setloc" data-id="' + c.id + '" placeholder="e.g. Boston"></div>' +
          '<div style="display:flex;align-items:flex-end"><button class="btn-ghost" style="width:100%" data-act="confirmloc" data-id="' + c.id + '">' +
            (c.locationConfirmed ? "City confirmed " + esc(c.locationConfirmed) : "Mark city confirmed today") +
          "</button></div>" +
        "</div>" +
        '<div class="field"><label class="f">Notes</label><textarea rows="2" data-act="setnotes" data-id="' + c.id + '" placeholder="Where you met, what you talked about…">' + esc(c.notes) + "</textarea></div>" +
        ((c.phone || c.email) ? '<div class="field" style="display:flex;gap:14px;flex-wrap:wrap">' +
          (c.phone ? '<a class="contactlink" href="tel:' + esc(digits(c.phone)) + '">Call ' + esc(c.phone) + "</a>" : "") +
          (c.email ? '<a class="contactlink" href="mailto:' + esc(c.email) + '">Email</a>' : "") +
        "</div>" : "") +
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

  function viewTiering() {
    var pending = state.contacts.filter(function (c) { return c.pending; });
    var base, heading;

    if (browseBy === "tier") {
      base = tierFilter === "Unsorted"
        ? pending
        : state.contacts.filter(function (c) { return c.tier === tierFilter && !c.pending; });
      heading = tierFilter;
    } else {
      var field = browseBy === "school" ? "school" : "company";
      base = groupFilter
        ? state.contacts.filter(function (c) { return (c[field] || "") === groupFilter; })
        : [];
      heading = groupFilter || "";
    }

    var list = searchContacts(base, tierQuery);

    var filtersHTML;
    if (browseBy === "tier") {
      filtersHTML = TIERS.map(function (t) {
        var n = state.contacts.filter(function (c) { return c.tier === t && !c.pending; }).length;
        return '<button class="filter' + (tierFilter === t ? " on" : "") + '" data-act="filter" data-val="' + t + '">' + t + '<span class="n">' + n + "</span></button>";
      }).join("") + (pending.length
        ? '<button class="filter' + (tierFilter === "Unsorted" ? " on" : "") + '" data-act="filter" data-val="Unsorted">Unsorted<span class="n">' + pending.length + "</span></button>"
        : "");
    } else {
      var vals = groupValues(browseBy === "school" ? "school" : "company");
      filtersHTML = vals.length
        ? vals.map(function (v) {
            return '<button class="filter' + (groupFilter === v.key ? " on" : "") + '" data-act="group" data-val="' + esc(v.key) + '">' + esc(v.key) + '<span class="n">' + v.n + "</span></button>";
          }).join("")
        : '<span class="note">No ' + browseBy + ' tags yet — add them on any contact.</span>';
    }

    return '<div class="eyebrow">Everyone, sorted</div><h2>Tiering</h2>' +
      '<p class="sub">Browse by tier, school, or company. Search covers names, notes, cities, and tags — misspellings are fine.</p>' +
      (pending.length ? '<div class="card warn rowsplit"><p class="note" style="margin:0">' + pending.length + ' imported contacts are waiting to be sorted.</p><button class="btn-ghost" data-act="gotoadd">Sort them →</button></div>' : "") +
      '<div class="seg" role="group" aria-label="Browse by">' +
        ['tier', 'school', 'company'].map(function (b) {
          return '<button class="' + (browseBy === b ? "on" : "") + '" data-act="browseby" data-val="' + b + '">By ' + b + "</button>";
        }).join("") +
      "</div>" +
      '<div class="filters">' + filtersHTML + "</div>" +
      '<div class="searchwrap"><input type="search" id="tierSearch" value="' + esc(tierQuery) + '" placeholder="Search name, company, school, notes…" autocomplete="off" enterkeyhint="search">' +
        (tierQuery ? '<button class="clearx" data-act="clearsearch" aria-label="Clear search">×</button>' : "") +
      "</div>" +
      (tierQuery ? '<p class="hint" style="margin:-4px 0 12px">' + list.length + " match" + (list.length === 1 ? "" : "es") + (heading ? " in " + esc(heading) : "") + "</p>" : "") +
      '<div class="rowlist">' +
        (list.length ? list.map(rowHTML).join("")
          : '<div class="empty">' + (browseBy !== "tier" && !groupFilter
              ? "Pick a " + browseBy + " above to see who's there."
              : (tierQuery ? "Nothing here matches “" + esc(tierQuery) + "”." : "No one in " + esc(heading) + " yet.")) + "</div>") +
      "</div>";
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

  function viewAdd() {
    var pending = state.contacts.filter(function (c) { return c.pending; });
    if (queueIndex >= pending.length) queueIndex = 0;
    var cur = pending[queueIndex];

    return '<div class="eyebrow">Tonight\'s log</div><h2>Add</h2>' +
      '<p class="sub">Who did you meet? A name and a tier is enough. Potential and notes take five more seconds and are worth it while it is fresh.</p>' +
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
          ? '<p class="ok">All caught up — nothing waiting.</p>'
          : '<span class="queue-pos">' + (queueIndex + 1) + " of " + pending.length + "</span>" +
            '<div class="queue-name">' + esc(cur.name) + "</div>" +
            (cur.notes ? '<p class="note">' + esc(cur.notes) + "</p>" : "") +
            '<div class="field"><label class="f">Tier</label><div class="chips">' +
              TIERS.map(function (t) { return '<button class="chip" data-t="' + t + '" data-act="queuetier" data-val="' + t + '">' + t + "</button>"; }).join("") +
            "</div></div>" +
            '<div class="field"><button class="btn-ghost" data-act="queueskip">Skip for now →</button></div>' +
            '<p class="hint">Tapping a tier saves and moves to the next person.</p>') +
      "</div>" +
      '<div class="card"><h3>Import and export</h3>' +
        '<p class="note">CSV columns read: name, tier, purpose, company, school, location, notes. Rows with a valid tier sort themselves; the rest join the queue above. LinkedIn’s Connections.csv works directly.</p>' +
        '<div class="field"><input type="file" id="fileIn" accept=".csv,.vcf"></div>' +
        '<p class="note" id="importStatus"></p>' +
        '<div class="field"><button class="btn-ghost" data-act="export">Export everything as CSV</button>' +
        '<p class="hint">Back this up monthly. Data lives in this browser only, so a cache wipe or a new device starts fresh.</p></div>' +
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

    var tabs = document.querySelectorAll(".tab");
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].dataset.tab === tab;
      tabs[i].classList.toggle("on", on);
      tabs[i].setAttribute("aria-selected", on ? "true" : "false");
    }

    var boot = document.getElementById("bootMsg");
    if (boot && boot.parentNode) boot.parentNode.removeChild(boot);

    document.getElementById("view").innerHTML =
      tab === "tiering" ? viewTiering() : tab === "travel" ? viewTravel() : viewAdd();

    var ts = document.getElementById("tierSearch");
    if (ts) ts.addEventListener("input", function (e) { tierQuery = e.target.value; renderListOnly(); });

    var vs = document.getElementById("travelSearch");
    if (vs) {
      vs.addEventListener("input", function (e) {
        travelQuery = e.target.value;
        render();
        requestAnimationFrame(function () {
          var el = document.getElementById("travelSearch");
          if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
        });
      });
    }
    var fi = document.getElementById("fileIn");
    if (fi) fi.addEventListener("change", handleFile);
  }

  function renderListOnly() {
    var pending = state.contacts.filter(function (c) { return c.pending; });
    var base;
    if (browseBy === "tier") {
      base = tierFilter === "Unsorted" ? pending
        : state.contacts.filter(function (c) { return c.tier === tierFilter && !c.pending; });
    } else {
      var field = browseBy === "school" ? "school" : "company";
      base = groupFilter ? state.contacts.filter(function (c) { return (c[field] || "") === groupFilter; }) : [];
    }
    var list = searchContacts(base, tierQuery);
    var holder = document.querySelector(".rowlist");
    if (holder) {
      holder.innerHTML = list.length ? list.map(rowHTML).join("")
        : '<div class="empty">' + (tierQuery ? "Nothing here matches “" + esc(tierQuery) + "”." : "Nothing here yet.") + "</div>";
    }
  }

  var toastTimer;
  function toast(msg) {
    var t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2000);
  }

  /* ============================================================
     Events
     ============================================================ */
  document.addEventListener("click", function (e) {
    var tabBtn = e.target.closest(".tab");
    if (tabBtn) { tab = tabBtn.dataset.tab; openId = null; render(); return; }

    var el = e.target.closest("[data-act]");
    if (!el) return;
    var act = el.dataset.act, id = el.dataset.id, val = el.dataset.val;
    var c = id ? state.contacts.filter(function (x) { return x.id === id; })[0] : null;

    switch (act) {
      case "toggle": openId = openId === id ? null : id; render(); break;
      case "browseby": browseBy = val; groupFilter = ""; tierQuery = ""; openId = null; render(); break;
      case "filter": tierFilter = val; tierQuery = ""; openId = null; render(); break;
      case "group": groupFilter = groupFilter === val ? "" : val; tierQuery = ""; openId = null; render(); break;
      case "clearsearch": tierQuery = ""; render(); break;
      case "gotoadd": tab = "add"; render(); break;
      case "setcity": travelQuery = val; render(); break;
      case "settier": c.tier = val; c.pending = false; commit(); break;
      case "setpurpose": c.purpose = c.purpose === val ? "" : val; commit(); break;
      case "setpot": c.potential = c.potential === val ? "" : val; commit(); break;
      case "confirmloc": c.locationConfirmed = today(); commit(); toast("City confirmed"); break;
      case "qtier": qDraft.tier = val; syncChips("#qTier", val); break;
      case "qpurpose": qDraft.purpose = qDraft.purpose === val ? "" : val; syncChips("#qPurpose", qDraft.purpose); break;
      case "qpot": qDraft.potential = qDraft.potential === val ? "" : val; syncChips("#qPot", qDraft.potential); break;
      case "quickadd": quickAdd(); break;
      case "queuetier": {
        var p = state.contacts.filter(function (x) { return x.pending; });
        if (p[queueIndex]) { p[queueIndex].tier = val; p[queueIndex].pending = false; commit(); }
        break;
      }
      case "queueskip": {
        var q = state.contacts.filter(function (x) { return x.pending; });
        queueIndex = (queueIndex + 1) % Math.max(q.length, 1);
        render();
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
    var c = state.contacts.filter(function (x) { return x.id === el.dataset.id; })[0];
    if (!c) return;
    var map = { setloc: "location", setnotes: "notes", setco: "company", setsc: "school" };
    var field = map[el.dataset.act];
    if (field) { c[field] = el.value; save(); }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && e.target.id === "qName") { e.preventDefault(); quickAdd(); }
  });

  function val(id) {
    var el = document.getElementById(id);
    return el && el.value ? el.value.trim() : "";
  }

  function quickAdd() {
    var name = val("qName");
    if (!name) { toast("Add a name first"); return; }
    var loc = val("qLoc");
    state.contacts.unshift({
      id: uid(), name: name, tier: qDraft.tier, purpose: qDraft.purpose, potential: qDraft.potential,
      company: val("qCo"), school: val("qSc"), location: loc,
      locationConfirmed: loc ? today() : "", notes: val("qNotes"),
      phone: "", email: "", pending: false, added: today()
    });
    qDraft = { tier: "Middle", purpose: "", potential: "" };
    save(); render(); toast("Saved " + name);
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
    // LinkedIn exports prepend notes lines before the real header
    var headerIdx = 0;
    for (var i = 0; i < Math.min(lines.length, 8); i++) {
      if (/first name|full name|^name,/i.test(lines[i])) { headerIdx = i; break; }
    }
    var headers = splitCSVLine(lines[headerIdx]).map(function (h) { return h.toLowerCase(); });
    return lines.slice(headerIdx + 1).map(function (line) {
      var cells = splitCSVLine(line), row = {};
      headers.forEach(function (h, i) { row[h] = cells[i] || ""; });
      var name = row.name || row["full name"] ||
        [row["first name"], row["last name"]].filter(Boolean).join(" ");
      var hasTier = TIERS.indexOf(row.tier) !== -1;
      return {
        id: uid(), name: name,
        tier: hasTier ? row.tier : "",
        purpose: PURPOSES.indexOf(row.purpose) !== -1 ? row.purpose : "",
        potential: "",
        company: row.company || row.organization || "",
        school: row.school || "",
        location: row.location || row.city || "",
        locationConfirmed: "",
        notes: row.notes || row.position || "",
        phone: row.phone || "", email: row["email address"] || row.email || "",
        pending: !hasTier, added: ""
      };
    }).filter(function (c) { return c.name; });
  }

  function parseVCF(text) {
    return text.split("BEGIN:VCARD").slice(1).map(function (card) {
      var fn = (card.match(/FN:(.*)/) || ["", ""])[1].trim();
      var org = (card.match(/ORG:(.*)/) || ["", ""])[1].replace(/;/g, "").trim();
      var tel = (card.match(/TEL[^:\r\n]*:([^\r\n]*)/) || ["", ""])[1].trim();
      var em = (card.match(/EMAIL[^:\r\n]*:([^\r\n]*)/) || ["", ""])[1].trim();
      return {
        id: uid(), name: fn, tier: "", purpose: "", potential: "",
        company: org, school: "", location: "", locationConfirmed: "",
        notes: "", phone: tel, email: em, pending: true, added: ""
      };
    }).filter(function (c) { return c.name; });
  }

  function handleFile(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var r = new FileReader();
    r.onload = function () {
      var text = String(r.result), parsed = [];
      try {
        parsed = /\.vcf$/i.test(file.name) ? parseVCF(text) : parseCSV(text);
      } catch (err) { parsed = []; }
      var status = document.getElementById("importStatus");
      if (parsed.length) {
        state.contacts = state.contacts.concat(parsed);
        save(); render();
        var needSort = parsed.filter(function (p) { return p.pending; }).length;
        var s2 = document.getElementById("importStatus");
        if (s2) s2.textContent = "Imported " + parsed.length + " — " + needSort + " need sorting.";
        toast("Imported " + parsed.length);
      } else if (status) {
        status.textContent = "Couldn’t read that file. Check that it’s a .csv or .vcf.";
      }
    };
    r.readAsText(file);
  }

  function exportCSV() {
    var head = ["name", "tier", "purpose", "potential", "company", "school", "location", "locationConfirmed", "notes", "phone", "email", "added"];
    var q = function (s) { return '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"'; };
    var csv = [head.join(",")].concat(state.contacts.map(function (c) {
      return head.map(function (h) { return q(c[h]); }).join(",");
    })).join("\n");
    var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "field-notes-" + today() + ".csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    toast("Exported");
  }

  /* ============================================================
     Install prompt (Android / desktop Chrome)
     ============================================================ */
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredPrompt = e;
    var b = document.getElementById("installBtn");
    b.hidden = false;
    b.addEventListener("click", function () {
      b.hidden = true;
      deferredPrompt.prompt();
      deferredPrompt = null;
    });
  });

  /* ============================================================
     Boot
     ============================================================ */
  state = load();
  save();
  render();
  window.__FIELD_NOTES_READY = true;
})();
