'use strict';
/**
 * Claude Firefox Bridge - local command mailbox.
 *
 * Bentaco the Destroyer's Firefox connector.
 *
 * The Firefox extension short-polls GET /poll and POSTs results to /result.
 * The MCP server POSTs to /command and reads GET /result/<id>.
 *
 * Node, standard library only - no npm install, no Perl, no Git Bash, no Python.
 * Node ships with Claude, so this works on a fresh machine with nothing installed.
 *
 * Every hard-won behaviour from the original is preserved deliberately:
 *   * GENERATION FENCING - a reloaded background page bumps the generation and any
 *     older (zombie) poll loop gets 410 and halts. Without it two consumers drain the
 *     same single-consumer queue and commands vanish.
 *   * AT-LEAST-ONCE DELIVERY - /poll moves a command in-flight, /ack clears it, and
 *     anything un-acked for 35s is re-queued. Do NOT eagerly requeue on register:
 *     that double-executes commands.
 *   * SCREENSHOTS TO DISK - a returned png is written to ../shots and replaced with a
 *     path, rather than pushing a huge base64 blob back through the tool result.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.argv[2] || '8765', 10);
const REDELIVER_AFTER = 35000; // ms before an un-acked command goes to someone else

const HERE = __dirname;
const PKG = path.dirname(HERE);
const SHOTS = path.join(PKG, 'shots');
const PRO_STATE = path.join(PKG, 'pro.state');

try { fs.mkdirSync(SHOTS, { recursive: true }); } catch (e) {}

let queue = [];             // commands waiting for the extension
const results = new Map();  // id -> result
const inFlight = new Map(); // id -> {cmd, ts}
let generation = 0;
let counter = 0;

function readPro() {
  // DEFAULT OFF. Google AI Pro is a paid plan and not every user has one - nobody gets
  // silently switched into a mode they aren't paying for, and nobody's results quietly
  // change without them asking. Whoever wants it turns it on once and it sticks.
  try {
    return fs.readFileSync(PRO_STATE, 'utf8').trim().toLowerCase() === 'on';
  } catch (e) {
    return false;
  }
}

function writePro(on) {
  try { fs.writeFileSync(PRO_STATE, on ? 'on' : 'off'); } catch (e) {}
}

function send(res, code, ctype, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(code, {
    'Content-Type': ctype,
    'Content-Length': buf.length,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Connection': 'close'
  });
  res.end(buf);
}

function sendJson(res, code, obj) {
  send(res, code, 'application/json', JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 64 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;
  const qp = u.searchParams;
  const method = req.method || 'GET';

  if (method === 'OPTIONS') return send(res, 204, 'text/plain', '');

  if (method === 'GET' && p === '/health') {
    return sendJson(res, 200, {
      ok: true, queued: queue.length, pending_results: results.size, port: PORT
    });
  }

  if (p === '/register_generation') {
    // A fresh background page announces itself: bump the generation so any older
    // zombie poll loop gets 410 and dies. Do NOT requeue in-flight work here - if the
    // old consumer finishes and acks it is done; if it died the reaper redelivers.
    generation += 1;
    return sendJson(res, 200, { generation });
  }

  if (method === 'GET' && p === '/poll') {
    const cg = parseInt(qp.get('generation') || '-1', 10);
    if (generation > 0 && (isNaN(cg) || cg < generation)) {
      return sendJson(res, 410, { error: 'ZOMBIE_REJECTED', generation });
    }
    const now = Date.now();
    for (const [id, v] of [...inFlight.entries()]) {
      if (now - v.ts > REDELIVER_AFTER) { inFlight.delete(id); queue.unshift(v.cmd); }
    }
    if (queue.length) {
      const cmd = queue.shift();
      inFlight.set(cmd.id, { cmd, ts: Date.now() });
      return sendJson(res, 200, cmd);
    }
    return send(res, 200, 'application/json', '{}');
  }

  if (p === '/ack') {
    const id = qp.get('id');
    if (id !== null) { inFlight.delete(parseInt(id, 10)); inFlight.delete(id); }
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && p === '/command') {
    const data = await readBody(req);
    counter += 1;
    const id = counter;
    queue.push({ id, action: data.action || '', params: data.params || {} });
    return sendJson(res, 200, { id });
  }

  if (method === 'POST' && p === '/result') {
    const data = await readBody(req);
    if (data.id === undefined || data.id === null) {
      return sendJson(res, 400, { error: 'missing id' });
    }
    let result = data.result;
    if (result && typeof result === 'object' && result.png_base64) {
      // Write the screenshot out and hand back a path instead of a huge blob.
      try {
        const file = path.join(SHOTS, 'shot-' + data.id + '.png');
        fs.writeFileSync(file, Buffer.from(result.png_base64, 'base64'));
        delete result.png_base64;
        result.png_path = file;
      } catch (e) {
        delete result.png_base64;
        result.error = 'could not write screenshot: ' + e.message;
      }
    }
    results.set(parseInt(data.id, 10), result);
    return sendJson(res, 200, { ok: true });
  }

  const m = p.match(/^\/result\/(\d+)$/);
  if (method === 'GET' && m) {
    const id = parseInt(m[1], 10);
    if (results.has(id)) {
      const r = results.get(id);
      results.delete(id);
      return sendJson(res, 200, { done: true, result: r });
    }
    return sendJson(res, 200, { done: false });
  }

  if (method === 'GET' && p === '/pro') return sendJson(res, 200, { on: readPro() });

  if (method === 'POST' && p === '/pro') {
    const data = await readBody(req);
    writePro(!!data.on);
    return sendJson(res, 200, { ok: true, on: !!data.on });
  }

  if (method === 'GET' && (p === '/' || p === '/favicon.ico')) {
    return send(res, 200, 'text/plain', 'Claude Firefox Bridge running on port ' + PORT + '\n');
  }

  return sendJson(res, 404, { error: 'no such route', method, path: p });
});

server.listen(PORT, '127.0.0.1');
