/** One WebDriver BiDi session per Firefox process. Node 22+ native WebSocket, no Selenium. */
export class BidiError extends Error {
  constructor(message, code = 'bidi_error') { super(message); this.name = 'BidiError'; this.code = code; }
}

export class BidiClient {
  constructor(url, { timeoutMs = 15000, wsFactory = u => new WebSocket(u) } = {}) {
    if (!/^ws:\/\/127\.0\.0\.1:\d+\/session$/.test(url)) throw new Error('Only localhost Firefox BiDi URLs are allowed');
    this.url = url;
    this.wsFactory = wsFactory;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.seq = 0;
    this.handlers = new Set();
    this.closeHandlers = new Set();
    this.connected = false;
  }
  onEvent(fn) { this.handlers.add(fn); return () => this.handlers.delete(fn); }
  onDisconnect(fn) { this.closeHandlers.add(fn); return () => this.closeHandlers.delete(fn); }
  async connect() {
    if (this.connected) return;
    const ws = this.wsFactory(this.url);
    this.ws = ws;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new BidiError('BiDi connection timed out','unavailable')), this.timeoutMs);
      const open = () => { clearTimeout(timer); resolve(); };
      const fail = () => { clearTimeout(timer); reject(new BidiError('Cannot open Firefox BiDi WebSocket','unavailable')); };
      ws.addEventListener('open', open, { once: true });
      ws.addEventListener('error', fail, { once: true });
    });
    ws.addEventListener('message', evt => this.handleMessage(evt.data));
    ws.addEventListener('close', () => this.onClosed());
    this.connected = true;
    try {
      await this.send('session.new', { capabilities: {} });
      await this.send('session.subscribe', { events: [
        'network.beforeRequestSent','network.responseStarted','network.responseCompleted','network.fetchError',
        'log.entryAdded','browsingContext.contextDestroyed'
      ] });
    } catch (err) { this.close(); throw err; }
  }
  handleMessage(raw) {
    let message; try { message = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch { return; }
    if (message.type === 'event') {
      for (const handler of this.handlers) { try { handler(message); } catch { /* observer only */ } }
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.type === 'success') entry.resolve(message.result);
    else entry.reject(new BidiError(message.message || message.error || 'BiDi error', message.error || 'bidi_error'));
  }
  send(method, params = {}) {
    if (!this.connected || this.ws?.readyState !== 1) throw new BidiError('Firefox connection unavailable','unavailable');
    const id = ++this.seq;
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new BidiError(`BiDi ${method} timed out`, 'timeout')); }, this.timeoutMs);
      this.pending.set(id, {resolve,reject,timer});
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  onClosed() {
    const wasConnected = this.connected;
    this.connected = false;
    if (wasConnected) for (const cb of this.closeHandlers) { try { cb(); } catch {} }
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new BidiError('Browser disconnected','unavailable')); }
    this.pending.clear();
  }
  close() { try { this.ws?.close(); } catch {} this.onClosed(); }
}
