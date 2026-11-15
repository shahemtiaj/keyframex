'use strict';
/**
 * Minimal Chrome DevTools Protocol client over a hand-written WebSocket.
 *
 * Why not `ws` / `puppeteer`? The CEP runtime ships an old Node (15/16) and
 * KeyframeX must install with zero npm dependencies. The protocol subset we
 * need (text frames, ping/pong, close, fragmented and 64-bit-length frames)
 * fits in ~150 lines.
 */
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

class WebSocketClient extends EventEmitter {
  constructor(url) {
    super();
    this.url = new URL(url);
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.closed = false;
  }

  connect(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        host: this.url.hostname,
        port: this.url.port,
        path: this.url.pathname + this.url.search,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': key,
        },
      });
      const timer = setTimeout(() => { req.destroy(); reject(new Error('WebSocket connect timeout')); }, timeoutMs);
      req.on('upgrade', (res, socket, head) => {
        clearTimeout(timer);
        const expected = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        if (res.headers['sec-websocket-accept'] !== expected) {
          socket.destroy();
          reject(new Error('WebSocket handshake failed'));
          return;
        }
        this.socket = socket;
        socket.setNoDelay(true);
        socket.on('data', (d) => this._onData(d));
        socket.on('close', () => this._onClose());
        socket.on('error', (e) => this.emit('error', e));
        if (head && head.length) this._onData(head);
        resolve(this);
      });
      req.on('response', (res) => { clearTimeout(timer); reject(new Error('WebSocket upgrade refused: HTTP ' + res.statusCode)); });
      req.on('error', (e) => { clearTimeout(timer); reject(e); });
      req.end();
    });
  }

  send(text) {
    if (!this.socket || this.closed) throw new Error('WebSocket is not open');
    this._sendFrame(0x1, Buffer.from(text, 'utf8'));
  }

  close() {
    if (this.socket && !this.closed) {
      try { this._sendFrame(0x8, Buffer.alloc(0)); } catch (e) { /* ignore */ }
      this.socket.end();
    }
    this.closed = true;
  }

  _sendFrame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
      header.writeUInt32BE(len >>> 0, 6);
    }
    header[0] = 0x80 | opcode;
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  _onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = this.buffer.readUInt32BE(2) * 0x100000000 + this.buffer.readUInt32BE(6);
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLen + len) return;
      let payload = this.buffer.slice(offset + maskLen, offset + maskLen + len);
      if (masked) {
        const m = this.buffer.slice(offset, offset + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3];
      }
      this.buffer = this.buffer.slice(offset + maskLen + len);
      this._onFrame(fin, opcode, payload);
    }
  }

  _onFrame(fin, opcode, payload) {
    if (opcode === 0x8) { this.close(); return; }
    if (opcode === 0x9) { this._sendFrame(0xA, payload); return; }
    if (opcode === 0xA) return;
    if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
      this.fragments.push(payload);
      if (fin) {
        const msg = Buffer.concat(this.fragments).toString('utf8');
        this.fragments = [];
        this.emit('message', msg);
      }
    }
  }

  _onClose() {
    this.closed = true;
    this.emit('close');
  }
}

/** A CDP session bound to one page target. */
class CDPSession extends EventEmitter {
  constructor(ws) {
    super();
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.on('message', (raw) => this._onMessage(raw));
    ws.on('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('Browser connection closed'));
      this.pending.clear();
      this.emit('disconnected');
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocketClient(wsUrl);
    await ws.connect();
    return new CDPSession(ws);
  }

  send(method, params = {}, timeoutMs = 60000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP timeout: ' + method));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
        method,
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  /** Evaluate an expression in the page and return its JSON value. */
  async evaluate(expression, { awaitPromise = true, timeoutMs = 60000 } = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    }, timeoutMs);
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      const msg = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'Page evaluation failed';
      throw new Error(String(msg).split('\n')[0]);
    }
    return res.result ? res.result.value : undefined;
  }

  waitFor(eventName, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.removeListener(eventName, on); reject(new Error('Timed out waiting for ' + eventName)); }, timeoutMs);
      const on = (p) => { clearTimeout(timer); resolve(p); };
      this.once(eventName, on);
    });
  }

  close() { this.ws.close(); }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(p.method + ': ' + msg.error.message));
      else p.resolve(msg.result);
    } else if (msg.method) {
      this.emit(msg.method, msg.params);
    }
  }
}

module.exports = { WebSocketClient, CDPSession };
