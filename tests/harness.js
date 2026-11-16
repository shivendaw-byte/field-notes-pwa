/* Minimal test harness. Drives the real app in an iframe at ?fntest=1. */
(function () {
  "use strict";
  var LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  var KEY = "field-notes-TEST";
  var tests = [], frame, errors = [];

  function test(name, fn) { tests.push({ name: name, fn: fn }); }
  function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
  function eq(a, b, msg) {
    var x = JSON.stringify(a), y = JSON.stringify(b);
    if (x !== y) throw new Error((msg || "not equal") + "\n  got:      " + String(x).slice(0, 300) + "\n  expected: " + String(y).slice(0, 300));
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* Load the app fresh. `state` null means first run with empty storage.
     opts.ver sets the "last version that ran" marker; omit it to simulate an
     install from before that marker existed. opts.keep leaves storage alone. */
  function boot(state, opts) {
    opts = opts || {};
    if (!opts.keep) {
      Object.keys(localStorage).forEach(function (k) {
        if (k.indexOf(KEY) === 0 || k === "field-notes-sync") localStorage.removeItem(k);
      });
      if (state) localStorage.setItem(KEY, typeof state === "string" ? state : JSON.stringify(state));
      if (opts.ver) localStorage.setItem(KEY + ".ver", opts.ver);
    }
    return new Promise(function (resolve, reject) {
      frame.onload = function () {
        var w = frame.contentWindow;
        w.addEventListener("error", function (e) { errors.push(String(e.message)); });
        var orig = w.console.error;
        w.console.error = function () { errors.push([].join.call(arguments, " ")); orig.apply(w.console, arguments); };
        w.confirm = function () { return true; };
        var tries = 0;
        (function poll() {
          if (w.__FN && w.__FIELD_NOTES_READY) return resolve(w);
          if (++tries > 100) return reject(new Error("app did not boot in test mode"));
          setTimeout(poll, 30);
        })();
      };
      frame.src = "../index.html?fntest=1" + (opts.query || "") + "&t=" + Date.now();
    });
  }
  function app() { return frame.contentWindow; }
  function ev(code) { return app().__FN.eval(code); }
  function $(sel) { return app().document.querySelector(sel); }
  function $$(sel) { return [].slice.call(app().document.querySelectorAll(sel)); }
  function click(sel) {
    var el = typeof sel === "string" ? $(sel) : sel;
    assert(el, "nothing to click: " + sel);
    el.click();
  }
  function type(sel, text) {
    var el = $(sel);
    assert(el, "no input: " + sel);
    el.value = text;
    el.dispatchEvent(new (app().Event)("input", { bubbles: true }));
  }
  function key(sel, k) {
    $(sel).dispatchEvent(new (app().KeyboardEvent)("keydown", { key: k, bubbles: true }));
  }
  function stored() { return JSON.parse(localStorage.getItem(KEY)); }
  function text() { return app().document.body.innerText; }

  async function run() {
    var out = document.getElementById("out"), sum = document.getElementById("sum");
    frame = document.getElementById("app");
    if (!LOCAL) { out.textContent = "Tests only run on a local dev server."; return; }
    // A service worker left over from manual testing would serve stale files.
    if (navigator.serviceWorker) {
      var regs = await navigator.serviceWorker.getRegistrations();
      if (regs.length) {
        await Promise.all(regs.map(function (r) { return r.unregister(); }));
        var keys = await caches.keys();
        await Promise.all(keys.map(function (k) { return caches.delete(k); }));
        location.reload();
        return;
      }
    }
    // Refresh the browser's cached copy of every app file, so the frame can
    // never run an old stylesheet or script against new tests.
    await Promise.all(["styles.css", "app.js", "sync.js", "data.js", "manifest.json"].map(function (f) {
      return fetch("../" + f, { cache: "reload" }).catch(function () {});
    }));
    var pass = 0, failures = [], only = (location.hash || "").slice(1);
    for (var i = 0; i < tests.length; i++) {
      var t = tests[i];
      if (only && t.name.indexOf(decodeURIComponent(only)) === -1) continue;
      var line = document.createElement("div");
      errors = [];
      try {
        await t.fn();
        if (errors.length) throw new Error("console errors: " + errors.join(" | "));
        pass++; line.className = "pass"; line.textContent = "ok   " + t.name;
      } catch (e) {
        failures.push({ name: t.name, error: String(e && e.message || e) });
        line.className = "fail"; line.textContent = "FAIL " + t.name + "\n     " + String(e && e.message || e);
      }
      out.appendChild(line);
    }
    sum.textContent = "- " + pass + " passed, " + failures.length + " failed";
    window.__RESULTS = { pass: pass, fail: failures.length, failures: failures };
  }

  window.FNT = { test: test, assert: assert, eq: eq, wait: wait, boot: boot, app: app, ev: ev,
                 $: $, $$: $$, click: click, type: type, key: key, stored: stored, text: text, run: run, KEY: KEY };
})();
