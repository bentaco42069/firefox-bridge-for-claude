'use strict';
/**
 * Firefox with Pro Searching for Claude - MCP server (desktop extension).
 *
 * Bentaco the Destroyer's Firefox connector.
 *
 * Runs entirely on the user's own machine and drives THEIR Firefox with THEIR Google
 * account. Nothing is sent to any server of ours, there is no tunnel, and no search
 * result ever leaves the computer it was run on. Every user's results are their own.
 *
 * Node standard library only - Node ships with Claude, so a fresh machine needs
 * nothing installed except Firefox itself.
 *
 * Transport: MCP over stdio, one JSON message per line, which is what Claude desktop
 * extensions speak.
 */
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const launcher = require('./launcher.js');

const SERVER_NAME = 'Firefox with Pro Searching for Claude';
const VERSION = '1.0.0';

// Pro on/off is persisted to a file on disk (the SAME file the bridge reads), so the
// setting is reliable and permanent: it never depends on the bridge being up, it survives
// bridge restarts and cold starts, and once it is on every search uses it until it is
// turned off. Before this it lived only in the bridge over HTTP, so turning it on while
// the bridge was cold silently did nothing and searches ran plain (fixed 2026-08-18).
const PRO_STATE = path.join(__dirname, '..', 'pro.state');
function readProState() {
  try { return fs.readFileSync(PRO_STATE, 'utf8').trim().toLowerCase() === 'on'; }
  catch (e) { return false; }
}
function writeProState(on) {
  try { fs.writeFileSync(PRO_STATE, on ? 'on' : 'off'); return true; }
  catch (e) { return false; }
}

// The node bridge (port 8765) can be UP while the headless Firefox + extension it drives is
// DEAD -- e.g. right after the one-time sign-in swaps to the visible window, or if Firefox
// crashed. A quick cfbmarker round-trip proves there is a LIVE automation instance to talk
// to; without this check a search after sign-in hangs forever with nothing to answer it.
async function extensionAlive() {
  try {
    const posted = await launcher.postJson('/command', { action: 'cfbmarker', params: {} }, 4000);
    const id = posted && posted.id;
    if (!id) return false;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try { const r = await launcher.getJson('/result/' + id, 3000); if (r && r.done) return true; }
      catch (e) { /* keep polling */ }
      await new Promise((r) => setTimeout(r, 300));
    }
  } catch (e) { /* fall through */ }
  return false;
}

async function ensureBridge() {
  // Bridge up AND its browser actually answering -> ready.
  if (await launcher.bridgeUp()) {
    if (await extensionAlive()) return true;
    // Bridge up but the browser behind it is dead -> full relaunch (SELF-HEAL, no manual step).
    const r = await launcher.start(false);
    return r.ok || (await launcher.bridgeUp());
  }
  const r = await launcher.start(false);
  return r.ok || (await launcher.bridgeUp());
}

async function bridgeCmd(action, params, timeoutMs) {
  timeoutMs = timeoutMs || 80000;
  if (!(await ensureBridge())) {
    throw new Error('Could not start Firefox. Make sure Firefox is installed on this ' +
                    'computer, then try again.');
  }
  const posted = await launcher.postJson('/command', { action, params: params || {} }, 10000);
  const id = posted && posted.id;
  if (!id) throw new Error('the bridge rejected the command');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await launcher.getJson('/result/' + id, 5000);
      if (r && r.done) return r;
    } catch (e) { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("timed out waiting for '" + action + "'");
}

function asText(res) {
  const r = (res && typeof res === 'object' && 'result' in res) ? res.result : res;
  if (r && typeof r === 'object') {
    return (r.text || r.html || JSON.stringify(r)).slice(0, 20000);
  }
  return String(r).slice(0, 20000);
}

// Annotations are required by the connectors-directory review: every tool must declare
// whether it only reads, or can change something.
const TOOLS = [
  {
    name: 'google_search',
    description: 'Search Google through your own Firefox and return the answer text. Uses ' +
                 'your own browser and your own Google account; nothing is sent anywhere else. ' +
                 'If Pro searching is switched on, this uses Google AI Mode.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to search for' } },
      required: ['query']
    },
    annotations: { title: 'Google search', readOnlyHint: true, destructiveHint: false,
                   idempotentHint: false, openWorldHint: true }
  },
  {
    name: 'set_pro_searching',
    description: 'Turn Google AI Pro searching on or off. Off by default, because AI Pro is a ' +
                 'paid Google plan and not everyone has one. Turning it on makes searches use ' +
                 'Google AI Mode with whatever plan your own account has. Takes effect ' +
                 'immediately, no restart. Say "turn on Pro searching" or ' +
                 '"turn off Pro searching".',
    inputSchema: {
      type: 'object',
      properties: { on: { type: 'boolean', description: 'true to turn Pro searching on, false for plain Google' } },
      required: ['on']
    },
    annotations: { title: 'Pro searching on/off', readOnlyHint: false, destructiveHint: false,
                   idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'get_pro_searching',
    description: 'Report whether Google AI Pro searching is currently on or off.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'Pro searching status', readOnlyHint: true, destructiveHint: false,
                   idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'firefox_navigate',
    description: 'Open a URL in your Firefox and return the final URL.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The URL to open' } },
      required: ['url']
    },
    annotations: { title: 'Open a page', readOnlyHint: false, destructiveHint: false,
                   idempotentHint: true, openWorldHint: true }
  },
  {
    name: 'firefox_get_text',
    description: 'Return the visible text of the page currently open in your Firefox.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'Read page text', readOnlyHint: true, destructiveHint: false,
                   idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'firefox_read_page',
    description: 'Return a structured reading of the current Firefox page, including its ' +
                 'clickable elements.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'Read page structure', readOnlyHint: true, destructiveHint: false,
                   idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'firefox_start',
    description: 'Start the local Firefox bridge if it is not already running. Runs hidden; ' +
                 'your normal Firefox is not touched.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'Start the bridge', readOnlyHint: false, destructiveHint: false,
                   idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'sign_in_to_google',
    description: 'One-time activation. Opens a visible Firefox window on the connector\'s own ' +
                 'profile at the Google sign-in page. Sign in to the Google account that has ' +
                 'AI Pro, then close the window — the connector stays signed in for every ' +
                 'search after that and never copies or sees your password. Say "sign in to ' +
                 'Google" or "activate the connector".',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'Sign in to Google (one-time)', readOnlyHint: false,
                   destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  {
    name: 'restart_firefox_bridge',
    description: 'Restart the hidden browser on its existing signed-in profile (keeps your ' +
                 'login). Use only if searches get stuck. If it comes back signed out, say ' +
                 '"sign in to Google" instead. Say "restart the Firefox bridge".',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'Restart the bridge', readOnlyHint: false, destructiveHint: false,
                   idempotentHint: true, openWorldHint: false }
  }
];

async function callTool(name, args) {
  args = args || {};
  if (name === 'set_pro_searching') {
    const on = !!args.on;
    const saved = writeProState(on);                          // persist to disk - reliable even if the bridge is not up yet
    launcher.postJson('/pro', { on }, 4000).catch(() => {});  // best-effort: keep an already-running bridge in sync too
    if (!saved) {
      return 'Could not save the Pro searching setting (the extension folder is not ' +
             'writable), so it is unchanged.';
    }
    return on
      ? 'Google AI Pro searching is ON, and it stays on for every search until you turn ' +
        'it off. Searches use Google AI Mode with your own account.'
      : 'Google AI Pro searching is OFF. Searches will use plain Google. Say "turn on Pro ' +
        'searching" whenever you want it back.';
  }

  if (name === 'get_pro_searching') {
    return readProState()
      ? 'Google AI Pro searching is currently ON.'
      : 'Google AI Pro searching is currently OFF (plain Google).';
  }

  if (name === 'google_search' || name === 'google_pro_search' || name === 'ask_google_pro') {
    const q = String(args.query || '').trim();
    if (!q) throw new Error('query is required');

    // Pro is OFF by default: AI Pro is a paid Google plan and not everyone has one, so
    // nobody gets silently switched into it. Whoever wants it turns it on and it sticks.
    // Read the saved setting straight from disk (not via the bridge), so the right mode is
    // used even on the very first search after turning Pro on, before the bridge is up.
    const pro = readProState();

    const url = 'https://www.google.com/search?q=' + encodeURIComponent(q) + (pro ? '&udm=50' : '');
    await bridgeCmd('navigate', { url }, 60000);

    // AI Mode STREAMS its answer in. Reading the page the instant it loads returns the
    // word "Searching" and nothing else - the user gets a half-answer and assumes the
    // connector is broken. So poll until the text stops growing and the spinner wording
    // is gone. (Caught by the install test on 2026-08-17: a fast cached query hid this,
    // a slower one exposed it.)
    let best = '';
    let stable = 0;
    for (let i = 0; i < 24; i++) {              // up to roughly 36 seconds
      const t = asText(await bridgeCmd('get_text', {}, 30000));
      const working = /\bSearching\b\s*$|\bSearching\.\.\.|\bGenerating\b/.test(t.slice(-160));
      if (t.length > best.length) { best = t; stable = 0; } else { stable++; }
      if (!working && best.length > 220 && stable >= 2) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    // SIGNED-OUT DETECTION. The hidden browser uses a COPY of the user's cookies taken
    // when the profile was built. If their Google session later expires, or the copy was
    // taken while they happened to be signed out, that copy goes on being used and every
    // search silently returns FREE-TIER results while still saying Pro is on. That is
    // exactly what happened on 2026-08-17 and nothing reported it.
    //
    // Google's own header is the tell: a signed-out page offers "Sign in"; a signed-in one
    // does not. Check the header region only - the phrase can legitimately appear deep in
    // page content.
    const header = best.slice(0, 500);
    const signedOut = /\bSign in\b/.test(header);

    if (signedOut) {
      // NO auto-reseed/retry here. A cold browser restart in the middle of a search is what
      // made searches time out. The profile keeps its OWN login now, so the fix is the
      // one-time sign-in, not silently rebuilding the profile on every signed-out search.
      return '[⚠️ NOT SIGNED IN to Google — this is a FREE-TIER answer, not your AI Pro ' +
             'plan.]\n\nThe connector\'s browser is not signed in yet. Say "sign in to Google" ' +
             'once: a Firefox window opens, you sign into the Google account that has AI Pro, ' +
             'close it, and every search after that uses your Pro plan automatically. Your ' +
             'password is only ever typed into Google\'s own page — the connector never sees it.' +
             '\n\n' + best;
    }

    // Always say which mode was used, so the answer is never ambiguous - the whole
    // failure on 2026-08-17 was searches quietly running in the wrong mode and nothing
    // saying so.
    const note = pro
      ? '[Google AI Pro searching: ON — signed in]\n\n'
      : '[Plain Google search. Say "turn on Pro searching" to use Google AI Mode ' +
        'with your own AI Pro plan.]\n\n';
    return note + best;
  }
  if (name === 'firefox_navigate') {
    const res = await bridgeCmd('navigate', { url: args.url || '' }, 60000);
    return JSON.stringify(res.result !== undefined ? res.result : res).slice(0, 4000);
  }
  if (name === 'firefox_get_text') return asText(await bridgeCmd('get_text', {}, 30000));
  if (name === 'firefox_read_page') {
    const res = await bridgeCmd('read_page', {}, 30000);
    return JSON.stringify(res.result !== undefined ? res.result : res).slice(0, 20000);
  }
  if (name === 'firefox_start') {
    return (await ensureBridge()) ? 'Firefox bridge is up and ready.'
                                  : 'Could not start the Firefox bridge. Is Firefox installed?';
  }

  if (name === 'sign_in_to_google' || name === 'activate' || name === 'activate_connector') {
    const r = await launcher.signInStart();
    if (!r.ok) return 'Could not open the sign-in window: ' + r.message;
    return 'A Firefox window just opened at the Google sign-in page. Sign in to the Google ' +
           'account that has AI Pro, wait until it shows you logged in, then close that window. ' +
           'After that just search normally — you will stay signed in and every search uses your ' +
           'AI Pro plan. You should not need to do this again unless Google signs you out. ' +
           '(Your password is typed only into Google\'s own page; the connector never sees it.)';
  }

  if (name === 'restart_firefox_bridge') {
    const r = await launcher.reseedAndRestart();
    if (!r.ok) return 'Could not restart the bridge: ' + r.message;
    // Confirm the persistent profile is still signed in, rather than just saying "restarted".
    try {
      await bridgeCmd('navigate', { url: 'https://www.google.com/search?q=test&udm=50' }, 60000);
      const t = asText(await bridgeCmd('get_text', {}, 30000));
      return /\bSign in\b/.test(t.slice(0, 500))
        ? 'Bridge restarted, but the browser is signed out. Say "sign in to Google" to activate ' +
          'it (one time).'
        : 'Bridge restarted and still signed in to Google. Pro searching will use your own account.';
    } catch (e) {
      return 'Bridge restarted. Could not confirm the sign-in state: ' + e.message;
    }
  }
  throw new Error('unknown tool: ' + name);
}

async function handle(msg) {
  const id = msg.id;
  const method = msg.method;
  const params = msg.params || {};

  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: params.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: VERSION }
    } };
  }
  if (method === 'notifications/initialized' || method === 'initialized') return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    try {
      const text = await callTool(params.name, params.arguments || {});
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
    } catch (e) {
      return { jsonrpc: '2.0', id,
               result: { content: [{ type: 'text', text: 'ERROR: ' + e.message }], isError: true } };
    }
  }
  if (id === undefined || id === null) return null;
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } };
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  let reply;
  try {
    reply = await handle(msg);
  } catch (e) {
    reply = { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } };
  }
  if (reply !== null && reply !== undefined) process.stdout.write(JSON.stringify(reply) + '\n');
});
