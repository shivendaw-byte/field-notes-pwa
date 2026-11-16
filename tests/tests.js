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
