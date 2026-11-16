/* Field Notes test suite. Open tests/run.html on a local server.
   Every test boots the real app with fake people (see fake.js). */
(function () {
  "use strict";
  var T = FNT, test = T.test, assert = T.assert, eq = T.eq, boot = T.boot, ev = T.ev, wait = T.wait;

  function tiersById(contacts) {
    var m = {};
    contacts.forEach(function (c) { m[c.id] = c.tier; });
    return m;
  }
  function csvFile(win, textContent, name) {
    var dt = new win.DataTransfer();
    dt.items.add(new win.File([textContent], name || "t.csv", { type: "text/plain" }));
    return dt.files;
  }
  async function importFile(textContent, name) {
    T.click('[data-act="opensettings"]');
    var fi = T.$("#fileIn");
    fi.files = csvFile(T.app(), textContent, name);
    fi.dispatchEvent(new (T.app().Event)("change"));
    await wait(120);
  }

  /* ================= safety net ================= */

  test("test mode uses its own storage key", async function () {
    await boot(null);
    eq(ev("KEY"), "field-notes-TEST");
    assert(ev("TEST") === true);
  });

  test("first run: a new user is pointed at Add, and one tap gets them typing", async function () {
    await boot(null);
    assert(/Start with one person/.test(T.text()));
    T.click('[data-act="gotoadd"]');
    eq(T.app().document.activeElement.id, "qLine");
    T.type("#qLine", "First Person"); T.key("#qLine", "Enter");
    T.click('.tab[data-tab="tiering"]');
    assert(!/Start with one person/.test(T.text()), "welcome card should go once someone exists");
    T.click('[data-act="filter"][data-val="Acquaintance"]');
    eq(T.$$(".row").length, 1);
  });

  test("accessibility: every field has a name; controls are at least 40px tall", async function () {
    var s = FNFake.makeState(40, 7);
    s.contacts[0].tier = "Close"; s.contacts[0].phone = "215-555-0100"; s.contacts[0].email = "a@example.com";
    await boot(s, { ver: "x" });
    var bad = [];
    function scan(label) {
      T.$$("#view input, #view textarea").forEach(function (e) {
        if (e.type !== "file" && !e.getAttribute("aria-label")) bad.push(label + ": unnamed " + (e.id || e.dataset.act));
      });
      T.$$("#view button, #view a, #view input, #view textarea, #view summary").forEach(function (e) {
        var r = e.getBoundingClientRect();
        if (r.height && r.height < 39.5 && e.type !== "file") bad.push(label + ": " + Math.round(r.height) + "px " + (e.className || e.tagName) + " " + (e.dataset.act || e.id || ""));
      });
    }
    scan("tiering"); T.click(".row-head"); scan("open row");
    ["log", "reconnect", "add"].forEach(function (t) { T.click('.tab[data-tab="' + t + '"]'); scan(t); });
    T.$("#qMore").open = true; scan("add details");
    T.click('[data-act="opensettings"]'); scan("settings");
    T.click('[data-act="opentrends"]'); scan("trends");
    eq(bad.filter(function (x, i, a) { return a.indexOf(x) === i; }), []);
  });

  test("first run: empty state renders with no errors", async function () {
    await boot(null);
    eq(ev("state.contacts.length"), 0);
    assert(/0 contacts/.test(T.text()), "count line missing");
    ["tiering", "log", "reconnect", "add"].forEach(function (t) { T.click('.tab[data-tab="' + t + '"]'); });
    T.click('[data-act="opensettings"]');
  });

  test("1,000 people: every tab renders with no errors", async function () {
    await boot(FNFake.makeState(1000, 7), { ver: ev("APP_VERSION") });
    eq(ev("state.contacts.length"), 1000);
    ["tiering", "log", "reconnect", "add"].forEach(function (t) { T.click('.tab[data-tab="' + t + '"]'); });
    T.click('[data-act="opensettings"]');
    T.click('.tab[data-tab="tiering"]');
    FNFake.TIERS.forEach(function (t) { T.click('[data-act="filter"][data-val="' + t + '"]'); });
  });

  test("full backup: export then restore changes nothing (1,000 people)", async function () {
    var s = FNFake.makeState(1000, 11);
    await boot(s, { ver: "x" });
    var before = ev("JSON.stringify(state)");
    var backup = ev("backupString()");
    ev("applyRestored(parseBackup(" + JSON.stringify(backup) + "))");
    eq(ev("JSON.stringify(state)"), before, "state changed after restore");
    eq(JSON.stringify(T.stored()), before, "stored copy changed after restore");
  });

  test("full backup: restore through the file picker, with a rollback copy", async function () {
    await boot(FNFake.makeState(40, 3), { ver: "x" });
    var backup = ev("backupString()");
    var before = ev("JSON.stringify(state.contacts)");
    ev("state.contacts.splice(0, 30); commit()");
    eq(ev("state.contacts.length"), 10);
    await importFile(backup, "field-notes-backup.json");
    eq(ev("JSON.stringify(state.contacts)"), before, "restore did not bring everyone back");
    var prev = JSON.parse(localStorage.getItem(T.KEY + ".prev"));
    eq(JSON.parse(prev.raw).contacts.length, 10, "rollback copy should hold the pre-restore data");
  });

  test("restore rejects a file that is not a backup", async function () {
    await boot(FNFake.makeState(5, 3), { ver: "x" });
    await importFile('{"hello": "world"}', "x.json");
    eq(ev("state.contacts.length"), 5);
    assert(/not a Field Notes backup/.test(T.text()));
  });

  test("CSV: export then import keeps every tier and all history", async function () {
    var s = FNFake.makeState(300, 5);
    await boot(s, { ver: "x" });
    var csv = ev("csvString()");
    var rows = ev("JSON.stringify(parseCSV(" + JSON.stringify(csv) + ").map(function (c) { return [c.name, c.tier, c.potential, c.interactions.join(';')]; }))");
    var want = JSON.stringify(s.contacts.map(function (c) { return [c.name, c.tier, c.potential, c.interactions.join(";")]; }));
    eq(rows, want);
  });

  test("CSV: re-importing your own export adds nobody and changes no tier", async function () {
    var s = FNFake.makeState(200, 9);
    await boot(s, { ver: "x" });
    var before = tiersById(ev("state.contacts"));
    await importFile(ev("csvString()"));
    assert(/200 already here/.test(T.text()), "preview should report 200 duplicates: " + T.text().slice(0, 300));
    assert(!T.$('[data-act="pvquick"]'), "nothing new, so no add button");
    T.click('[data-act="pvcancel"]');
    eq(tiersById(ev("state.contacts")), before);
  });

  test("375px: no screen scrolls sideways (1,000 people)", async function () {
    await boot(FNFake.makeState(1000, 7), { ver: ev("APP_VERSION") });
    var doc = T.app().document.documentElement, wide = [];
    function check(label) { if (doc.scrollWidth > doc.clientWidth + 1) wide.push(label + " " + doc.scrollWidth); }
    eq(doc.clientWidth <= 375, true, "frame should be phone width");
    ["tiering", "log", "reconnect", "add"].forEach(function (t) { T.click('.tab[data-tab="' + t + '"]'); check(t); });
    T.click('[data-act="opensettings"]'); check("settings");
    T.click('[data-act="opentrends"]'); check("trends");
    T.click('.tab[data-tab="tiering"]');
    T.click('[data-act="filter"][data-val="Middle"]');
    T.click(".row-head"); check("open row");
    T.click('[data-act="selmode"]'); T.click('[data-act="selpick"]'); check("select mode");
    eq(wide, []);
  });

  /* ================= updates and migration ================= */

  test("update from v9.3: 1,000 people intact, rollback copy kept, toast shown", async function () {
    var s = FNFake.makeState(1000, 21);
    var raw = JSON.stringify(s);
    await boot(raw);                               // no version marker = pre-9.4 install
    eq(ev("state.contacts.length"), 1000);
    eq(tiersById(ev("state.contacts")), tiersById(s.contacts), "a tier changed during update");
    eq(ev("state.contacts.map(function (c) { return c.id + c.potential + c.tierSince + c.interactions.join(); }).join('|')"),
       s.contacts.map(function (c) { return c.id + c.potential + c.tierSince + c.interactions.join(); }).join("|"));
    var prev = JSON.parse(localStorage.getItem(T.KEY + ".prev"));
    eq(prev.raw, raw, "rollback copy is not the untouched original");
    assert(new RegExp("Updated to v" + ev("APP_VERSION").replace(".", "\\.")).test(T.$("#toast").innerText), "no update toast");
    eq(localStorage.getItem(T.KEY + ".ver"), ev("APP_VERSION"));
  });

  test("same version reopening: no toast, rollback copy untouched", async function () {
    var s = FNFake.makeState(20, 2);
    await boot(s);
    var prev = localStorage.getItem(T.KEY + ".prev");
    await boot(null, { keep: true });
    eq(localStorage.getItem(T.KEY + ".prev"), prev);
    assert(!T.$("#toast").classList.contains("show"), "toast shown on a normal reopen");
  });

  test("rollback: 'Go back to that copy' restores the pre-update data, and can be undone", async function () {
    var s = FNFake.makeState(50, 4);
    await boot(JSON.stringify(s));
    var original = ev("JSON.stringify(state.contacts.map(function (c) { return c.id + c.tier; }))");
    ev("state.contacts.forEach(function (c) { c.tier = 'Networking'; }); state.contacts.pop(); commit()");
    T.click('[data-act="opensettings"]');
    T.click('[data-act="rollback"]');
    eq(ev("JSON.stringify(state.contacts.map(function (c) { return c.id + c.tier; }))"), original);
    T.click('[data-act="opensettings"]');
    T.click('[data-act="rollback"]');
    eq(ev("state.contacts.length"), 49, "second press should undo the rollback");
  });

  test("migration: very old shape (roles, prevContact, touches) keeps what was typed", async function () {
    var old = { contacts: [
      { name: "Old Shape One", tier: "Close", roles: ["Mentor"], roleOther: "Coach", purpose: "Advice",
        notes: "hello", prevContact: "2026-01-02", lastContact: "2026-03-04", touches: 2, added: "2025-12-01" },
      { name: "Old Shape Two", tier: "Middle" }
    ] };
    await boot(old);
    var c = ev("state.contacts[0]");
    eq(c.tier, "Close");
    eq(c.interactions, ["2026-01-02", "2026-03-04"]);
    assert(/hello/.test(c.notes) && /Mentor/.test(c.notes) && /Coach/.test(c.notes) && /Advice/.test(c.notes), "notes lost carried text: " + c.notes);
    assert(c.id && ev("state.contacts[1].id"), "ids not assigned");
  });

  test("version is shown at the bottom of the Add tab", async function () {
    await boot(FNFake.makeState(3, 1), { ver: "x" });
    T.click('.tab[data-tab="add"]');
    assert(T.text().indexOf("Field Notes v" + ev("APP_VERSION")) !== -1);
  });

  /* ================= capture (v9.5) ================= */

  test("parseCapture: splits a name from where you met", async function () {
    await boot(null);
    var cases = [
      ["Sam Lee at Geography Club", "Sam Lee", "Met at Geography Club"],
      ["met Sam Lee at the GBM, loves maps", "Sam Lee", "Met at the GBM, loves maps"],
      ["Sam Lee", "Sam Lee", ""],
      ["sam lee", "Sam Lee", ""],
      ["Kat in MATH 1400", "Kat", "Met in MATH 1400"],
      ["Jo from my hall", "Jo", "Met from my hall"],
      ["Priya @ Class Board", "Priya", "Met at Class Board"],
      ["Dana, roommate's friend", "Dana", "roommate's friend"],
      ["Lee - NSO group", "Lee", "NSO group"],
      ["Avery Stone #geoclub", "Avery Stone", "#geoclub"],
      ["Mary-Kate O'Neil at Hillel", "Mary-Kate O'Neil", "Met at Hillel"],
      ["  ", "", ""],
      ["Sam at", "Sam at", ""]
    ];
    cases.forEach(function (c) {
      var p = ev("parseCapture(" + JSON.stringify(c[0]) + ")");
      eq([p.name, p.context], [c[1], c[2]], "parse of '" + c[0] + "'");
    });
  });

  test("capture: one line and Enter is a complete entry; box stays ready for the next person", async function () {
    await boot(FNFake.makeState(50, 8), { ver: "x" });
    T.click('.tab[data-tab="add"]');
    eq(T.app().document.activeElement.id, "qLine", "name box should be focused when Add opens");
    T.type("#qLine", "Sam Lee at Geography Club");
    T.key("#qLine", "Enter");
    var c = ev("state.contacts[0]");
    eq([c.name, c.notes, c.tier, c.pending, c.added, c.tierSince], ["Sam Lee", "Met at Geography Club", "Acquaintance", false, ev("today()"), ev("today()")]);
    eq(ev("state.contacts.length"), 51);
    eq(T.$("#qLine").value, "");
    eq(T.app().document.activeElement.id, "qLine", "focus should return to the box");
    // second person straight away, name only
    T.type("#qLine", "jo park");
    T.key("#qLine", "Enter");
    eq(ev("state.contacts[0].name"), "Jo Park");
    eq(ev("state.contacts.length"), 52);
  });

  test("capture: the follow-up card sets tier and potential in one tap each, and can remove", async function () {
    await boot(FNFake.makeState(5, 8), { ver: "x" });
    T.click('.tab[data-tab="add"]');
    T.type("#qLine", "Robin Vale, hall");
    T.click('[data-act="quickadd"]');
    assert(T.$(".justadded"), "no follow-up card");
    T.click('.justadded [data-act="settier"][data-val="Middle"]');
    T.click('.justadded [data-act="setpot"][data-val="Strong"]');
    var c = ev("state.contacts[0]");
    eq([c.tier, c.potential, c.notes], ["Middle", "Strong", "hall"]);
    T.click('.justadded [data-act="delete"]');
    eq(ev("state.contacts.length"), 5);
    T.click('[data-act="undodelete"]');
    eq(ev("state.contacts.length"), 6);
  });

  test("capture: a name already in the app is flagged once, then 'Add anyway' works", async function () {
    var s = FNFake.makeState(3, 8); s.contacts[0].name = "Sam Lee"; s.contacts[0].tier = "Close";
    await boot(s, { ver: "x" });
    T.click('.tab[data-tab="add"]');
    T.type("#qLine", "sam lee at the gym");
    T.key("#qLine", "Enter");
    eq(ev("state.contacts.length"), 3, "duplicate was added without asking");
    assert(/already here \(Close\)/.test(T.$("#toast").innerText), "no duplicate notice");
    T.click('#toast [data-act="addanyway"]');
    eq(ev("state.contacts.length"), 4);
    eq(ev("state.contacts[0].notes"), "Met at the gym");
  });

  test("capture: optional details are used when filled in", async function () {
    await boot(FNFake.makeState(2, 8), { ver: "x" });
    T.click('.tab[data-tab="add"]');
    T.$("#qMore").open = true;
    T.click('#qTier [data-val="Close"]');
    T.click('#qPot [data-val="Rare"]');
    T.$("#qCo").value = "Acme"; T.$("#qSc").value = "Penn"; T.$("#qLoc").value = "Boston"; T.$("#qNotes").value = "plays squash";
    T.type("#qLine", "Dev Marsh at orientation");
    T.click('[data-act="quickadd"]');
    var c = ev("state.contacts[0]");
    eq([c.name, c.tier, c.potential, c.company, c.school, c.location, c.notes],
       ["Dev Marsh", "Close", "Rare", "Acme", "Penn", "Boston", "Met at orientation. plays squash"]);
  });

  test("capture: the reminder card never covers the Add tab", async function () {
    var s = FNFake.makeState(0, 1);
    s.contacts.push(Object.assign(FNFake.makeContacts(1, 5)[0], { tier: "Close", potential: "Rare", interactions: [], lastContact: "", tierSince: "2026-01-01" }));
    await boot(s, { ver: "x" });
    assert(!T.$("#nudge").hidden, "expected a reminder card on open");
    T.click('.tab[data-tab="add"]');
    assert(T.$("#nudge").hidden, "reminder card is covering the Add tab");
    T.click('.tab[data-tab="tiering"]');
    assert(!T.$("#nudge").hidden, "reminder card should come back");
  });

  test("capture: an empty line adds nobody", async function () {
    await boot(FNFake.makeState(2, 8), { ver: "x" });
    T.click('.tab[data-tab="add"]');
    T.click('[data-act="quickadd"]');
    eq(ev("state.contacts.length"), 2);
  });

  test("links: ?tab=add opens Add focused; ?add= fills the line; the address is cleaned", async function () {
    await boot(FNFake.makeState(5, 8), { ver: "x", query: "&tab=add" });
    eq(ev("tab"), "add");
    eq(T.app().document.activeElement.id, "qLine");
    assert(!/tab=/.test(T.app().location.search), "tab left in the address");
    assert(/fntest=1/.test(T.app().location.search), "test flag was dropped");
    await boot(FNFake.makeState(5, 8), { ver: "x", query: "&add=Sam%20Lee%20at%20GBM" });
    eq(T.$("#qLine").value, "Sam Lee at GBM");
    eq(ev("state.contacts.length"), 5, "a link must never save by itself");
    await boot(FNFake.makeState(5, 8), { ver: "x", query: "&tab=log" });
    eq(ev("tab"), "log");
    var m = await (await fetch("../manifest.json?t=" + Date.now(), { cache: "no-store" })).json();
    eq(m.shortcuts.map(function (x) { return x.url; }), ["./?tab=add", "./?tab=log"]);
  });

  /* ================= speed (v9.5) ================= */

  test("rows: only the open row carries its form; editing still saves", async function () {
    await boot(FNFake.makeState(200, 7), { ver: "x" });
    T.click('[data-act="filter"][data-val="Acquaintance"]');
    eq(T.$$(".row-body").length, 0, "collapsed rows should have no form");
    var first = T.$(".row-head");
    var id = first.dataset.id;
    T.click(first);
    eq(T.$$(".row-body").length, 1);
    T.type('.row-body [data-act="setname"]', "Renamed Person");
    T.type('.row-body [data-act="setnotes"]', "new note #hall");
    T.click('.row-body [data-act="setpot"][data-val="Strong"]');
    var c = ev("byId('" + id + "')");
    eq([c.name, c.notes, c.potential], ["Renamed Person", "new note #hall", "Strong"]);
    eq(T.stored().contacts.filter(function (x) { return x.id === id; })[0].name, "Renamed Person");
  });

  test("long lists draw 150 rows, then more on request; search still covers everyone", async function () {
    var s = FNFake.makeState(1000, 7);
    s.contacts[990].name = "Zed Lastperson"; s.contacts[990].tier = "Acquaintance"; s.contacts[990].potential = "";
    await boot(s, { ver: "x" });
    T.click('[data-act="filter"][data-val="Acquaintance"]');
    eq(T.$$(".row").length, 150);
    T.click('[data-act="showmore"]');
    eq(T.$$(".row").length, 300);
    T.type("#tierSearch", "Lastperson");
    await wait(200);
    eq(T.$$(".row").length, 1, "search should find someone beyond the drawn rows");
  });

  test("log: people you talk to most are one tap, no typing", async function () {
    var s = FNFake.makeState(300, 7);
    await boot(s, { ver: "x" });
    T.click('.tab[data-tab="log"]');
    var rows = T.$$('.logrow [data-act="marktouch"]');
    assert(rows.length > 0 && rows.length <= 8, "expected 1-8 suggestions, got " + rows.length);
    var id = rows[0].dataset.id;
    T.click(rows[0]);
    eq(ev("byId('" + id + "').lastContact"), ev("today()"));
    assert(T.$$('.logrow.donetoday').length === 1, "should now appear under Logged today");
  });

  /* ================= reconnect (v9.6) ================= */

  function person(over) {
    return Object.assign(FNFake.makeContacts(1, Math.floor(Math.random() * 1e6))[0],
      { potential: "Rare", interactions: [], lastContact: "", tierSince: "2025-01-01", notes: "", location: "", added: "" }, over);
  }

  test("reminders are for Close and Middle only: Acquaintance and Networking never reach the card or the count", async function () {
    var s = FNFake.makeState(0, 1);
    s.contacts.push(person({ id: "acq", name: "Acq Rare", tier: "Acquaintance" }));
    s.contacts.push(person({ id: "net", name: "Net Rare", tier: "Networking" }));
    await boot(s, { ver: "x" });
    eq(ev("nudgeCandidate()"), null, "an Acquaintance or Networking contact produced a reminder");
    assert(T.$("#nudge").hidden, "card shown");
    assert(T.$("#coldPill").hidden, "Reach count shown");
    T.click('.tab[data-tab="reconnect"]');
    assert(/All current|further out/.test(T.text()), "Reach tab should say nobody is due");
    eq(T.$$("details.more .logrow").length, 2, "they should only be in the folded 'further out' list");
    eq(T.$("details.more").open, false);
    // now a Middle person: exactly one card, for them
    ev("state.contacts.push(blankContact({ id: 'mid', name: 'Mid Strong', tier: 'Middle', potential: 'Strong', tierSince: '2025-01-01' })); nudgeFor = (nudgeCandidate() || {}).id; commit()");
    eq(ev("nudgeCandidate().id"), "mid");
    eq(T.$("#coldPill").textContent, "1");
  });

  test("one card at a time; Later snoozes and does not queue the next person", async function () {
    var s = FNFake.makeState(0, 1);
    for (var i = 0; i < 5; i++) s.contacts.push(person({ id: "c" + i, name: "Close " + i, tier: "Close" }));
    await boot(s, { ver: "x" });
    eq(T.$$("#nudge strong").length, 1);
    T.click('[data-act="nudgesnooze"]');
    assert(T.$("#nudge").hidden, "another card appeared mid-session");
    eq(ev("state.contacts.filter(function (c) { return c.snoozedUntil; }).length"), 1);
  });

  test("why now: each reason is a plain fact", async function () {
    await boot(null);
    var iso = FNFake.iso;
    var a = ev("whyNow(" + JSON.stringify(person({ tier: "Close", interactions: [iso(40)], lastContact: iso(40) })) + ")");
    eq(a, "Last talked 40 days ago");
    var b = ev("whyNow(" + JSON.stringify(person({ tier: "Close", interactions: [iso(70), iso(60), iso(50), iso(40)], lastContact: iso(40) })) + ")");
    eq(b, "Last talked 40 days ago \u00b7 you usually talk every 10 days");
    var c = ev("whyNow(" + JSON.stringify(person({ tier: "Middle", tierSince: "2026-09-03" })) + ")");
    assert(/^In Middle since Sep 3, nothing logged yet$/.test(c), c);
  });

  test("the card and Reach rows show the reason and context", async function () {
    var s = FNFake.makeState(0, 1);
    s.contacts.push(person({ id: "p1", name: "Pat Reason", tier: "Close", interactions: [FNFake.iso(50)], lastContact: FNFake.iso(50), notes: "Met at Geography Club" }));
    await boot(s, { ver: "x" });
    assert(/Last talked 50 days ago/.test(T.$("#nudge").innerText), T.$("#nudge").innerText);
    assert(/Met at Geography Club/.test(T.$("#nudge").innerText));
    T.click('.tab[data-tab="reconnect"]');
    assert(/Last talked 50 days ago/.test(T.$(".logrow.reach").innerText));
    T.click('.logrow.reach [data-act="marktouch"]');
    eq(T.$$(".logrow.reach").length, 0, "logging should clear them");
  });

  test("promises: a follow-up shows on Reach until Done, with undo, for any tier", async function () {
    var s = FNFake.makeState(0, 1);
    s.contacts.push(person({ id: "p1", name: "Promise Person", tier: "Acquaintance", potential: "" }));
    await boot(s, { ver: "x" });
    T.click('[data-act="filter"][data-val="Acquaintance"]');
    T.click(".row-head");
    T.type('[data-act="setfollow"]', "send the article");
    eq(ev("byId('p1').followUp"), "send the article");
    assert(T.$("#nudge").hidden, "a promise must not create a reminder card");
    T.click('.tab[data-tab="reconnect"]');
    assert(/you said you would/i.test(T.text()) && /send the article/.test(T.text()), "promise not listed");
    T.click('[data-act="followdone"]');
    eq(ev("byId('p1').followUp"), "");
    T.click('[data-act="undofollow"]');
    eq(ev("byId('p1').followUp"), "send the article");
  });

  test("Penn calendar: windows for 2026-27 match the published dates", async function () {
    await boot(null);
    function at(d) { var s = ev("seasonNow('" + d + "')"); return s ? s.key + ":" + s.startsIn : null; }
    eq(at("2026-11-16"), null, "ten days out is too early");
    eq(at("2026-11-21"), "thanksgiving:4");
    eq(at("2026-11-26"), "thanksgiving:0");
    eq(at("2026-11-30"), null);
    eq(at("2026-12-25"), "winter:0");
    eq(at("2027-01-10"), "winter:0");
    eq(at("2027-01-19"), "winter:0");
    eq(at("2027-01-20"), "term-spring:0");
    eq(at("2027-03-06"), "spring:0");
    eq(at("2027-03-14"), "spring:0");
    eq(at("2027-03-16"), null);
    eq(at("2027-07-04"), "summer:0");
    eq(at("2027-08-26"), "term-fall:0");
    eq(at("2027-10-10"), null);
  });

  test("break prompt: lists rated Close/Middle people outside Philadelphia, at most 5, and hides when empty", async function () {
    var s = FNFake.makeState(0, 1);
    for (var i = 0; i < 7; i++) s.contacts.push(person({ id: "h" + i, name: "Home " + i, tier: "Middle", location: "Chicago", tierSince: FNFake.iso(1) }));
    s.contacts.push(person({ id: "ph", name: "Philly Person", tier: "Close", location: "Philadelphia", tierSince: FNFake.iso(1) }));
    s.contacts.push(person({ id: "aq", name: "Acq Away", tier: "Acquaintance", location: "Boston" }));
    s.contacts.push(person({ id: "rc", name: "Recent Away", tier: "Close", location: "Austin", interactions: [FNFake.iso(2)], lastContact: FNFake.iso(2) }));
    await boot(s, { ver: "x" });
    var names = ev("seasonPeople({ kind: 'break' }).map(function (c) { return c.name; })");
    eq(names.length, 5);
    assert(names.every(function (n) { return /^Home/.test(n); }), names.join());
    eq(ev("(function () { state.contacts.forEach(function (c) { c.location = ''; }); return seasonPeople({ kind: 'break' }).length; })()"), 0);
  });

  /* ================= recall (v9.6) ================= */

  test("tags: #words in notes group people; Tag view lists them; bulk tag has undo", async function () {
    var s = FNFake.makeState(0, 1);
    for (var i = 0; i < 6; i++) s.contacts.push(person({ id: "t" + i, name: "Tag " + i, tier: "Acquaintance", potential: "", notes: i < 2 ? "likes maps #GeoClub" : "" }));
    await boot(s, { ver: "x" });
    eq(ev("tagValues()"), [{ key: "#geoclub", n: 2 }]);
    T.click('[data-act="browseby"][data-val="tag"]');
    T.click('[data-act="group"][data-val="#geoclub"]');
    eq(T.$$(".row").length, 2);
    // bulk tag three more
    T.click('[data-act="browseby"][data-val="tier"]');
    T.click('[data-act="filter"][data-val="Acquaintance"]');
    T.click('[data-act="selmode"]');
    ["t3", "t4", "t5"].forEach(function (id) { T.click('[data-act="selpick"][data-id="' + id + '"]'); });
    T.app().prompt = function () { return "  Hall Floor 3 "; };
    T.click('[data-act="seltag"]');
    eq(ev("tagValues()"), [{ key: "#hallfloor3", n: 3 }, { key: "#geoclub", n: 2 }]);
    eq(ev("byId('t3').notes"), "#hallfloor3");
    T.click('[data-act="undotag"]');
    eq(ev("tagValues()"), [{ key: "#geoclub", n: 2 }]);
    eq(ev("byId('t3').notes"), "");
  });

  test("capture with a #tag lands in that group", async function () {
    await boot(FNFake.makeState(0, 1), { ver: "x" });
    T.click('.tab[data-tab="add"]');
    T.type("#qLine", "Sam Lee at the GBM #geoclub");
    T.key("#qLine", "Enter");
    eq(ev("tagsOf(state.contacts[0])"), ["#geoclub"]);
    eq(ev("state.contacts[0].name"), "Sam Lee");
  });

  test("trends: circle, this month, rising and gone quiet render from history", async function () {
    var iso = FNFake.iso, s = FNFake.makeState(0, 1);
    s.contacts.push(person({ id: "r", name: "Rising One", tier: "Middle", interactions: [iso(20), iso(10), iso(1)], lastContact: iso(1) }));
    s.contacts.push(person({ id: "f", name: "Quiet One", tier: "Close", interactions: [iso(100), iso(80), iso(60)], lastContact: iso(60) }));
    s.contacts.push(person({ id: "n", name: "Never One", tier: "Acquaintance", potential: "" }));
    await boot(s, { ver: "x" });
    var m = ev("momentum()");
    eq([m.rising.map(function (x) { return x.c.id; }), m.fading.map(function (x) { return x.c.id; })], [["r"], ["f"]]);
    T.click('[data-act="opensettings"]');
    T.click('[data-act="opentrends"]');
    var t = T.text();
    assert(/your circle/i.test(t) && /rising/i.test(t) && /gone quiet/i.test(t) && /Rising One/.test(t) && /Quiet One/.test(t), t.slice(-400));
  });

  test("discreet: tapping the title hides tier names and ratings, and tapping again restores them", async function () {
    var s = FNFake.makeState(0, 1);
    s.contacts.push(person({ id: "d", name: "Discreet One", tier: "Close", tierSince: FNFake.iso(1) }));
    await boot(s, { ver: "x" });
    assert(/Close/.test(T.$(".filters").innerText));
    T.click(".brand");
    assert(!/Close|Middle|Acquaintance|Networking/.test(T.$(".filters").innerText), "tier names still visible: " + T.$(".filters").innerText);
    eq(T.app().getComputedStyle(T.$(".row .pot")).display, "none");
    eq(ev("state.settings.discreet"), true);
    T.click(".brand");
    assert(/Close/.test(T.$(".filters").innerText));
  });

  test("CSV carries the follow-up promise", async function () {
    var s = FNFake.makeState(0, 1);
    s.contacts.push(person({ id: "p", name: "Csv Promise", followUp: "lend the book, soon" }));
    await boot(s, { ver: "x" });
    eq(ev("parseCSV(csvString())[0].followUp"), "lend the book, soon");
  });

  /* ================= sync (v9.7) ================= */

  /* Runs the real api/sync.js handler in the page against an in-memory stand-in
     for Upstash. This checks the handler's logic; it is not a real round trip. */
  async function makeServer(env) {
    var code = await (await fetch("../api/sync.js?t=" + Date.now(), { cache: "no-store" })).text();
    var store = new Map(), ttl = {};
    function fakeFetch(url, opts) {
      var cmd = JSON.parse(opts.body), op = String(cmd[0]).toUpperCase(), result = null;
      if (op === "GET") result = store.has(cmd[1]) ? store.get(cmd[1]) : null;
      else if (op === "SET") { store.set(cmd[1], cmd[2]); result = "OK"; }
      else if (op === "DEL") result = store.delete(cmd[1]) ? 1 : 0;
      else if (op === "INCR") { var n = (Number(store.get(cmd[1])) || 0) + 1; store.set(cmd[1], String(n)); result = n; }
      else if (op === "EXPIRE") { ttl[cmd[1]] = Number(cmd[2]); result = 1; }
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ result: result }); } });
    }
    var module = { exports: null };
    new Function("module", "process", "fetch", code)(module, { env: env === undefined ? { KV_REST_API_URL: "https://fake.example", KV_REST_API_TOKEN: "t" } : env }, fakeFetch);
    function call(method, o) {
      o = o || {};
      return new Promise(function (resolve) {
        var out = { status: 200, headers: {} };
        var res = {
          setHeader: function (k, v) { out.headers[k] = v; },
          status: function (s) { out.status = s; return res; },
          json: function (b) { out.body = b; resolve(out); return res; }
        };
        module.exports({ method: method, query: o.query || {}, body: o.body, headers: { "x-forwarded-for": o.ip || "203.0.113.5" } }, res);
      });
    }
    return { call: call, store: store, ttl: ttl };
  }
  var ID_A = "11111111-1111-4111-8111-111111111111";
  function uuid(n) { return ("00000000" + n.toString(16)).slice(-8) + "-0000-4000-8000-000000000000"; }

  test("api: not configured returns 501; bad ids and empty blobs are refused", async function () {
    var off = await makeServer({});
    eq((await off.call("GET", { query: { id: ID_A } })).status, 501);
    var s = await makeServer();
    eq((await s.call("GET", { query: { id: "nope" } })).status, 400);
    eq((await s.call("PUT", { body: { id: ID_A, blob: "" } })).status, 400);
    eq((await s.call("GET", { query: { id: ID_A } })).status, 404);
    eq((await s.call("PATCH", {})).status, 405);
  });

  test("api: write, read back, and a stale write gets 409 with the current copy", async function () {
    var s = await makeServer();
    var w1 = await s.call("PUT", { body: JSON.stringify({ id: ID_A, blob: "cipher-1", baseRev: 0 }) });
    eq([w1.status, w1.body.rev], [200, 1]);
    var r = await s.call("GET", { query: { id: ID_A } });
    eq([r.status, r.body.blob, r.body.rev], [200, "cipher-1", 1]);
    var w2 = await s.call("PUT", { body: { id: ID_A, blob: "cipher-2", baseRev: 1 } });
    eq(w2.body.rev, 2);
    var stale = await s.call("PUT", { body: { id: ID_A, blob: "cipher-old", baseRev: 1 } });
    eq([stale.status, stale.body.blob], [409, "cipher-2"]);
    eq((await s.call("GET", { query: { id: ID_A } })).body.blob, "cipher-2", "a stale write must not overwrite");
  });

  test("api: size cap is 3 MB", async function () {
    var s = await makeServer();
    var big = new Array(3 * 1024 * 1024 + 2).join("x");
    eq((await s.call("PUT", { body: { id: ID_A, blob: big, baseRev: 0 } })).status, 413);
    eq(s.store.has("fn:" + ID_A), false);
    var ok = new Array(1024 * 1024).join("x");
    eq((await s.call("PUT", { body: { id: ID_A, blob: ok, baseRev: 0 } })).status, 200);
  });

  test("api: rate limits per address, per sync id, and on creating new ids", async function () {
    var s = await makeServer(), i, r;
    // per address: 90 requests per window
    for (i = 0; i < 90; i++) r = await s.call("GET", { query: { id: ID_A }, ip: "198.51.100.1" });
    eq(r.status, 404);
    r = await s.call("GET", { query: { id: ID_A }, ip: "198.51.100.1" });
    eq([r.status, r.headers["Retry-After"]], [429, "300"]);
    eq((await s.call("GET", { query: { id: ID_A }, ip: "198.51.100.2" })).status, 404, "another address is unaffected");
    // per id: 40 writes per window, spread over addresses so only the id limit applies
    var rev = 0;
    for (i = 0; i < 40; i++) { r = await s.call("PUT", { body: { id: ID_A, blob: "b" + i, baseRev: rev }, ip: "10.0.0." + i }); rev = r.body.rev; }
    eq(r.status, 200);
    eq((await s.call("PUT", { body: { id: ID_A, blob: "b", baseRev: rev }, ip: "10.0.1.1" })).status, 429);
    // new ids: 6 per address per day
    for (i = 0; i < 6; i++) r = await s.call("PUT", { body: { id: uuid(i + 1), blob: "n", baseRev: 0 }, ip: "192.0.2.9" });
    eq(r.status, 200);
    eq((await s.call("PUT", { body: { id: uuid(99), blob: "n", baseRev: 0 }, ip: "192.0.2.9" })).status, 429);
    eq(s.store.has("fn:" + uuid(99)), false);
    assert(![].concat(Array.from(s.store.keys())).some(function (k) { return /198\.51|192\.0\.2|10\.0\./.test(k); }), "raw addresses were stored");
    eq(s.ttl[Object.keys(s.ttl).filter(function (k) { return /rl:new/.test(k); })[0]], 86400);
  });

  test("merge: both devices edited the same person, so neither side's notes are dropped", async function () {
    await boot(null);
    var base = { id: "x", name: "Sam", tier: "Middle", notes: "base", interactions: ["2026-10-01"], tierLog: [], updatedAt: "2026-11-01T00:00:00Z" };
    var phone = Object.assign({}, base, { notes: "phone wrote this", interactions: ["2026-10-01", "2026-11-10"], updatedAt: "2026-11-10T10:00:00Z" });
    var laptop = Object.assign({}, base, { notes: "laptop wrote this", followUp: "send link", school: "Penn", updatedAt: "2026-11-09T10:00:00Z" });
    function m(l, r, last) {
      return ev("FNSync.merge(" + JSON.stringify({ contacts: [l], deleted: [], updatedAt: l.updatedAt }) + "," +
        JSON.stringify({ contacts: [r], deleted: [], updatedAt: r.updatedAt }) + "," + JSON.stringify(last) + ").contacts[0]");
    }
    var out = m(phone, laptop, "2026-11-05T00:00:00Z");
    eq(out.notes, "phone wrote this | other device: laptop wrote this");
    eq([out.followUp, out.school, out.interactions], ["send link", "Penn", ["2026-10-01", "2026-11-10"]]);
    // merging the result again adds nothing more
    eq(m(out, laptop, "2026-11-05T00:00:00Z").notes, out.notes);
    eq(m(laptop, out, "2026-11-05T00:00:00Z").notes, out.notes);
    // only one side changed since the last sync: plain newer-wins, no appended text
    eq(m(phone, base, "2026-11-05T00:00:00Z").notes, "phone wrote this");
    eq(m(base, phone, "2026-11-05T00:00:00Z").notes, "phone wrote this");
  });

  test("merge: a delete on one device is not undone by the other; a later edit beats an earlier delete", async function () {
    await boot(null);
    var c = { id: "x", name: "Sam", tier: "Close", notes: "", interactions: [], tierLog: [], updatedAt: "2026-11-01T00:00:00Z" };
    var now = new Date().toISOString();
    var gone = ev("FNSync.merge(" + JSON.stringify({ contacts: [], deleted: [{ id: "x", at: now }], updatedAt: now }) + "," +
      JSON.stringify({ contacts: [c], deleted: [], updatedAt: c.updatedAt }) + ", null).contacts.length");
    eq(gone, 0);
    var later = Object.assign({}, c, { updatedAt: new Date(Date.now() + 60000).toISOString() });
    var kept = ev("FNSync.merge(" + JSON.stringify({ contacts: [], deleted: [{ id: "x", at: now }], updatedAt: now }) + "," +
      JSON.stringify({ contacts: [later], deleted: [], updatedAt: later.updatedAt }) + ", null).contacts.length");
    eq(kept, 1);
  });

  function route(server, ip) {
    var win = T.app();
    win.fetch = function (url, opts) {
      opts = opts || {};
      var u = new URL(url, win.location.href), q = {};
      u.searchParams.forEach(function (v, k) { q[k] = v; });
      return server.call((opts.method || "GET").toUpperCase(), { query: q, body: opts.body, ip: ip }).then(function (r) {
        return { status: r.status, ok: r.status >= 200 && r.status < 300, json: function () { return Promise.resolve(r.body); } };
      });
    };
  }
  async function settle() {
    for (var i = 0; i < 200; i++) { if (!ev("syncBusy")) return; await wait(25); }
    throw new Error("sync never finished");
  }

  test("sync end to end: two devices, encrypted on the wire, edits and deletes travel both ways", async function () {
    var server = await makeServer();
    var s = FNFake.makeState(60, 31);
    // device A turns sync on
    await boot(s, { ver: "x" });
    route(server, "10.1.1.1");
    ev("FNSync.enable('correct horse battery')");
    var id = ev("FNSync.config().id");
    ev("doSync(false)"); await settle();
    var stored = JSON.parse(server.store.get("fn:" + id));
    var plain = atob(stored.blob);
    assert(stored.blob.length > 1000 && plain.indexOf(s.contacts[0].name) === -1 && plain.indexOf("215-555-01") === -1 &&
           plain.indexOf('"contacts"') === -1, "the server can read the data");
    assert(/synced just now/.test(T.$("#totalCount").textContent), "no last-synced status: " + T.$("#totalCount").textContent);
    var aStorage = localStorage.getItem(T.KEY), aCfg = localStorage.getItem("field-notes-sync");

    // device B joins with the code and passphrase
    await boot(null);
    route(server, "10.1.1.2");
    var remote = await ev("FNSync.adopt('" + id + "', 'correct horse battery')");
    ev("state = migrate(FNSync.merge(state, migrate(" + JSON.stringify(remote) + "), null)); save(); render()");
    eq(ev("state.contacts.length"), 60);
    eq(tiersById(ev("state.contacts")), tiersById(s.contacts));
    // B edits one person, deletes another, adds one
    var edited = s.contacts[3].id, deleted = s.contacts[4].id;
    ev("(function () { var c = byId('" + edited + "'); c.notes = 'edited on B'; c.tier = 'Close'; touch(c); deleteContact(byId('" + deleted + "')); " +
       "state.contacts.unshift(blankContact({ id: 'newB', name: 'Added On B', added: today() })); commit(); })()");
    ev("doSync(false)"); await settle();

    // back on device A
    localStorage.setItem(T.KEY, aStorage); localStorage.setItem("field-notes-sync", aCfg);
    await boot(null, { keep: true });
    route(server, "10.1.1.1");
    ev("doSync(false)"); await settle();
    eq(ev("state.contacts.length"), 60);
    eq([ev("byId('" + edited + "').notes"), ev("byId('" + edited + "').tier"), ev("byId('" + deleted + "')"), ev("byId('newB').name")],
       ["edited on B", "Close", null, "Added On B"]);

    // wrong passphrase on a third device reads nothing
    await boot(null);
    route(server, "10.1.1.3");
    var err = await ev("FNSync.adopt('" + id + "', 'wrong passphrase').then(function () { return 'read it'; }, function (e) { return e.message; })");
    eq(err, "WRONG_PASSPHRASE");
  });

  test("sync: something added while a sync is in flight is kept and uploaded", async function () {
    var server = await makeServer();
    await boot(FNFake.makeState(20, 32), { ver: "x" });
    route(server, "10.2.2.2");
    ev("FNSync.enable('correct horse battery')");
    ev("doSync(false)"); await settle();
    ev("doSync(true)");                         // in flight...
    assert(ev("syncBusy"), "expected a sync in progress");
    ev("state.contacts.unshift(blankContact({ id: 'mid', name: 'Added Mid Sync', added: today() })); commit()");
    await settle();
    eq(ev("!!byId('mid')"), true, "the contact added during sync was dropped");
    await wait(4300); await settle();           // the follow-up sync uploads it
    var id = ev("FNSync.config().id");
    var before = JSON.parse(server.store.get("fn:" + id)).rev;
    assert(before >= 3, "follow-up sync did not run (rev " + before + ")");
    eq(T.stored().contacts.some(function (c) { return c.id === "mid"; }), true);
  });

  test("sync setup: mismatched passphrases are refused and the warning is shown", async function () {
    await boot(FNFake.makeState(3, 1), { ver: "x" });
    T.click('[data-act="opensettings"]');
    assert(/cannot be recovered or reset/.test(T.$(".warnbox").innerText));
    T.$("#syncPass").value = "correct horse battery"; T.$("#syncPass2").value = "correct horse batery";
    T.click('[data-act="syncon"]');
    eq(ev("FNSync.enabled()"), false);
    assert(/do not match/.test(T.text()));
    // declining the confirm also leaves sync off
    T.app().confirm = function () { return false; };
    T.$("#syncPass").value = "correct horse battery"; T.$("#syncPass2").value = "correct horse battery";
    T.click('[data-act="syncon"]');
    eq(ev("FNSync.enabled()"), false);
  });

  test("sync: a rate-limit reply is explained and local data is untouched", async function () {
    var server = await makeServer();
    await boot(FNFake.makeState(10, 33), { ver: "x" });
    route(server, "10.3.3.3");
    ev("FNSync.enable('correct horse battery')");
    for (var i = 0; i < 90; i++) await server.call("GET", { query: { id: ID_A }, ip: "10.3.3.3" });
    ev("doSync(false)"); await settle();
    assert(/paused for a few minutes/.test(ev("syncMsg")), ev("syncMsg"));
    assert(/sync problem/.test(T.$("#totalCount").textContent));
    eq(ev("state.contacts.length"), 10);
  });

  /* ================= import and bulk moves (v9.3) ================= */

  test("import: one tap adds everyone as Acquaintance; existing and file tiers win; undo removes exactly the batch", async function () {
    var s = FNFake.makeState(30, 6);
    s.contacts[0].name = "Existing Close"; s.contacts[0].tier = "Close"; s.contacts[0].phone = "215-555-0199";
    await boot(s, { ver: "x" });
    var csv = "name,phone,school,tier\nExisting Close,215-555-0199,,\nFile Middle,,Penn,Middle\n";
    for (var i = 0; i < 12; i++) csv += "New Person " + i + ",,Penn,\n";
    await importFile(csv);
    T.click('[data-act="pvquick"]');
    eq(ev("state.contacts.length"), 43);
    eq(ev("state.contacts[0].tier"), "Close", "existing tier was changed");
    eq(ev("state.contacts.filter(function (c) { return c.name === 'File Middle'; })[0].tier"), "Middle");
    eq(ev("state.contacts.filter(function (c) { return /^New Person/.test(c.name) && c.tier === 'Acquaintance' && !c.pending; }).length"), 12);
    eq(ev("state.contacts.filter(function (c) { return c.pending; }).length"), 0, "import must not fill the sort queue");
    T.click('[data-act="undoimport"]');
    eq(ev("state.contacts.length"), 30);
    eq(ev("state.deleted.length"), 13, "undo should leave tombstones for sync");
  });

  test("bulk move: staggers clocks for more than 5, never makes anyone due sooner, undo restores", async function () {
    var s = FNFake.makeState(0, 1);
    for (var i = 0; i < 12; i++) s.contacts.push(Object.assign(FNFake.makeContacts(1, 100 + i)[0], { id: "m" + i, tier: "Acquaintance", tierSince: "2026-01-01", tierLog: [] }));
    await boot(s, { ver: "x" });
    var ids = s.contacts.slice(0, 8).map(function (c) { return c.id; });
    ev("bulkMove(" + JSON.stringify(ids) + ", 'Middle')");
    var since = ev("state.contacts.filter(function (c) { return c.tier === 'Middle'; }).map(function (c) { return c.tierSince; })");
    eq(since.length, 8);
    var today = ev("today()");
    assert(since.every(function (d) { return d >= today; }), "a clock was set in the past");
    assert(new Set(since).size >= 6, "clocks are not spread out: " + since.join(","));
    T.click('[data-act="undomove"]');
    eq(ev("state.contacts.filter(function (c) { return c.tier === 'Acquaintance' && c.tierSince === '2026-01-01' && c.tierLog.length === 0; }).length"), 12);
  });
})();
