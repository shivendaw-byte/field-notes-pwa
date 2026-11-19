/* Deterministic fake people. Nothing here is a real person: names are drawn
   from short word lists and phone numbers use the reserved 555-01xx range. */
(function () {
  "use strict";
  var FIRST = ["Avery", "Blake", "Casey", "Devon", "Emery", "Finley", "Gray", "Harper", "Indigo", "Jules",
               "Kai", "Logan", "Morgan", "Noel", "Oakley", "Parker", "Quinn", "Reese", "Sage", "Tatum"];
  var LAST = ["Stone", "Rivers", "Field", "Marsh", "Hill", "Brook", "Vale", "Wood", "Lake", "Frost",
              "Reed", "Moss", "Glen", "Shore", "Heath", "Dale", "Ford", "Birch", "Cliff", "Wells"];
  var SCHOOLS = ["Penn", "Penn", "Penn", "Northfield High", "", "", "Drexel"];
  var COMPANIES = ["", "", "", "Acme", "Globex", "Initech"];
  var CITIES = ["Philadelphia", "Philadelphia", "Boston", "Chicago", "Austin", "", ""];
  var TIERS = ["Close", "Middle", "Acquaintance", "Networking"];
  var POTS = ["", "", "", "Low", "Some", "Moderate", "Strong", "Rare"];
  var TAGS = ["", "", "#geoclub", "#hall", "#classboard", "#nso"];

  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function iso(daysAgo) {
    var d = new Date(); d.setDate(d.getDate() - daysAgo);
    return d.toISOString().slice(0, 10);
  }

  /* opts.shape: "current" (default) or "v93" (no fields added after v9.3). */
  function makeContacts(n, seed) {
    var r = rng(seed || 1), out = [];
    function pick(a) { return a[Math.floor(r() * a.length)]; }
    for (var i = 0; i < n; i++) {
      // Roughly the real shape: a few close, some middle, most acquaintances.
      var roll = r();
      var tier = roll < 0.03 ? "Close" : roll < 0.10 ? "Middle" : roll < 0.90 ? "Acquaintance" : "Networking";
      var hist = [];
      if (tier === "Close" || tier === "Middle" || r() < 0.05) {
        var k = Math.floor(r() * 6);
        for (var j = 0; j < k; j++) hist.push(iso(Math.floor(r() * 200)));
      }
      hist = hist.filter(function (d, x, a) { return a.indexOf(d) === x; }).sort();
      var tag = pick(TAGS);
      out.push({
        id: "f" + i.toString(36) + "x" + Math.floor(r() * 1e6).toString(36),
        name: pick(FIRST) + " " + pick(LAST) + " " + i,
        tier: tier,
        potential: tier === "Acquaintance" && r() < 0.8 ? "" : pick(POTS),
        company: pick(COMPANIES), school: pick(SCHOOLS), location: pick(CITIES), locationConfirmed: "",
        notes: (r() < 0.3 ? "Met at an event. " : "") + tag,
        // 555 exchange: never a real personal number. Unique per person, so the
        // only duplicates in a fake set are the ones a test plants on purpose.
        phone: r() < 0.85 ? "215-555-" + ("000" + i).slice(-4) : "",
        email: r() < 0.3 ? "person" + i + "@example.com" : "",
        pending: false, added: r() < 0.1 ? iso(Math.floor(r() * 90)) : "",
        interactions: hist, lastContact: hist.length ? hist[hist.length - 1] : "",
        tierLog: [], tierSince: iso(Math.floor(r() * 300)), snoozedUntil: "",
        updatedAt: new Date(Date.now() - Math.floor(r() * 1e9)).toISOString()
      });
    }
    return out;
  }

  function makeState(n, seed) {
    return {
      version: 5, contacts: makeContacts(n, seed), deleted: [],
      settings: { onboarded: true, lastExport: iso(3), navMode: "text", tierMode: "name", showSub: "on",
                  subtitle: { location: true, notes: false, company: false, school: false, potential: false },
                  reconnect: "on" },
      updatedAt: new Date().toISOString()
    };
  }

  window.FNFake = { makeContacts: makeContacts, makeState: makeState, iso: iso, TIERS: TIERS };
})();
