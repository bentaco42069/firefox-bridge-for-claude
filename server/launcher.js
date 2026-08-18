'use strict';
/**
 * Start the Firefox-Pro bridge on THIS user's machine.
 *
 * Bentaco the Destroyer's Firefox connector.
 *
 * Runs a HEADLESS, ISOLATED automation Firefox on its own profile via -no-remote, so it
 * never appears on screen and never locks the user's normal Firefox. They can keep
 * browsing while it works.
 *
 * EVERYTHING MACHINE-SPECIFIC IS DETECTED, NOT HARDCODED - that is the whole difference
 * between "works on the author's PC" and "works for anyone who installs it":
 *   * Firefox is found via the Windows registry, then the usual install locations.
 *   * The user's own default profile is resolved from THEIR profiles.ini.
 *   * Every path is relative to wherever this extension was installed.
 *
 * Node standard library only. Nothing to install.
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const HERE = __dirname;
const PKG = path.dirname(HERE);
const EXT_DIR = path.join(PKG, 'extension');
const AUTO_PROFILE = path.join(PKG, 'auto-profile');
const BRIDGE_JS = path.join(HERE, 'bridge.js');
const SIGNIN_PID = path.join(PKG, 'signin.pid');  // pid of the visible one-time sign-in window

const BRIDGE_PORT = 8765;
const RDP_PORT = 6000;

/**
 * Find a real node binary to run the bridge with.
 *
 * DO NOT assume process.execPath is node. When this server runs inside the Claude app,
 * execPath is the APP's binary, not node - so spawning it with bridge.js as an argument
 * silently fails and the bridge never comes up. That bug hid for a whole session because
 * a bridge started by hand was already listening on 8765; the first cold boot exposed it
 * (2026-08-18).
 */
function resolveNode() {
  const exe = (process.execPath || '').toLowerCase();
  if (/(^|[\\/])node(\.exe)?$/.test(exe)) return process.execPath;

  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'node.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe')
  ];
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch (e) {}
  }
  try {
    const out = execFileSync('where', ['node'], { encoding: 'utf8', windowsHide: true });
    const first = out.split(/\r?\n/).find((l) => l.trim().toLowerCase().endsWith('node.exe'));
    if (first && fs.existsSync(first.trim())) return first.trim();
  } catch (e) {}
  return null;
}
const BRIDGE = 'http://127.0.0.1:' + BRIDGE_PORT;

// ------------------------------------------------------------------ discovery
function findFirefox() {
  // registry first (handles non-default install locations)
  const queries = [
    ['HKLM\\SOFTWARE\\Mozilla\\Mozilla Firefox'],
    ['HKLM\\SOFTWARE\\WOW6432Node\\Mozilla\\Mozilla Firefox'],
    ['HKCU\\SOFTWARE\\Mozilla\\Mozilla Firefox']
  ];
  for (const [key] of queries) {
    try {
      const out = execFileSync('reg', ['query', key, '/v', 'CurrentVersion'],
                               { encoding: 'utf8', windowsHide: true });
      const m = out.match(/CurrentVersion\s+REG_SZ\s+(.+)/);
      if (!m) continue;
      const ver = m[1].trim();
      const out2 = execFileSync('reg', ['query', key + '\\' + ver + '\\Main', '/v', 'PathToExe'],
                                { encoding: 'utf8', windowsHide: true });
      const m2 = out2.match(/PathToExe\s+REG_SZ\s+(.+)/);
      if (m2) {
        const p = m2[1].trim();
        if (fs.existsSync(p)) return p;
      }
    } catch (e) { /* try the next one */ }
  }
  const guesses = [
    'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
    'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Mozilla Firefox', 'firefox.exe')
  ];
  for (const g of guesses) if (g && fs.existsSync(g)) return g;
  return null;
}

function findDefaultProfile() {
  const base = path.join(process.env.APPDATA || '', 'Mozilla', 'Firefox');
  const ini = path.join(base, 'profiles.ini');
  if (!fs.existsSync(ini)) return null;

  let text;
  try { text = fs.readFileSync(ini, 'utf8'); } catch (e) { return null; }

  // minimal ini parse - sections of key=value
  const sections = {};
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const s = line.match(/^\[(.+)\]$/);
    if (s) { cur = s[1]; sections[cur] = {}; continue; }
    const kv = line.match(/^([^=]+)=(.*)$/);
    if (kv && cur) sections[cur][kv[1].trim()] = kv[2].trim();
  }

  const resolve = (p, isRel) => (isRel ? path.join(base, p.replace(/\//g, path.sep)) : p);

  // [InstallXXXX] Default= points at the profile actually in use
  for (const name of Object.keys(sections)) {
    if (name.startsWith('Install')) {
      const d = sections[name].Default;
      if (d) {
        const p = resolve(d, !path.isAbsolute(d));
        if (fs.existsSync(p)) return p;
      }
    }
  }
  // else the profile flagged Default=1, else the first that exists
  let fallback = null;
  for (const name of Object.keys(sections)) {
    if (!name.startsWith('Profile')) continue;
    const d = sections[name].Path;
    if (!d) continue;
    const p = resolve(d, sections[name].IsRelative !== '0');
    if (!fs.existsSync(p)) continue;
    if (sections[name].Default === '1') return p;
    if (!fallback) fallback = p;
  }
  return fallback;
}

// ------------------------------------------------------------------ processes
function pidsOnPort(port) {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes('LISTENING')) continue;
      if (!line.replace(/\t/g, ' ').includes(':' + port + ' ')) continue;
      const parts = line.trim().split(/\s+/);
      const last = parts[parts.length - 1];
      if (/^\d+$/.test(last)) pids.add(last);
    }
    return [...pids];
  } catch (e) { return []; }
}

function killPid(pid, tree) {
  try {
    execFileSync('taskkill', tree ? ['/F', '/T', '/PID', String(pid)] : ['/F', '/PID', String(pid)],
                 { stdio: 'ignore', windowsHide: true });
  } catch (e) {}
}

function bridgeUp() {
  return new Promise((resolve) => {
    const r = http.get(BRIDGE + '/health', { timeout: 2000 }, (res) => {
      res.resume(); resolve(res.statusCode === 200);
    });
    r.on('error', () => resolve(false));
    r.on('timeout', () => { r.destroy(); resolve(false); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ profile prep
// SOURCE OF TRUTH for the automation profile's prefs - rewritten every launch, so any
// change MUST live here or it silently reverts.
const USER_JS = `
user_pref("devtools.debugger.remote-enabled", true);
user_pref("devtools.chrome.enabled", true);
user_pref("devtools.debugger.prompt-connection", false);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("datareporting.healthreport.uploadEnabled", false);
user_pref("browser.startup.homepage", "about:blank");
user_pref("browser.startup.page", 1);
user_pref("browser.newtabpage.enabled", false);
/* No first-run / welcome tab: a privileged about:welcome tab forces every navigate onto
   the slow windows.create path, which is where results intermittently stall. */
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.startup.firstrunSkipsHomepage", true);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("startup.homepage_welcome_url", "about:blank");
user_pref("startup.homepage_welcome_url.additional", "");
user_pref("startup.homepage_override_url", "");
user_pref("browser.messaging-system.whatsNewPanel.enabled", false);
/* No session-restore / crash prompts that would leave a privileged tab up. */
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("toolkit.startup.max_resumed_crashes", -1);
/* HEADLESS TIMER-THROTTLING KILL: a headless background page is treated as a hidden tab,
   so setTimeout throttles and Promise.race timeouts never fire. */
user_pref("dom.min_background_timeout_value", 10);
user_pref("dom.timeout.enable_budget_timer_throttling", false);
user_pref("dom.timeout.background_throttling_max_delay", 50);
user_pref("dom.timeout.throttling_delay", 0);
user_pref("javascript.options.mem.gc_per_zone", true);
/* Headless load-completion: report documents visible and keep the virtual compositor
   clock running so load milestones fire and webNavigation resolves. */
user_pref("dom.visibilityState.override", "visible");
user_pref("layout.frame_rate", 60);
user_pref("layout.frame_rate.precise", true);
user_pref("dom.ipc.processPriorityManager.enabled", false);
/* HEAVY SINGLE-PAGE APPS (added 2026-08-17). The EcoQoS fix stopped the browser
   FREEZING, but it never made a heavy app actually RENDER: with no GPU a headless window
   has no compositor path, so an app that paints via canvas/WebGL never finishes hydrating
   and the page reads back empty. Software WebRender gives it a real compositor; forcing
   WebGL on stops apps bailing out when they probe for it; Fission (site isolation) only
   multiplies process overhead here. */
user_pref("gfx.webrender.all", true);
user_pref("gfx.webrender.software", true);
user_pref("gfx.webrender.software.opengl", true);
user_pref("gfx.canvas.accelerated", true);
user_pref("webgl.force-enabled", true);
user_pref("webgl.disabled", false);
user_pref("layers.acceleration.disabled", false);
user_pref("fission.autostart", false);
user_pref("dom.ipc.processCount", 8);
/* WINDOWS 11 ECOQOS KILL - the real root cause of the headless navigate-freeze on
   Firefox 153 (Bugzilla 1796525 / 1800412). Windows puts background content processes
   into efficiency mode, which parks the event loop on tabs.update so no load or timeout
   ever fires. Defaults TRUE -> must be FALSE. */
user_pref("dom.ipc.processPriorityManager.backgroundUsesEcoQoS", false);
`;

function seedCookies(defaultProfile) {
  // Copy the cookie database so the headless instance is signed in as the user.
  // It MUST be a SQLITE ONLINE BACKUP, not a file copy. Firefox keeps the cookie store
  // in WAL mode, so recent writes - including the Google LOGIN tokens - live in
  // cookies.sqlite-wal, not in cookies.sqlite. Copying the main file alone yields a
  // STALE database with no login at all, which is exactly how this first behaved: the
  // search ran but came back signed out, so the answer was a plain one instead of the
  // user's Pro one. MEASURED 2026-08-17: plain copy -> 0 Google login tokens;
  // online backup -> all 747 cookies and all 7 login tokens.
  //
  // We deliberately never touch key4.db or logins.json - the user's saved passwords
  // stay where they are.
  if (!defaultProfile) return false;
  const src = path.join(defaultProfile, 'cookies.sqlite');
  const dst = path.join(AUTO_PROFILE, 'cookies.sqlite');
  if (!fs.existsSync(src)) return false;

  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(dst + suffix, { force: true }); } catch (e) {}
  }

  try {
    const sqlite = require('node:sqlite');
    const db = new sqlite.DatabaseSync(src, { readOnly: true });
    try {
      const r = sqlite.backup(db, dst);
      if (r && typeof r.then === 'function') r.catch(() => {});
    } finally {
      try { db.close(); } catch (e) {}
    }
    if (fs.existsSync(dst) && fs.statSync(dst).size > 0) return true;
  } catch (e) {
    // fall through to the copy fallback
  }

  // Fallback for a runtime without node:sqlite: copy the main file together with its
  // WAL and shm so at least the recent writes travel with it.
  let ok = false;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      const s = path.join(defaultProfile, 'cookies.sqlite' + suffix);
      if (fs.existsSync(s)) { fs.copyFileSync(s, dst + suffix); if (!suffix) ok = true; }
    } catch (e) {}
  }
  return ok;
}

function seedGoogleStorage(defaultProfile) {
  // Cookies alone are NOT enough for a Google login. Measured 2026-08-17: all 7 login
  // tokens copied across intact, unexpired and unpartitioned, and myaccount.google.com
  // STILL returned the signed-out page. The rest of the session lives in the profile's
  // storage area (localStorage / IndexedDB).
  //
  // Deliberately SELECTIVE: only origins whose name contains "google", plus the origin
  // registry Firefox needs to recognise them. The full storage folder is hundreds of MB
  // and copying it every launch would be exactly the lag we just removed. Nothing here
  // touches key4.db or logins.json - the user's saved passwords are never copied.
  if (!defaultProfile) return false;
  const srcStorage = path.join(defaultProfile, 'storage', 'default');
  if (!fs.existsSync(srcStorage)) return false;
  const dstStorage = path.join(AUTO_PROFILE, 'storage', 'default');
  fs.mkdirSync(dstStorage, { recursive: true });

  let copied = 0;
  let entries = [];
  try { entries = fs.readdirSync(srcStorage); } catch (e) { return false; }
  for (const name of entries) {
    if (!/google/i.test(name)) continue;
    try {
      fs.cpSync(path.join(srcStorage, name), path.join(dstStorage, name),
                { recursive: true, force: true, errorOnExist: false });
      copied++;
    } catch (e) { /* a locked sqlite inside one origin is not fatal */ }
  }
  // the origin registry, so Firefox knows those origins exist
  for (const f of ['storage.sqlite', 'storage.sqlite-wal', 'storage.sqlite-shm']) {
    try {
      const s = path.join(defaultProfile, f);
      if (fs.existsSync(s)) fs.copyFileSync(s, path.join(AUTO_PROFILE, f));
    } catch (e) {}
  }
  return copied > 0;
}


function prepProfile(defaultProfile) {
  fs.mkdirSync(AUTO_PROFILE, { recursive: true });
  seedCookies(defaultProfile);
  seedGoogleStorage(defaultProfile);
  // Wipe session-restore/crash state so a prior hard-kill cannot reload heavy old tabs,
  // which wedges the tabs API on startup.
  for (const n of ['sessionstore.jsonlz4', 'sessionstore.js', 'sessionCheckpoints.json']) {
    try { fs.rmSync(path.join(AUTO_PROFILE, n), { force: true }); } catch (e) {}
  }
  try { fs.rmSync(path.join(AUTO_PROFILE, 'sessionstore-backups'), { recursive: true, force: true }); } catch (e) {}
  fs.writeFileSync(path.join(AUTO_PROFILE, 'user.js'), USER_JS, 'utf8');
}

// Persistent dedicated profile. Unlike the old model this NEVER copies the user's cookies
// out of their main Firefox - the profile keeps its OWN Google login, established once via a
// visible sign-in (signInStart). Created if missing, otherwise left intact; only volatile
// session/lock state is cleared so a prior hard-kill can't wedge the next startup.
function ensureProfile() {
  fs.mkdirSync(AUTO_PROFILE, { recursive: true });
  fs.writeFileSync(path.join(AUTO_PROFILE, 'user.js'), USER_JS, 'utf8');
  for (const n of ['sessionstore.jsonlz4', 'sessionstore.js', 'sessionCheckpoints.json',
                   'parent.lock', '.parentlock', 'lock']) {
    try { fs.rmSync(path.join(AUTO_PROFILE, n), { force: true }); } catch (e) {}
  }
  try { fs.rmSync(path.join(AUTO_PROFILE, 'sessionstore-backups'), { recursive: true, force: true }); } catch (e) {}
}

// Close the visible one-time sign-in window (if any) so the headless instance can take the
// profile lock. Killing by tracked pid; the user's own Firefox is a different process/profile.
function killSignInWindow() {
  try {
    const pid = fs.readFileSync(SIGNIN_PID, 'utf8').trim();
    if (pid) killPid(pid, true);
  } catch (e) {}
  try { fs.rmSync(SIGNIN_PID, { force: true }); } catch (e) {}
}

/**
 * ONE-TIME ACTIVATION. Open a VISIBLE Firefox on the connector's own profile at the Google
 * sign-in page. The user signs in themselves - we never see or store the password - and the
 * login is written into THIS profile, where it persists. Every later headless search is then
 * already signed in, with no copying of anything from the user's main Firefox.
 */
async function signInStart() {
  if (process.platform !== 'win32') return { ok: false, message: 'This connector supports Windows only.' };
  const ff = findFirefox();
  if (!ff) return { ok: false, message: 'Firefox was not found. Install it from mozilla.org, then try again.' };
  // free the profile: stop the headless instance and any prior sign-in window, drop locks
  for (const pid of pidsOnPort(RDP_PORT)) killPid(pid, true);
  killSignInWindow();
  ensureProfile();
  await sleep(800);
  try {
    const child = spawn(ff, ['-no-remote', '-profile', AUTO_PROFILE,
                             'https://accounts.google.com/ServiceLogin'],
                        { detached: true, stdio: 'ignore', windowsHide: false });
    try { fs.writeFileSync(SIGNIN_PID, String(child.pid)); } catch (e) {}
    child.unref();
  } catch (e) {
    return { ok: false, message: 'could not open the sign-in window: ' + e.message };
  }
  return { ok: true, message: 'sign-in window opened' };
}

// ------------------------------------------------------------------ main
/**
 * Append a line to launcher-debug.log next to the extension.
 *
 * When this runs inside the Claude app there is no console to watch and the tool only
 * ever surfaces a friendly one-line error, so a real failure is invisible. This writes
 * the actual step and the actual value to disk so a failure can be READ instead of
 * guessed at (added 2026-08-18 after a cold boot broke the bridge and three rounds of
 * theorising got nowhere).
 */
function dbg(m) {
  try {
    fs.appendFileSync(path.join(PKG, 'launcher-debug.log'),
                      new Date().toISOString() + '  ' + m + '\n');
  } catch (e) {}
}


async function start(verbose) {
  const say = (m) => { if (verbose) console.error(m); dbg(m); };
  dbg('--- start() called ---');
  dbg('process.execPath = ' + process.execPath);
  dbg('process.version  = ' + process.version);
  dbg('__dirname        = ' + HERE);

  if (process.platform !== 'win32') {
    return { ok: false, message: 'This connector currently supports Windows only.' };
  }

  const ff = findFirefox();
  dbg('findFirefox() = ' + (ff || 'NULL'));
  if (!ff) {
    dbg('FAIL: firefox not found');
    return { ok: false, message: 'Firefox was not found on this computer. Install Firefox ' +
                                 'from mozilla.org, then try again.' };
  }

  // 1) bridge - restart clean (an old bridge serves stale routes)
  for (const pid of pidsOnPort(BRIDGE_PORT)) killPid(pid, false);
  const nodeExe = resolveNode();
  dbg('resolveNode() = ' + (nodeExe || 'NULL'));
  dbg('BRIDGE_JS exists = ' + fs.existsSync(BRIDGE_JS) + '  (' + BRIDGE_JS + ')');
  if (!nodeExe) {
    dbg('FAIL: no node.exe found');
    return { ok: false, message: 'could not find node.exe to run the bridge with. ' +
                                 'Install Node.js from nodejs.org, then try again.' };
  }
  try {
    spawn(nodeExe, [BRIDGE_JS, String(BRIDGE_PORT)],
          { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    dbg('spawned bridge with ' + nodeExe);
  } catch (e) {
    dbg('FAIL spawning bridge: ' + e.message);
    return { ok: false, message: 'could not start the bridge: ' + e.message };
  }
  for (let i = 0; i < 25; i++) { if (await bridgeUp()) break; await sleep(300); }
  if (!(await bridgeUp())) {
    dbg('FAIL: bridge never answered on ' + BRIDGE_PORT);
    return { ok: false, message: 'the bridge did not come up on 127.0.0.1:' + BRIDGE_PORT };
  }
  say('bridge up');

  // 2) persistent isolated profile - keeps its OWN Google login (one-time signInStart);
  //    NO copying of the user's cookies out of their main Firefox.
  ensureProfile();
  killSignInWindow();          // if a visible sign-in window is open, free the profile lock
  say('profile ready');

  // 3) free the automation profile BEFORE launching, or Firefox shows a visible
  //    "already running" popup. Only the previous automation instance is touched - the
  //    user's own Firefox is a separate process tree on a different profile.
  for (const pid of pidsOnPort(RDP_PORT)) killPid(pid, true);
  for (const n of ['parent.lock', '.parentlock', 'lock']) {
    try { fs.rmSync(path.join(AUTO_PROFILE, n), { force: true }); } catch (e) {}
  }
  await sleep(1000);

  // 4) launch HEADLESS + -no-remote on the isolated profile (invisible)
  try {
    // --window-size matters: the headless default viewport is small enough that desktop
    // apps lay out cramped or refuse to render at all.
    spawn(ff, ['-no-remote', '-profile', AUTO_PROFILE, '-headless',
               '--window-size=1920,1080',
               '-start-debugger-server', String(RDP_PORT), 'about:blank'],
          { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (e) {
    return { ok: false, message: 'could not start Firefox: ' + e.message };
  }
  say('firefox launched (headless)');

  // 5) load the extension over RDP - ONE install only. A second one spawns a second
  //    background page, and two consumers drain the single-consumer queue.
  const { install } = require('./rdp-install.js');
  const r = await install(RDP_PORT, EXT_DIR);
  say('extension: ' + r.message);

  // 6) wait until the extension's command loop actually answers, so the caller gets a
  //    READY instance rather than one that is still connecting.
  for (let i = 0; i < 45; i++) {
    try {
      const id = await postJson('/command', { action: 'cfbmarker' });
      if (id && id.id) {
        const res = await getJson('/result/' + id.id);
        if (res && res.done) return { ok: true, message: 'bridge ready' };
      }
    } catch (e) {}
    await sleep(1000);
  }
  return { ok: false, message: 'the extension is not answering yet' };
}

function getJson(p, timeout) {
  return new Promise((resolve, reject) => {
    const r = http.get(BRIDGE + p, { timeout: timeout || 4000 }, (res) => {
      let out = '';
      res.on('data', (c) => out += c);
      res.on('end', () => { try { resolve(JSON.parse(out || '{}')); } catch (e) { reject(e); } });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
  });
}

function postJson(p, body, timeout) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(BRIDGE + p, {
      method: 'POST',
      timeout: timeout || 6000,
      headers: { 'content-type': 'application/json', 'content-length': data.length }
    }, (res) => {
      let out = '';
      res.on('data', (c) => out += c);
      res.on('end', () => { try { resolve(JSON.parse(out || '{}')); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

/**
 * Restart the headless automation browser on the PERSISTENT profile.
 *
 * The profile keeps its OWN Google login (established once via signInStart), so a restart
 * must PRESERVE that login - it does NOT wipe the profile and does NOT copy anything out of
 * the user's main Firefox. Use this if the hidden browser gets wedged; use signInStart if it
 * comes back signed out.
 */
async function reseedAndRestart() {
  for (const port of [RDP_PORT, BRIDGE_PORT]) {
    for (const pid of pidsOnPort(port)) killPid(pid, port === RDP_PORT);
  }
  killSignInWindow();
  await sleep(1200);
  return await start(false);
}

module.exports = { start, reseedAndRestart, signInStart, findFirefox, findDefaultProfile,
                   bridgeUp, getJson, postJson, BRIDGE, BRIDGE_PORT, RDP_PORT };

if (require.main === module) {
  start(true).then((r) => {
    console.log((r.ok ? 'OK: ' : 'WARNING: ') + r.message);
    process.exit(r.ok ? 0 : 1);
  });
}
