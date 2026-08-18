/* Claude Firefox Bridge - background (MV2, persistent)
 * Short-polls the local Perl bridge for commands, executes them against
 * Firefox, and posts results back. Mirrors the Chrome browser toolset.
 */
const BRIDGE = "http://localhost:8765";
const POLL_MS = 300;

let connected = false;
let lastAction = "-";
let lastError = "-";
let doneCount = 0;
let proOn = true;   // route Google searches through AI Mode (Pro); flip anytime via the popup

/* ---------- helpers ---------- */

async function getTargetTab(params) {
  params = params || {};
  if (params.tabId != null) {
    return await browser.tabs.get(params.tabId);
  }
  // Guard every tabs.query: a wedged tabs/IPC layer (heavy/privileged page) must
  // never hang a command past the loop cap - fall through to a bounded fallback.
  const tabs = await withTimeout(browser.tabs.query({ active: true, lastFocusedWindow: true }), 4000, null);
  if (tabs && tabs[0]) return tabs[0];
  const anyActive = await withTimeout(browser.tabs.query({ active: true }), 4000, null);
  if (anyActive && anyActive[0]) return anyActive[0];
  const anyTab = await withTimeout(browser.tabs.query({}), 4000, null);
  if (anyTab && anyTab[0]) return anyTab[0];
  throw new Error("no active tab found (tabs API unresponsive)");
}

// Inject a function (with a JSON-serializable arg) into a tab and return its value.
async function runFn(tabId, fn, arg) {
  const code = "(" + fn.toString() + ")(" + JSON.stringify(arg || {}) + ")";
  let res;
  try {
    // Bound executeScript so a stuck/loading tab can never hang the command loop.
    res = await withTimeout(browser.tabs.executeScript(tabId, { code }), 12000, "__CFB_EXEC_TIMEOUT__");
    if (res === "__CFB_EXEC_TIMEOUT__") throw new Error("executeScript timed out (12s) - tab busy/loading");
  } catch (e) {
    throw new Error("cannot run on this page (" + (e && e.message ? e.message : e) +
      "). Privileged pages like about:, addons.mozilla.org and view-source: are off-limits to extensions.");
  }
  return res && res[0];
}

function waitForLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { browser.tabs.onUpdated.removeListener(listener); } catch (e) {} resolve(v); } };
    const listener = (id, info) => { if (id === tabId && info.status === "complete") finish("complete"); };
    browser.tabs.onUpdated.addListener(listener);
    // If it's already complete, resolve soon.
    browser.tabs.get(tabId).then((t) => { if (t && t.status === "complete") finish("complete"); }).catch(() => {});
    setTimeout(() => finish("timeout"), timeoutMs || 15000);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Wait for a *fresh* page load to complete on a tab (no early-resolve on the
// page already there), with a hard timeout.
function waitForFreshLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { browser.tabs.onUpdated.removeListener(l); } catch (e) {} resolve(v); } };
    const l = (id, info) => { if (id === tabId && info.status === "complete") finish("complete"); };
    browser.tabs.onUpdated.addListener(l);
    setTimeout(() => finish("timeout"), timeoutMs || 30000);
  });
}

// Race any promise against a timeout so one stuck tab operation can never hang
// the whole command loop (heavy pages like a logged-in google.com can stall the
// tabs API indefinitely).
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((r) => setTimeout(() => r(fallback), ms)),
  ]);
}

// --- diagnostic ring buffer: record exactly where a command stalls (no guessing) ---
var DBG = [];
function dbg(s) {
  DBG.push(((Date.now() % 100000) / 1000).toFixed(2) + "  " + s);
  if (DBG.length > 300) DBG.shift();
}

function hostOf(u) { try { return new URL(u).host; } catch (e) { return null; } }

// Non-blocking tab read: browser.tabs.get(id) can BLOCK during a process switch
// (privileged -> remote). tabs.query({}) reads the parent-process cache index and
// never calls into a loading content window. (Pro-confirmed 2026-08-09.)
async function queryTab(tabId) {
  const all = await withTimeout(browser.tabs.query({}), 3000, []);
  return (all || []).find(t => t.id === tabId) || null;
}

// Fire a navigation and await REAL load completion via webNavigation.onCompleted.
// This hooks the network/parser layer and fires independent of paint/visibility -
// unlike tab.status / tabs.onUpdated, which in HEADLESS mode stay stuck on "loading"
// forever because the layout/paint flush that gates STATE_STOP never happens.
// Listener is attached BEFORE tabs.update (no race); we resolve on the first
// main-frame (frameId 0) completion on OUR tab that isn't the pre-nav about:blank,
// so redirects don't break it.
function navigateAndAwaitLoad(tabId, targetUrl, timeoutMs) {
  return new Promise((resolve) => {
    let to = null, doneOnce = false;
    // HEAVY-PAGE FIX (streaming SPAs like Google AI Mode): onCompleted == the window
    // "load" event and NEVER fires on a page that keeps streaming/loading, so the old
    // code hung the whole timeout. Resolve on whichever fires FIRST — DOMContentLoaded
    // (DOM parsed = page is readable) OR onCompleted — so heavy pages return promptly.
    function finish(v) { if (doneOnce) return; doneOnce = true; cleanup(); resolve(v); }
    function mk(kind) {
      return function (d) {
        if (d.tabId !== tabId || d.frameId !== 0) return;
        if (/^about:blank$/i.test(d.url || "")) return; // ignore the blank pre-nav tab
        dbg("webNav " + kind + " tab=" + tabId + " url=" + d.url);
        finish({ ok: true, url: d.url });
      };
    }
    var onComp = mk("complete"), onDom = mk("domready");
    function cleanup() {
      if (to) clearTimeout(to);
      try { browser.webNavigation.onCompleted.removeListener(onComp); } catch (e) {}
      try { browser.webNavigation.onDOMContentLoaded.removeListener(onDom); } catch (e) {}
    }
    try { browser.webNavigation.onCompleted.addListener(onComp); } catch (e) { dbg("webNav onComp add FAIL " + e); }
    try { browser.webNavigation.onDOMContentLoaded.addListener(onDom); } catch (e) { dbg("webNav onDom add FAIL " + e); }
    to = setTimeout(() => { dbg("webNav timeout tab=" + tabId); finish({ ok: false, url: targetUrl }); }, timeoutMs);
    Promise.resolve(browser.tabs.update(tabId, { url: targetUrl, active: true }))
      .catch((e) => { dbg("tabs.update err " + e); });
  });
}

// Navigate a tab, fully bounded (never hangs). Privileged/initial pages
// (about:home / about:newtab / about:blank) can't be navigated in place, so
// open the URL in a fresh tab instead.
async function navigateTab(tabId, url, timeoutMs) {
  const cap = timeoutMs || 15000;
  let targetId = tabId;
  dbg("nav start tab=" + tabId + " -> " + url);
  const t0 = await queryTab(tabId);
  dbg("nav t0 url=" + (t0 ? t0.url : "null"));
  // Privileged startup pages (about:*, chrome://blanktab, empty) can't be navigated
  // in place -> open a fresh window on about:blank and drive THAT tab.
  // about:blank IS navigable in place — do NOT force it onto the windows.create path
  // (that create call is exactly what wedges on FF153). Only truly-special pages need a fresh tab.
  var u0 = (t0 && t0.url) || "";
  const priv = !t0 || /^chrome:/i.test(u0) || /blanktab/i.test(u0) || /^about:(home|newtab|welcome|privatebrowsing|blocked)/i.test(u0);
  if (priv) {
    dbg("nav fresh window (privileged start)");
    const nw = await withTimeout(browser.windows.create({ url: "about:blank", type: "normal", width: 1920, height: 1080, focused: true }), 8000, "__TO__");
    if (nw !== "__TO__" && nw && nw.tabs && nw.tabs[0] && nw.tabs[0].id != null) targetId = nw.tabs[0].id;
    dbg("nav window tab=" + targetId);
  }
  // navigateAndAwaitLoad fires tabs.update AND waits on webNavigation.onCompleted
  // (paint-independent), so headless loads actually resolve.
  const res = await navigateAndAwaitLoad(targetId, url, cap);
  const ft = await queryTab(targetId);
  dbg("nav end ok=" + res.ok + " url=" + (ft ? ft.url : res.url));
  return { ok: true, url: (ft && ft.url) || res.url || url, title: ft ? ft.title : "", loaded: res.ok };
}

/* ---------- injected page functions (run in content sandbox) ---------- */

function pageReadInteractive(arg) {
  const MAX = (arg && arg.max) || 200;
  const sel = "a[href],button,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[onclick],summary,[contenteditable=true]";
  const nodes = Array.from(document.querySelectorAll(sel));
  const out = [];
  let ref = 0;
  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    const visible = r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
      r.top < (window.innerHeight || 1e9) && r.left < (window.innerWidth || 1e9);
    if (!visible) continue;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") continue;
    el.setAttribute("data-cfb-ref", String(ref));
    let label = (el.getAttribute("aria-label") || el.getAttribute("placeholder") ||
      el.value || el.innerText || el.getAttribute("title") || el.getAttribute("name") || "").trim();
    if (label.length > 120) label = label.slice(0, 120) + "…";
    out.push({
      ref: ref,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || undefined,
      role: el.getAttribute("role") || undefined,
      text: label,
      href: el.getAttribute("href") || undefined,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    });
    ref++;
    if (ref >= MAX) break;
  }
  return { url: location.href, title: document.title, count: out.length, elements: out };
}

function pageClick(arg) {
  let el = null;
  if (arg.ref != null) el = document.querySelector('[data-cfb-ref="' + arg.ref + '"]');
  else if (arg.selector) el = document.querySelector(arg.selector);
  else if (arg.x != null && arg.y != null) el = document.elementFromPoint(arg.x, arg.y);
  if (!el) return { ok: false, error: "element not found" };
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  const cx = arg.x != null ? arg.x : r.left + r.width / 2;
  const cy = arg.y != null ? arg.y : r.top + r.height / 2;
  const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window };
  for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    el.dispatchEvent(new MouseEvent(t, opts));
  }
  if (typeof el.click === "function") { try { el.click(); } catch (e) {} }
  return { ok: true, clicked: (el.innerText || el.value || el.getAttribute("aria-label") || el.tagName).toString().slice(0, 100) };
}

function pageType(arg) {
  let el = null;
  if (arg.ref != null) el = document.querySelector('[data-cfb-ref="' + arg.ref + '"]');
  else if (arg.selector) el = document.querySelector(arg.selector);
  else el = document.activeElement;
  if (!el) return { ok: false, error: "no target element" };
  el.focus();
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea") {
    const proto = tag === "input" ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    if (arg.replace !== false) setter.call(el, "");
    setter.call(el, (arg.replace === false ? el.value : "") + arg.text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (el.isContentEditable) {
    if (arg.replace !== false) el.textContent = "";
    el.textContent += arg.text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    return { ok: false, error: "target is not typeable (" + tag + ")" };
  }
  if (arg.submit) {
    const ev = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 };
    el.dispatchEvent(new KeyboardEvent("keydown", ev));
    el.dispatchEvent(new KeyboardEvent("keypress", ev));
    el.dispatchEvent(new KeyboardEvent("keyup", ev));
    if (el.form && typeof el.form.requestSubmit === "function") { try { el.form.requestSubmit(); } catch (e) {} }
  }
  return { ok: true, typed: arg.text };
}

function pageScroll(arg) {
  if (arg.x != null || arg.y != null) {
    window.scrollBy(arg.x || 0, arg.y || 0);
  } else {
    const amt = arg.amount || Math.round(window.innerHeight * 0.85);
    const d = arg.direction || "down";
    if (d === "down") window.scrollBy(0, amt);
    else if (d === "up") window.scrollBy(0, -amt);
    else if (d === "right") window.scrollBy(amt, 0);
    else if (d === "left") window.scrollBy(-amt, 0);
    else if (d === "top") window.scrollTo(0, 0);
    else if (d === "bottom") window.scrollTo(0, document.body.scrollHeight);
  }
  return { ok: true, scrollY: window.scrollY, scrollX: window.scrollX };
}

/* ---------- command dispatch ---------- */

async function handle(cmd) {
  const p = cmd.params || {};
  switch (cmd.action) {
    case "cfbmarker": return { marker: "RAGNAROK-PATCH-20260809" };
    case "cfbdebug": return { log: DBG.slice(-80) };
    case "ping":
    case "health": {
      let tab = null;
      try { tab = await getTargetTab(p); } catch (e) {}
      const info = await browser.runtime.getBrowserInfo ? await browser.runtime.getBrowserInfo().catch(() => null) : null;
      return { ok: true, browser: info, activeTab: tab ? { id: tab.id, url: tab.url, title: tab.title } : null };
    }
    case "tabs.list": {
      const tabs = await browser.tabs.query({});
      return tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId }));
    }
    case "tabs.create": {
      const t = await browser.tabs.create({ url: p.url || "about:blank", active: p.active !== false });
      if (p.url) await waitForLoad(t.id, p.timeout || 30000);
      const t2 = await browser.tabs.get(t.id);
      return { id: t2.id, url: t2.url, title: t2.title };
    }
    case "tabs.close": {
      await browser.tabs.remove(p.tabId);
      return { ok: true, closed: p.tabId };
    }
    case "tabs.activate": {
      const t = await browser.tabs.update(p.tabId, { active: true });
      await browser.windows.update(t.windowId, { focused: true }).catch(() => {});
      return { ok: true, active: t.id };
    }
    case "navigate": {
      const tab = await getTargetTab(p);
      let url = p.url;
      if (url === "back" || url === "forward") {
        await runFn(tab.id, url === "back" ? () => history.back() : () => history.forward(), {});
        await waitForLoad(tab.id, p.timeout || 15000);
        const tb = await browser.tabs.get(tab.id);
        return { ok: true, url: tb.url, title: tb.title };
      }
      if (!/^[a-z]+:/i.test(url)) url = "https://" + url;
      const t2 = await navigateTab(tab.id, url, p.timeout || 30000);
      return { ok: true, url: t2.url, title: t2.title };
    }
    case "back": { const tab = await getTargetTab(p); await runFn(tab.id, () => history.back(), {}); await waitForLoad(tab.id, 8000); const t = await browser.tabs.get(tab.id); return { ok: true, url: t.url }; }
    case "forward": { const tab = await getTargetTab(p); await runFn(tab.id, () => history.forward(), {}); await waitForLoad(tab.id, 8000); const t = await browser.tabs.get(tab.id); return { ok: true, url: t.url }; }
    case "reload": { const tab = await getTargetTab(p); await browser.tabs.reload(tab.id); await waitForLoad(tab.id, 20000); return { ok: true }; }
    case "get_text": {
      const tab = await getTargetTab(p);
      const max = p.max || 20000;
      const txt = await runFn(tab.id, (a) => (document.body ? document.body.innerText : "").slice(0, a.max), { max });
      return { url: tab.url, title: tab.title, text: txt };
    }
    case "get_html": {
      const tab = await getTargetTab(p);
      const max = p.max || 40000;
      const html = await runFn(tab.id, (a) => document.documentElement.outerHTML.slice(0, a.max), { max });
      return { url: tab.url, html };
    }
    case "read_page": {
      const tab = await getTargetTab(p);
      return await runFn(tab.id, pageReadInteractive, { max: p.max || 200 });
    }
    case "click": {
      const tab = await getTargetTab(p);
      const r = await runFn(tab.id, pageClick, p);
      return r;
    }
    case "type": {
      const tab = await getTargetTab(p);
      return await runFn(tab.id, pageType, p);
    }
    case "scroll": {
      const tab = await getTargetTab(p);
      return await runFn(tab.id, pageScroll, p);
    }
    case "screenshot": {
      const tab = await getTargetTab(p);
      await browser.tabs.update(tab.id, { active: true });
      const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      const b64 = dataUrl.replace(/^data:image\/png;base64,/, "");
      return { png_base64: b64, url: tab.url };
    }
    case "wait": {
      await new Promise((r) => setTimeout(r, p.ms || 500));
      return { ok: true, waited: p.ms || 500 };
    }
    case "search.info": {
      if (!browser.search || !browser.search.get) return { error: "no search API" };
      const engines = await browser.search.get();
      return engines.map((e) => ({ name: e.name, isDefault: e.isDefault }));
    }
    default:
      throw new Error("unknown action: " + cmd.action);
  }
}

/* ---------- poll loop ---------- */

async function postResult(id, result) {
  await fetch(BRIDGE + "/result", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, result })
  });
}

let GENERATION = 0;

async function registerGeneration() {
  const r = await fetch(BRIDGE + "/register_generation", { cache: "no-store" });
  const j = await r.json();
  GENERATION = j.generation;
  dbg("registered generation=" + GENERATION);
}

async function pollLoop() {
  // Announce this context first. Bumps the bridge generation so any older zombie
  // loop (left by an RDP add-on reload) gets 410 on its next poll and halts -
  // that zombie was silently draining commands out of the single-consumer queue.
  for (;;) {
    try { await registerGeneration(); break; }
    catch (e) { await new Promise((r) => setTimeout(r, 1500)); }
  }
  for (;;) {
    try {
      const res = await fetch(BRIDGE + "/poll?generation=" + GENERATION, { cache: "no-store" });
      if (res.status === 410) { dbg("410 ZOMBIE -> halting this loop"); connected = false; return; }
      connected = true;
      const cmd = await res.json();
      if (cmd && cmd.id != null && cmd.action) {
        lastAction = cmd.action;
        dbg("LOOP handle id=" + cmd.id + " action=" + cmd.action);
        let result;
        try { result = await withTimeout(handle(cmd), 30000, { error: "command timed out after 30s (loop kept alive)" }); lastError = "-"; }
        catch (e) { result = { error: String(e && e.stack ? e.stack : e) }; lastError = String(e && e.message ? e.message : e); }
        dbg("LOOP done id=" + cmd.id + " -> " + (result && result.error ? "ERR " + result.error : "ok"));
        try { await postResult(cmd.id, result); doneCount++; } catch (e) { dbg("LOOP POST FAIL id=" + cmd.id + " " + e); }
        // ack AFTER the result is stored, so a command grabbed by a dying consumer
        // gets redelivered instead of lost.
        try { await fetch(BRIDGE + "/ack?id=" + cmd.id, { cache: "no-store" }); dbg("LOOP acked id=" + cmd.id); } catch (e) {}
        continue;
      }
    } catch (e) {
      connected = false; // bridge down; back off
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// expose status to the popup
browser.runtime.onMessage.addListener((msg) => {
  if (msg === "status") {
    return Promise.resolve({ connected, lastAction, lastError, doneCount, bridge: BRIDGE, proOn });
  }
  if (msg && typeof msg === "object") {
    if (msg.cmd === "getPro") return Promise.resolve({ proOn });
    if (msg.cmd === "setPro" || msg.cmd === "answerPro") return setPro(msg.on);
  }
});

// ---- Pro (AI Mode) search upgrade -------------------------------------------
// "Pro" = route Google searches through AI Mode (udm=50). A runtime flag we flip
// anytime from the toolbar popup — no reboot, nothing forced. The persistent
// choice lives in the bridge's pro.state (set by the boot popup); storage.local
// is a fallback for when the bridge isn't reachable.
async function initPro() {
  try {
    const r = await fetch(BRIDGE + "/pro", { cache: "no-store" });
    const j = await r.json();
    if (j && typeof j.on === "boolean") { proOn = j.on; return; }
  } catch (e) {}
  try {
    const s = await browser.storage.local.get("proOn");
    if (s && typeof s.proOn === "boolean") proOn = s.proOn;
  } catch (e) {}
}

async function setPro(on) {
  proOn = !!on;
  try { await browser.storage.local.set({ proOn }); } catch (e) {}
  try {
    await fetch(BRIDGE + "/pro", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ on: proOn }),
    });
  } catch (e) {}
  return { ok: true, proOn };
}

// When Pro is on, rewrite google.com/search -> add udm=50 (AI Mode). The udm===50
// guard stops a redirect loop; only top-level page loads are touched.
function proRedirect(details) {
  if (!proOn) return {};
  try {
    const u = new URL(details.url);
    if (u.pathname !== "/search" || !u.searchParams.has("q")) return {};
    if (u.searchParams.get("udm") === "50") return {};
    u.searchParams.set("udm", "50");
    return { redirectUrl: u.toString() };
  } catch (e) { return {}; }
}
try {
  browser.webRequest.onBeforeRequest.addListener(
    proRedirect,
    { urls: ["*://www.google.com/search*", "*://google.com/search*"], types: ["main_frame"] },
    ["blocking"]
  );
} catch (e) {}

pollLoop();
initPro();
