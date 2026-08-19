'use strict';
/**
 * Marionette (Firefox's built-in WebDriver automation engine) client.
 *
 * The extension handles click/type/read/scroll/screenshot. The ONE thing an extension
 * content-script cannot do is put a file into an <input type=file> (browsers block it for
 * security). Marionette CAN (WebDriver:ElementSendKeys to a file input). Firefox is launched
 * with -marionette (port 2828) alongside the RDP add-on channel, so both run at once.
 * PROVEN 2026-08-18: sendKeys attached a 409556-byte .mcpb to a file input.
 */
const net = require('net');
const fs = require('fs');
const MARIONETTE_PORT = 2828;
const EL = 'element-6066-11e4-a52e-4f735466cecf';

class Marionette {
  constructor(port = MARIONETTE_PORT, host = '127.0.0.1') {
    this.port = port; this.host = host;
    this.buf = Buffer.alloc(0); this.msgId = 0; this.pending = new Map(); this.handshake = null; this._hs = null;
  }
  connect() {
    return new Promise((res, rej) => {
      this.sock = net.connect(this.port, this.host);
      this.sock.setNoDelay(true);
      this.sock.on('data', (d) => this._onData(d));
      this.sock.on('error', rej);
      this._hs = res;
      setTimeout(() => rej(new Error('marionette handshake timeout (is Firefox running with -marionette?)')), 10000);
    });
  }
  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const i = this.buf.indexOf(0x3a);
      if (i < 0) break;
      const lenStr = this.buf.slice(0, i).toString('ascii');
      if (!/^\d+$/.test(lenStr)) { this.buf = this.buf.slice(i + 1); continue; }
      const len = parseInt(lenStr, 10);
      if (this.buf.length < i + 1 + len) break;
      const payload = this.buf.slice(i + 1, i + 1 + len).toString('utf8');
      this.buf = this.buf.slice(i + 1 + len);
      let msg; try { msg = JSON.parse(payload); } catch (e) { continue; }
      if (!this.handshake && !Array.isArray(msg)) { this.handshake = msg; if (this._hs) this._hs(msg); continue; }
      if (Array.isArray(msg) && msg[0] === 1) {
        const p = this.pending.get(msg[1]);
        if (p) { this.pending.delete(msg[1]); msg[2] ? p.rej(new Error(JSON.stringify(msg[2]))) : p.res(msg[3]); }
      }
    }
  }
  send(name, params = {}, timeoutMs = 45000) {
    return new Promise((res, rej) => {
      const id = ++this.msgId;
      const json = JSON.stringify([0, id, name, params]);
      const frame = Buffer.byteLength(json, 'utf8') + ':' + json;
      const to = setTimeout(() => { this.pending.delete(id); rej(new Error('marionette timeout: ' + name)); }, timeoutMs);
      this.pending.set(id, { res: (v) => { clearTimeout(to); res(v); }, rej: (e) => { clearTimeout(to); rej(e); } });
      this.sock.write(frame);
    });
  }
  newSession() { return this.send('WebDriver:NewSession', {}); }
  navigate(url) { return this.send('WebDriver:Navigate', { url }, 90000); }
  async script(js, args = []) { const r = await this.send('WebDriver:ExecuteScript', { script: js, args }); return r && r.value; }
  async findEl(using, value) { const r = await this.send('WebDriver:FindElement', { using, value }); return r && r.value; }
  key(elId) { return elId && (elId[EL] || elId.ELEMENT || elId); }
  sendKeysEl(elId, text) { const k = this.key(elId); return this.send('WebDriver:ElementSendKeys', { id: k, [EL]: k, text }); }
  clickEl(elId) { const k = this.key(elId); return this.send('WebDriver:ElementClick', { id: k, [EL]: k }); }
  close() { try { this.sock.end(); } catch (e) {} }
}

// Attach a local file to a file-upload field on the CURRENT page.
async function uploadFile(filePath, selector) {
  if (!filePath) return 'firefox_upload: no file path given.';
  if (!fs.existsSync(filePath)) return 'firefox_upload: file not found on disk: ' + filePath;
  const m = new Marionette();
  try {
    await m.connect();
    try { await m.newSession(); } catch (e) { /* a session may already exist - reuse it */ }
    const sel = selector || 'input[type=file]';
    let el = null;
    try { el = await m.findEl('css selector', sel); } catch (e) {}
    if (!el && !selector) { try { el = await m.findEl('css selector', 'input[type="file"]'); } catch (e) {} }
    if (!el) { m.close(); return 'firefox_upload: no file input found on the current page' + (selector ? ' for "' + selector + '"' : '') + '. (A Google-Forms "Add file" button opens a Drive picker, not a plain input - that needs the picker flow.)'; }
    await m.sendKeysEl(el, filePath);
    let info = null;
    try { info = await m.script('var f=document.querySelector(arguments[0]); return f&&f.files&&f.files.length?(f.files[0].name+" ("+f.files[0].size+" bytes)"):null;', [sel]); } catch (e) {}
    m.close();
    return info ? ('Attached file: ' + info) : 'firefox_upload: file sent to the input; could not confirm the attachment.';
  } catch (e) {
    try { m.close(); } catch (_) {}
    return 'firefox_upload error: ' + e.message;
  }
}

module.exports = { uploadFile, Marionette, MARIONETTE_PORT };
