'use strict';
/**
 * Load the bridge extension into Firefox over the Remote Debugging Protocol.
 *
 * WHY RDP and not Marionette: RDP is the same channel web-ext uses and it does NOT set
 * navigator.webdriver, so websites never throw robot-checks at the user. Marionette does.
 *
 * WHY THIS MATTERS FOR SHARING: an add-on loaded this way is a TEMPORARY add-on, which
 * Firefox permits unsigned. Nobody needs a Mozilla developer account, AMO signing or 2FA
 * to use this connector - it simply loads each time the bridge starts.
 *
 * Firefox must be running with -start-debugger-server <port>, on a profile whose user.js
 * enables remote debugging (the launcher writes exactly that).
 */
const net = require('net');

const ADDON_ID = 'claude-firefox-bridge@bentaco.local';

/** RDP framing is <byte-length>:<json-payload>. */
function makeReader(sock) {
  let buf = Buffer.alloc(0);
  const waiters = [];

  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const colon = buf.indexOf(0x3a); // ':'
      if (colon < 0) return;
      const len = parseInt(buf.slice(0, colon).toString('ascii'), 10);
      if (!Number.isFinite(len)) return;
      if (buf.length < colon + 1 + len) return;
      const body = buf.slice(colon + 1, colon + 1 + len).toString('utf8');
      buf = buf.slice(colon + 1 + len);
      let msg;
      try { msg = JSON.parse(body); } catch (e) { msg = {}; }
      const w = waiters.shift();
      if (w) w(msg);
    }
  });

  return function read(timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out reading from the Firefox debugger')),
                           timeoutMs);
      waiters.push((m) => { clearTimeout(t); resolve(m); });
    });
  };
}

function send(sock, obj) {
  const p = Buffer.from(JSON.stringify(obj), 'utf8');
  sock.write(Buffer.from(String(p.length) + ':', 'ascii'));
  sock.write(p);
}

function connect(port, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    (function attempt() {
      const s = net.connect({ host: '127.0.0.1', port }, () => resolve(s));
      s.on('error', () => {
        s.destroy();
        if (Date.now() > deadline) return resolve(null);
        setTimeout(attempt, 500);
      });
    })();
  });
}

/** Install the extension. Resolves {ok, message}. */
async function install(port, extPath) {
  const sock = await connect(port);
  if (!sock) {
    return { ok: false, message: 'could not reach the Firefox debugger on 127.0.0.1:' + port };
  }
  try {
    const read = makeReader(sock);
    await read();                                   // root greeting

    send(sock, { to: 'root', type: 'getRoot' });
    const root = await read();
    const addons = root.addonsActor;
    if (!addons) return { ok: false, message: 'no addonsActor (remote debugging not enabled?)' };

    // Uninstall first to FLUSH the StartupCache bytecode for this fixed add-on id.
    // Temporary RDP installs cache compiled code by id; without this unmount an edited
    // background.js does NOT reload - the old bytecode keeps being served. On a fresh
    // profile it isn't installed yet, so errors here are expected and ignored.
    send(sock, { to: addons, type: 'uninstallTemporaryAddon', addonId: ADDON_ID });
    try { await read(4000); } catch (e) {}

    send(sock, { to: addons, type: 'installTemporaryAddon', addonPath: extPath });
    const res = await read();
    if (res.error) return { ok: false, message: 'installTemporaryAddon failed: ' + JSON.stringify(res) };
    const id = (res.addon && res.addon.id) || res.id || '?';
    return { ok: true, message: 'installed ' + id };
  } catch (e) {
    return { ok: false, message: 'RDP error: ' + e.message };
  } finally {
    try { sock.destroy(); } catch (e) {}
  }
}

module.exports = { install, ADDON_ID };

if (require.main === module) {
  const port = parseInt(process.argv[2] || '6000', 10);
  const ext = process.argv[3] || '';
  install(port, ext).then((r) => {
    console.log((r.ok ? 'OK: ' : 'ERROR: ') + r.message);
    process.exit(r.ok ? 0 : 1);
  });
}
