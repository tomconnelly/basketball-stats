// Data layer. Keeps every table in memory, caches it in localStorage so the
// app opens offline, and (when Supabase is configured) queues writes in an
// outbox that retries until the server accepts them. Remote changes arrive
// through Supabase realtime. Without Supabase, tabs on the same device sync
// through a BroadcastChannel.
import { CONFIG } from './config.js';

const LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/dist/umd/supabase.min.js';
const DATA_KEY = 'bst.data.v1';
const OUTBOX_KEY = 'bst.outbox.v1';
const TABLES = ['players', 'games', 'events'];

const load = (k, d) => {
  try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; }
};
const save = (k, v) => {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('Could not save', k, e); }
};

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => { s.remove(); reject(new Error('Could not load ' + src)); };
    document.head.appendChild(s);
  });
}

// PostgREST errors carry a code; fetch failures don't.
const isNetworkError = (err) => !err.code || /fetch|network|timeout/i.test(err.message || '');

class Store extends EventTarget {
  constructor() {
    super();
    this.remote = !!(CONFIG.supabaseUrl && CONFIG.supabaseAnonKey);
    this.t = { players: new Map(), games: new Map(), events: new Map() };
    const cached = load(DATA_KEY, null);
    if (cached) for (const n of TABLES) for (const r of cached[n] || []) this.t[n].set(r.id, r);
    this.outbox = this.remote ? load(OUTBOX_KEY, []) : [];
    this.connected = false;
    this.loaded = !this.remote;
    this.error = null;
    this.peers = [];
    this.me = null;
    this.sb = null;
    this.flushing = false;
  }

  get(table, id) { return this.t[table].get(id); }
  all(table) { return [...this.t[table].values()]; }
  emit(type = 'change') { this.dispatchEvent(new Event(type)); }

  persist() {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => save(DATA_KEY, {
      players: this.all('players'), games: this.all('games'), events: this.all('events'),
    }), 150);
  }

  // ---- writes -------------------------------------------------------------
  put(table, row) {
    this.write({ table, op: 'put', row });
    return row;
  }

  patch(table, id, changes) {
    const cur = this.t[table].get(id);
    if (!cur) return null;
    const row = { ...cur, ...changes };
    this.write({ table, op: 'put', row });
    return row;
  }

  del(table, id) {
    if (!this.t[table].has(id)) return;
    this.write({ table, op: 'del', id });
  }

  write(op) {
    this.apply(op);
    this.persist();
    this.emit();
    if (this.remote) {
      this.outbox.push(op);
      save(OUTBOX_KEY, this.outbox);
      this.emit('status');
      this.flush();
    } else {
      this.bc?.postMessage({ kind: 'op', op });
    }
  }

  apply(op) {
    if (op.op === 'put') {
      this.t[op.table].set(op.row.id, op.row);
    } else {
      this.t[op.table].delete(op.id);
      if (op.table === 'games') {
        for (const e of this.t.events.values()) if (e.game_id === op.id) this.t.events.delete(e.id);
      }
    }
  }

  // ---- remote sync --------------------------------------------------------
  async flush() {
    if (!this.sb || this.flushing) return;
    this.flushing = true;
    try {
      while (this.outbox.length) {
        const op = this.outbox[0];
        const q = op.op === 'put'
          ? this.sb.from(op.table).upsert(op.row)
          : this.sb.from(op.table).delete().eq('id', op.id);
        const { error } = await q;
        if (error) {
          if (isNetworkError(error)) { this.error = 'offline'; break; }
          console.error('Server rejected change, dropping it', op, error);
          this.error = error.message;
        } else {
          this.error = null;
        }
        this.outbox.shift();
        save(OUTBOX_KEY, this.outbox);
        this.emit('status');
      }
    } finally {
      this.flushing = false;
      this.emit('status');
    }
    if (this.outbox.length) {
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.flush(), 4000);
    }
  }

  async fetchAll(table) {
    const out = [];
    const size = 1000;
    for (let from = 0; ; from += size) {
      const { data, error } = await this.sb.from(table).select('*')
        .order('created_at').order('id').range(from, from + size - 1);
      if (error) throw error;
      out.push(...data);
      if (data.length < size) break;
    }
    return out;
  }

  async refresh() {
    if (!this.sb) return;
    try {
      const [players, games, events] = await Promise.all(TABLES.map((n) => this.fetchAll(n)));
      const fresh = { players, games, events };
      for (const n of TABLES) this.t[n] = new Map(fresh[n].map((r) => [r.id, r]));
      for (const op of this.outbox) this.apply(op); // pending local changes win
      this.loaded = true;
      this.error = null;
      this.persist();
      this.emit();
    } catch (e) {
      console.warn('Refresh failed', e);
      this.error = 'offline';
    }
    this.emit('status');
  }

  onRemoteChange(p) {
    if (!TABLES.includes(p.table)) return;
    const id = p.eventType === 'DELETE' ? p.old?.id : p.new?.id;
    if (!id) return;
    if (this.outbox.some((op) => (op.row?.id ?? op.id) === id)) return; // our pending write wins
    if (p.eventType === 'DELETE') this.apply({ table: p.table, op: 'del', id });
    else this.apply({ table: p.table, op: 'put', row: p.new });
    this.persist();
    this.emit();
  }

  // ---- presence -----------------------------------------------------------
  setPresence(me) {
    this.me = { ...me, device: this.device };
    if (this.pres && this.presReady) this.pres.track(this.me);
    if (this.bc) this.bc.postMessage({ kind: 'presence', me: this.me, at: Date.now() });
  }

  // ---- startup ------------------------------------------------------------
  async init(deviceId) {
    this.device = deviceId;
    if (!this.remote) return this.initLocal();
    this.emit('status');
    try {
      if (!window.supabase) await loadScript(LIB);
    } catch {
      this.error = 'offline';
      this.emit('status');
      setTimeout(() => this.init(deviceId), 8000);
      return;
    }
    this.sb = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, {
      auth: { persistSession: false },
    });

    let everConnected = false;
    this.sb.channel('bst-db')
      .on('postgres_changes', { event: '*', schema: 'public' }, (p) => this.onRemoteChange(p))
      .subscribe((status) => {
        const was = this.connected;
        this.connected = status === 'SUBSCRIBED';
        if (this.connected && !was && everConnected) this.refresh(); // catch up after a drop
        if (this.connected) everConnected = true;
        this.emit('status');
      });

    this.pres = this.sb.channel('bst-presence', { config: { presence: { key: deviceId } } });
    this.pres
      .on('presence', { event: 'sync' }, () => {
        const st = this.pres.presenceState();
        this.peers = Object.entries(st).map(([device, metas]) => ({ ...metas[0], device }));
        this.emit('status');
      })
      .subscribe((status) => {
        this.presReady = status === 'SUBSCRIBED';
        if (this.presReady && this.me) this.pres.track(this.me);
      });

    window.addEventListener('online', () => { this.flush(); this.refresh(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { this.flush(); this.refresh(); }
    });

    await this.refresh();
    this.flush();
  }

  initLocal() {
    if (!('BroadcastChannel' in window)) return;
    this.bc = new BroadcastChannel('bst');
    const seen = new Map();
    const updatePeers = () => {
      const now = Date.now();
      for (const [d, p] of seen) if (now - p.at > 10000) seen.delete(d);
      this.peers = [...(this.me ? [this.me] : []), ...[...seen.values()].map((p) => p.me)];
      this.emit('status');
    };
    this.bc.onmessage = ({ data }) => {
      if (data.kind === 'op') { this.apply(data.op); this.persist(); this.emit(); }
      if (data.kind === 'presence') { seen.set(data.me.device, data); updatePeers(); }
      if (data.kind === 'leave') { seen.delete(data.device); updatePeers(); }
    };
    setInterval(() => {
      if (this.me) this.bc.postMessage({ kind: 'presence', me: this.me, at: Date.now() });
      updatePeers();
    }, 4000);
    window.addEventListener('pagehide', () => this.bc.postMessage({ kind: 'leave', device: this.device }));
  }
}

export const store = new Store();
