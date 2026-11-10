import { CONFIG } from './config.js';
import { store } from './store.js';
import {
  computeLines, sumLines, pct, periodsFor, filterEvents, toCSV, SHOT_LABEL,
} from './stats.js';

// ---- device-local settings ---------------------------------------------------
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  }));

const DEVICE = LS.get('bst.device') || (() => { const d = uuid(); LS.set('bst.device', d); return d; })();
let NAME = LS.get('bst.name', '');
let unlocked = LS.get('bst.unlocked', false) === true;

const UNDO_MAX = 50;
const undoKey = (gid) => `bst.undo.${gid}`;
const getUndo = (gid) => LS.get(undoKey(gid), []);
const setUndo = (gid, s) => LS.set(undoKey(gid), s.slice(-UNDO_MAX));

// ---- UI state (in memory, survives tab switches) ------------------------------
const S = {
  route: { name: 'home' },
  sel: {},            // gameId -> selected player id (sticky)
  ctx: null,          // inline follow-up row: assist / rebound / free throws
  sub: null,          // substitution panel: { out: playerId|null }
  statsMode: 'game',
  sort: { key: 'pts', dir: -1 },
  seasonSort: { key: 'pts', dir: -1 },
  edit: null,         // event being edited
  playerForm: null,   // { id?, number, name }
  newGame: null,
  gameForm: null,
  confirm: null,      // id of a two-tap delete in progress
  flashAt: 0,
};

const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const buzz = (ms = 12) => { try { navigator.vibrate?.(ms); } catch {} };
const todayISO = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
};
const fmtTime = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

let toastTimer;
function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), 1800);
}

// ---- data helpers --------------------------------------------------------------
const byNumber = (a, b) => (parseInt(a.number, 10) || 0) - (parseInt(b.number, 10) || 0) || a.name.localeCompare(b.name);
const players = (all = false) => store.all('players').filter((p) => all || p.active).sort(byNumber);
const player = (id) => store.get('players', id);
const num = (id) => { const p = player(id); return p ? `#${p.number}` : '#?'; };
const firstName = (p) => (p?.name || '').split(' ')[0];
const games = () => store.all('games').sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.created_at.localeCompare(a.created_at));
const game = () => store.get('games', S.route.gameId);
const gameEvents = (gid) => store.all('events').filter((e) => e.game_id === gid)
  .sort((a, b) => a.created_at.localeCompare(b.created_at));

function assistIndex(events) {
  const m = {};
  for (const e of events) if (e.type === 'assist' && e.linked_event_id) m[e.linked_event_id] = e;
  return m;
}

const ACTION_TEXT = { foul: 'foul', turnover: 'turnover', steal: 'steal', block: 'block' };
function evText(e, assists = {}) {
  const p = num(e.player_id);
  switch (e.type) {
    case 'shot': {
      let s = `${p} ${SHOT_LABEL[e.shot_type] || e.shot_type} ${e.made ? 'made' : 'missed'}`;
      const a = e.made && assists[e.id];
      if (a) s += `, assist ${num(a.player_id)}`;
      return s;
    }
    case 'free_throw': return `${p} free throw ${e.made ? 'made' : 'missed'}`;
    case 'rebound': return `${p} ${e.rebound_type === 'offensive' ? 'offensive' : 'defensive'} rebound`;
    case 'assist': {
      const shot = e.linked_event_id && store.get('events', e.linked_event_id);
      return shot ? `${p} assist on ${num(shot.player_id)} ${SHOT_LABEL[shot.shot_type]}` : `${p} assist`;
    }
    default: return `${p} ${ACTION_TEXT[e.type] || e.type}`;
  }
}

function addEvent(fields) {
  const g = game();
  const ev = {
    id: uuid(), game_id: g.id, period: g.period, player_id: null, type: null,
    shot_type: null, made: null, rebound_type: null, linked_event_id: null,
    created_at: new Date().toISOString(), device_id: DEVICE, coach: NAME || null,
    ...fields,
  };
  store.put('events', ev);
  const stack = getUndo(g.id);
  stack.push(ev.id);
  setUndo(g.id, stack);
  S.flashAt = Date.now();
  return ev;
}

// Deleting a shot also removes the assist hanging off it.
function deleteEvent(ev) {
  for (const e of store.all('events')) {
    if (e.type === 'assist' && e.linked_event_id === ev.id) store.del('events', e.id);
  }
  store.del('events', ev.id);
}

function setOnCourt(g, onCourt) {
  const played = [...new Set([...(g.played || []), ...onCourt])];
  store.patch('games', g.id, { on_court: onCourt, played });
  if (!onCourt.includes(S.sel[g.id])) S.sel[g.id] = null;
}

// ---- actions ------------------------------------------------------------------
function needPlayer() {
  const id = S.sel[S.route.gameId];
  if (!id) { toast('Tap a player first'); buzz(40); return null; }
  return id;
}

const A = {
  // live
  select({ id }) { S.sel[S.route.gameId] = S.sel[S.route.gameId] === id ? null : id; },
  shot({ shot, made }) {
    const pid = needPlayer(); if (!pid) return;
    const ok = made === '1';
    const ev = addEvent({ type: 'shot', player_id: pid, shot_type: shot, made: ok });
    S.ctx = ok ? { kind: 'assist', shotId: ev.id, shooter: pid }
      : { kind: 'rebound', shotId: ev.id, rtype: 'offensive' };
  },
  quick({ type, rtype }) {
    const pid = needPlayer(); if (!pid) return;
    S.ctx = null;
    addEvent({ type, player_id: pid, rebound_type: rtype || null });
  },
  assist({ id }) {
    if (S.ctx?.kind !== 'assist') return;
    addEvent({ type: 'assist', player_id: id, linked_event_id: S.ctx.shotId });
    S.ctx = null;
  },
  rebound({ id }) {
    if (S.ctx?.kind !== 'rebound') return;
    addEvent({ type: 'rebound', player_id: id, rebound_type: S.ctx.rtype, linked_event_id: S.ctx.shotId });
    S.ctx = null;
  },
  rtype({ v }) { if (S.ctx?.kind === 'rebound') S.ctx.rtype = v; },
  ftStart() {
    const pid = needPlayer(); if (!pid) return;
    S.ctx = { kind: 'ftcount', player: pid };
  },
  ftCount({ n }) { S.ctx = { kind: 'ft', player: S.ctx.player, total: +n, i: 1 }; },
  ft({ made }) {
    const c = S.ctx; if (c?.kind !== 'ft') return;
    const ok = made === '1';
    const ev = addEvent({ type: 'free_throw', player_id: c.player, made: ok });
    if (c.i < c.total) c.i++;
    else S.ctx = ok ? null : { kind: 'rebound', shotId: ev.id, rtype: 'offensive' };
  },
  ctxClose() { S.ctx = null; },
  undo() {
    const gid = S.route.gameId;
    const stack = getUndo(gid);
    while (stack.length) {
      const ev = store.get('events', stack.pop());
      if (ev && ev.game_id === gid) {
        const text = evText(ev, assistIndex(gameEvents(gid)));
        deleteEvent(ev);
        setUndo(gid, stack);
        S.ctx = null;
        toast(`Undone: ${text}`);
        return;
      }
    }
    setUndo(gid, stack);
    toast('Nothing to undo');
  },
  period({ p }) { store.patch('games', S.route.gameId, { period: p }); S.ctx = null; },
  addOT() {
    const g = game();
    const ot = (g.ot || 0) + 1;
    store.patch('games', g.id, { ot, period: 'OT' + ot });
    S.ctx = null;
  },
  subOpen() { S.sub = { out: null }; },
  subClose() { S.sub = null; },
  subOut({ id }) { S.sub.out = S.sub.out === id ? null : id; },
  subIn({ id }) {
    const g = game();
    const on = [...(g.on_court || [])];
    if (S.sub.out) {
      on[on.indexOf(S.sub.out)] = id;
      toast(`${num(id)} on for ${num(S.sub.out)}`);
      S.sub.out = null;
    } else if (on.length < 5) {
      on.push(id);
    } else {
      toast('Tap a player on court first'); return;
    }
    setOnCourt(g, on);
  },
  subBench() {
    const g = game();
    setOnCourt(g, (g.on_court || []).filter((x) => x !== S.sub.out));
    S.sub.out = null;
  },

  // navigation
  go({ to }) { location.hash = to; },
  tab({ to }) { location.replace('#' + to); },

  // stats
  statsMode({ v }) { S.statsMode = v; },
  sort({ k, which }) {
    const s = which === 'season' ? S.seasonSort : S.sort;
    if (s.key === k) s.dir *= -1; else { s.key = k; s.dir = k === 'name' ? 1 : -1; }
  },

  // log
  editEvent({ id }) { S.edit = { ...store.get('events', id) }; },
  editClose() { S.edit = null; },
  editSave() {
    const e = S.edit;
    if (e.type !== 'shot') e.shot_type = null;
    if (e.type !== 'shot' && e.type !== 'free_throw') e.made = null;
    if (e.type !== 'rebound') e.rebound_type = null;
    if (e.type === 'shot' && !e.shot_type) e.shot_type = 'two';
    if ((e.type === 'shot' || e.type === 'free_throw') && e.made == null) e.made = true;
    if (e.type === 'rebound' && !e.rebound_type) e.rebound_type = 'defensive';
    store.put('events', e);
    if (!(e.type === 'shot' && e.made)) {
      for (const x of store.all('events')) if (x.type === 'assist' && x.linked_event_id === e.id) store.del('events', x.id);
    }
    S.edit = null;
    toast('Event updated');
  },
  editSet({ f, v }) {
    S.edit[f] = v === 'true' ? true : v === 'false' ? false : v;
  },
  delEvent({ id }) {
    if (S.confirm !== id) { S.confirm = id; return; }
    const ev = store.get('events', id);
    if (ev) deleteEvent(ev);
    S.confirm = null;
    S.edit = null;
    toast('Event deleted');
  },

  // players
  playerNew() { S.playerForm = { number: '', name: '' }; },
  playerEdit({ id }) { const p = player(id); S.playerForm = { id, number: p.number, name: p.name }; },
  playerCancel() { S.playerForm = null; },
  playerRemove({ id }) {
    if (S.confirm !== id) { S.confirm = id; return; }
    store.patch('players', id, { active: false });
    S.confirm = null;
    S.playerForm = null;
  },
  playerRestore({ id }) { store.patch('players', id, { active: true }); },

  // new game
  ngFormat({ v }) { S.newGame.format = v; },
  ngToggle({ id }) {
    const f = S.newGame.five;
    const i = f.indexOf(id);
    if (i >= 0) f.splice(i, 1);
    else if (f.length < 5) f.push(id);
    else toast('Five already picked');
  },

  // game settings
  gameFormat({ v }) { S.gameForm.format = v; },
  gameDelete() {
    const g = game();
    if (S.confirm !== g.id) { S.confirm = g.id; return; }
    store.del('games', g.id);
    S.confirm = null;
    location.hash = '#/';
    toast('Game deleted');
  },

  exportBox() { exportGameCSV(game(), false); },
  exportEvents() { exportGameCSV(game(), true); },
  exportSeason() { exportSeasonCSV(); },
  rename() { unlocked = false; render(); },
};

const FORMS = {
  unlock(fd) {
    if (fd.get('code') !== CONFIG.accessCode) { toast('Wrong code'); buzz(80); return; }
    NAME = (fd.get('name') || '').trim().slice(0, 24);
    LS.set('bst.name', NAME);
    LS.set('bst.unlocked', true);
    unlocked = true;
    store.setPresence(presence());
  },
  player(fd) {
    const number = (fd.get('number') || '').trim();
    const name = (fd.get('name') || '').trim();
    if (!name) { toast('Name needed'); return; }
    const f = S.playerForm;
    if (f.id) store.patch('players', f.id, { number, name });
    else store.put('players', { id: uuid(), number, name, active: true, created_at: new Date().toISOString() });
    toast(f.id ? 'Player saved' : `Added #${number} ${name}`);
    S.playerForm = f.id ? null : { number: '', name: '' };
    if (!f.id) setTimeout(() => document.querySelector('input[name=number]')?.focus(), 0);
  },
  newGame(fd) {
    const ng = S.newGame;
    const opponent = (fd.get('opponent') || '').trim();
    if (!opponent) { toast('Opponent name needed'); return; }
    const g = {
      id: uuid(), date: fd.get('date') || todayISO(), opponent, format: ng.format,
      period: ng.format === 'halves' ? 'H1' : 'Q1', ot: 0,
      on_court: [...ng.five], played: [...ng.five], created_at: new Date().toISOString(),
    };
    store.put('games', g);
    S.newGame = null;
    location.hash = `#/g/${g.id}`;
  },
  game(fd) {
    const g = game();
    const format = S.gameForm.format;
    const changes = { opponent: (fd.get('opponent') || '').trim() || g.opponent, date: fd.get('date') || g.date, format };
    if (format !== g.format && /^[QH]/.test(g.period)) changes.period = format === 'halves' ? 'H1' : 'Q1';
    store.patch('games', g.id, changes);
    S.gameForm = null;
    toast('Game saved');
  },
};

// ---- event wiring -------------------------------------------------------------
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-a]');
  if (!b || b.disabled) return;
  const fn = A[b.dataset.a];
  if (!fn) return;
  e.preventDefault();
  buzz();
  if (S.confirm && b.dataset.a !== 'delEvent' && b.dataset.a !== 'playerRemove' && b.dataset.a !== 'gameDelete') S.confirm = null;
  fn({ ...b.dataset }, b);
  render();
});

document.addEventListener('submit', (e) => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  buzz();
  FORMS[f.dataset.form](new FormData(f));
  render();
});

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-edit]');
  if (el && S.edit) { A.editSet({ f: el.dataset.edit, v: el.value }); render(); }
});

// Remember form drafts so a re-render doesn't wipe what's being typed.
document.addEventListener('input', (e) => {
  const el = e.target;
  const form = el.form?.dataset.form;
  if (form === 'newGame' && S.newGame) S.newGame[el.name] = el.value;
  if (form === 'player' && S.playerForm) S.playerForm[el.name] = el.value;
  if (form === 'game' && S.gameForm) S.gameForm[el.name] = el.value;
});

// Remote changes re-render the screen, but never mid-tap or mid-typing:
// replacing a button between touch start and end would swallow the tap.
let pointerDown = false;
let pendingRender = false;
const typing = () => /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
function softRender() {
  if (pointerDown || typing()) {
    pendingRender = true;
    // the sync badge is safe to update in place even while the screen waits
    for (const el of document.querySelectorAll('.sync')) el.outerHTML = statusDot();
    return;
  }
  render();
}
function flushRender() {
  if (!pendingRender || pointerDown || typing()) return;
  pendingRender = false;
  render();
}
document.addEventListener('pointerdown', () => { pointerDown = true; }, true);
const up = () => { pointerDown = false; setTimeout(flushRender, 80); };
document.addEventListener('pointerup', up, true);
document.addEventListener('pointercancel', up, true);
document.addEventListener('focusout', () => setTimeout(flushRender, 50));

store.addEventListener('change', softRender);
store.addEventListener('status', softRender);

function parseRoute() {
  const p = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (p[0] === 'g' && p[1]) return { name: p[2] || 'live', gameId: p[1] };
  if (['players', 'new', 'season', 'about'].includes(p[0])) return { name: p[0] };
  return { name: 'home' };
}
function presence() {
  return { name: NAME || 'Coach', game: S.route.gameId || null };
}
window.addEventListener('hashchange', () => {
  const prev = S.route;
  S.route = parseRoute();
  S.confirm = null;
  S.edit = null;
  if (prev.gameId !== S.route.gameId) { S.ctx = null; S.sub = null; S.gameForm = null; }
  if (S.route.name === 'new' && !S.newGame) S.newGame = { date: todayISO(), opponent: '', format: 'quarters', five: [] };
  store.setPresence(presence());
  render();
  if (!(prev.gameId && prev.gameId === S.route.gameId)) window.scrollTo(0, 0);
});

// ---- rendering ------------------------------------------------------------------
function render() {
  const keep = [...document.querySelectorAll('[data-keep]')].map((el) => [el.dataset.keep, el.scrollLeft, el.scrollTop]);
  $app.innerHTML = unlocked ? view() : viewGate();
  for (const [k, l, t] of keep) {
    const el = document.querySelector(`[data-keep="${k}"]`);
    if (el) { el.scrollLeft = l; el.scrollTop = t; }
  }
  document.body.classList.toggle('on-live', unlocked && S.route.name === 'live' && !!game());
}

function view() {
  const r = S.route;
  if (r.gameId) {
    const g = game();
    if (!g) return store.loaded ? viewMissing() : viewLoading();
    if (r.name === 'stats') return viewStats(g);
    if (r.name === 'log') return viewLog(g);
    if (r.name === 'summary') return viewSummary(g);
    return viewLive(g);
  }
  if (r.name === 'players') return viewPlayers();
  if (r.name === 'new') return viewNewGame();
  if (r.name === 'season') return viewSeason();
  if (r.name === 'about') return viewAbout();
  return viewHome();
}

function statusDot() {
  if (!store.remote) return '<span class="sync local" title="Local mode: data stays on this device">Local</span>';
  const n = store.outbox.length;
  if (n) return `<span class="sync pending">${n} to sync</span>`;
  if (!store.connected) return '<span class="sync off">Offline</span>';
  return '<span class="sync ok">Synced</span>';
}

function peersChip(gid) {
  const others = store.peers.filter((p) => p.device !== DEVICE && (!gid || p.game === gid));
  if (!others.length) return '';
  const names = others.map((p) => esc(p.name || 'Coach')).join(', ');
  return `<span class="peers" title="Also here: ${names}">👥 ${names}</span>`;
}

function header(title, back = '#/', extra = '') {
  return `<header class="top">
    ${back ? `<button class="icon" data-a="go" data-to="${back}" aria-label="Back">‹</button>` : ''}
    <h1>${title}</h1>
    <div class="top-r">${extra}${statusDot()}</div>
  </header>`;
}

function gameTabs(g, active) {
  const t = (name, label, path) => `<button class="${active === name ? 'on' : ''}" data-a="tab" data-to="/g/${g.id}${path}">${label}</button>`;
  return `<nav class="tabs">${t('live', 'Live', '')}${t('stats', 'Stats', '/stats')}${t('log', 'Log', '/log')}${t('summary', 'Summary', '/summary')}</nav>`;
}

const viewLoading = () => `${header('Loading…')}<main class="pad"><p class="muted">Loading data…</p></main>`;
const viewMissing = () => `${header('Not found')}<main class="pad"><p class="muted">That game doesn't exist (it may have been deleted).</p></main>`;

function viewGate() {
  return `<main class="gate">
    <div class="logo">🏀</div>
    <h1>Stats Tracker</h1>
    <form data-form="unlock" autocomplete="off">
      <input name="code" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="Team code" required>
      <input name="name" placeholder="Your name (shown to other coaches)" value="${esc(NAME)}" maxlength="24">
      <button class="btn primary big">Enter</button>
    </form>
  </main>`;
}

// ---- home ----
function viewHome() {
  const gs = games();
  const rows = gs.map((g) => {
    const evs = gameEvents(g.id);
    const pts = sumLines(Object.values(computeLines(evs))).pts;
    return `<li class="card game">
      <button class="game-main" data-a="go" data-to="#/g/${g.id}">
        <span class="g-opp">vs ${esc(g.opponent)}</span>
        <span class="g-meta">${fmtDate(g.date)} · ${evs.length ? `${pts} pts` : 'not started'}</span>
      </button>
      <button class="btn small" data-a="go" data-to="#/g/${g.id}/summary">Summary</button>
    </li>`;
  }).join('');
  return `${header('Stats Tracker', '', peersChip())}
  <main class="pad">
    <div class="home-actions">
      <button class="btn primary big" data-a="go" data-to="#/new">+ New game</button>
      <button class="btn big" data-a="go" data-to="#/players">Players (${players().length})</button>
      <button class="btn big" data-a="go" data-to="#/season">Season</button>
      <button class="btn about-btn" data-a="go" data-to="#/about">ⓘ How this app works</button>
    </div>
    <h2>Games</h2>
    ${gs.length ? `<ul class="list">${rows}</ul>` : '<p class="muted">No games yet. Add your players, then start a new game.</p>'}
    <p class="foot muted">${store.remote ? 'Live sync on' : 'Local mode: data is stored on this device only. Add Supabase keys in js/config.js to sync between coaches.'}
      · You're <b>${esc(NAME || 'Coach')}</b> <button class="link" data-a="rename">change</button></p>
  </main>`;
}

// ---- about ----
const ABOUT = [
  ['Built for the bench', [
    'Log stats while you watch the game.',
    'Most actions take one or two taps.',
    'Nothing to save or confirm. Every tap saves instantly.',
  ]],
  ['Simple on purpose', [
    'This is version 1.',
    'It tracks one team: ours. No opposition stats.',
    'No shot charts, game clock or opponent score yet.',
    'Fewer buttons means faster, more accurate logging.',
    'New features come once the basics prove themselves in real games.',
  ]],
  ['Logging a game', [
    'Tap a player. They stay selected for the next action.',
    'Tap made or missed for a three, two or layup.',
    'After a make, tap who assisted. After a miss, tap who rebounded. Both are optional.',
    'Free throws: tap Free throws, pick how many, then made or missed for each.',
    'Fouls, turnovers, steals, blocks and rebounds: one tap.',
  ]],
  ['Fixing mistakes', [
    'Undo steps back through your recent actions, one at a time.',
    'The Log tab lets you edit or delete any event.',
    'All stats are worked out from the event list, so a fix updates everything.',
  ]],
  ['Several coaches at once', [
    'Everyone sees the same game, live.',
    'Names at the top show who else has the game open.',
    'Agree who logs what. For example, one coach on shots, one on rebounds.',
    'Undo only removes your own entries.',
  ]],
  ['Bad signal?', [
    'Taps save on your phone first.',
    'They upload when the connection comes back.',
    'The badge shows Synced, “to sync”, or Offline.',
  ]],
  ['In-game decisions', [
    'Stats is one tap from Live. Your selected player and quarter stay put.',
    'Hot hand: whole game, this quarter, or the last 5 minutes of play.',
    'Tap any column to sort.',
    'Each player tile shows points and fouls. Fouls turn amber at 4.',
  ]],
  ['After the game', [
    'Summary: box score, shooting by quarter and top performers.',
    'Export to CSV for spreadsheets.',
    'Season: totals and averages across every game.',
  ]],
  ['Access', [
    'The team code keeps casual visitors out.',
    'It is not strong security, so don\u2019t store anything sensitive.',
  ]],
];

function viewAbout() {
  return `${header('How it works')}
  <main class="pad about">
    ${ABOUT.map(([h, lines]) => `<section><h2>${h}</h2><ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul></section>`).join('')}
    <button class="btn primary big wide" data-a="go" data-to="#/">Got it</button>
  </main>`;
}

// ---- players ----
function viewPlayers() {
  const f = S.playerForm;
  const form = f ? `<form class="card form" data-form="player" autocomplete="off">
      <div class="row">
        <input name="number" class="num-in" inputmode="numeric" placeholder="#" value="${esc(f.number)}" maxlength="3" ${f.id ? '' : 'autofocus'}>
        <input name="name" placeholder="Player name" value="${esc(f.name)}" maxlength="40">
      </div>
      <div class="row">
        <button class="btn primary">${f.id ? 'Save' : 'Add player'}</button>
        <button type="button" class="btn" data-a="playerCancel">${f.id ? 'Cancel' : 'Done'}</button>
        ${f.id ? `<button type="button" class="btn danger" data-a="playerRemove" data-id="${f.id}">${S.confirm === f.id ? 'Tap to confirm' : 'Remove'}</button>` : ''}
      </div>
    </form>` : '<button class="btn primary big wide" data-a="playerNew">+ Add player</button>';
  const list = players().map((p) => `<li><button class="prow" data-a="playerEdit" data-id="${p.id}">
      <span class="pnum">#${esc(p.number)}</span><span>${esc(p.name)}</span><span class="muted">Edit</span></button></li>`).join('');
  const removed = players(true).filter((p) => !p.active);
  return `${header('Players')}
  <main class="pad">
    ${form}
    <ul class="list plist">${list || '<li class="muted">No players yet.</li>'}</ul>
    ${removed.length ? `<h2>Removed</h2><ul class="list plist">${removed.map((p) => `<li class="prow dim">
      <span class="pnum">#${esc(p.number)}</span><span>${esc(p.name)}</span>
      <button class="btn small" data-a="playerRestore" data-id="${p.id}">Restore</button></li>`).join('')}</ul>
      <p class="muted small">Removed players keep their stats in past games.</p>` : ''}
  </main>`;
}

// ---- new game ----
function seg(action, value, options, extra = '') {
  return `<div class="seg">${options.map(([v, label]) => `<button type="button" class="${v === value ? 'on' : ''}" data-a="${action}" data-v="${v}" ${extra}>${label}</button>`).join('')}</div>`;
}

function viewNewGame() {
  const ng = S.newGame ||= { date: todayISO(), opponent: '', format: 'quarters', five: [] };
  const ps = players();
  return `${header('New game')}
  <main class="pad">
    <form class="form" data-form="newGame" autocomplete="off">
      <label>Opponent<input name="opponent" value="${esc(ng.opponent)}" placeholder="e.g. Tigers" maxlength="40"></label>
      <label>Date<input name="date" type="date" value="${esc(ng.date)}"></label>
      <label>Periods</label>
      ${seg('ngFormat', ng.format, [['quarters', 'Quarters'], ['halves', 'Halves']])}
      <label>Starting five <span class="muted">(${ng.five.length}/5)</span></label>
      ${ps.length ? `<div class="chips">${ps.map((p) => `<button type="button" class="chip ${ng.five.includes(p.id) ? 'on' : ''}" data-a="ngToggle" data-id="${p.id}">
        <b>#${esc(p.number)}</b> ${esc(p.name)}</button>`).join('')}</div>`
        : '<p class="muted">No players yet. <button type="button" class="link" data-a="go" data-to="#/players">Add players</button></p>'}
      <button class="btn primary big wide">Start game</button>
    </form>
  </main>`;
}

// ---- live ----
function viewLive(g) {
  const evs = gameEvents(g.id);
  const assists = assistIndex(evs);
  const lines = computeLines(evs);
  const sel = S.sel[g.id];
  const onCourt = (g.on_court || []).filter((id) => player(id));

  const last = evs[evs.length - 1];
  let banner = '<span class="muted">No actions yet</span>';
  if (last) {
    const shown = last.type === 'assist' && last.linked_event_id && store.get('events', last.linked_event_id) || last;
    const who = shown.device_id !== DEVICE && shown.coach ? `<span class="who">${esc(shown.coach)}:</span> ` : '';
    banner = `${who}${esc(evText(shown, assists))}`;
  }
  const fresh = Date.now() - S.flashAt < 500 ? ' fresh' : '';
  const undoCount = getUndo(g.id).filter((id) => store.get('events', id)).length;

  const periods = periodsFor(g);
  const tiles = onCourt.map((id) => {
    const p = player(id);
    const l = lines[id] || {};
    const fouls = l.pf || 0;
    return `<button class="ptile ${sel === id ? 'sel' : ''}" data-a="select" data-id="${id}">
      <span class="pt-num">${esc(p.number)}</span>
      <span class="pt-name">${esc(firstName(p))}</span>
      <span class="pt-line">${l.pts || 0}p${fouls ? ` · <span class="${fouls >= 4 ? 'warn' : ''}">${fouls}F</span>` : ''}</span>
    </button>`;
  }).join('');
  const emptyTiles = Array.from({ length: Math.max(0, 5 - onCourt.length) }, () => '<button class="ptile empty" data-a="subOpen">+</button>').join('');

  const dim = sel ? '' : ' dim';
  const shotBtn = (shot, label) => `
    <button class="act made${dim}" data-a="shot" data-shot="${shot}" data-made="1">${label}<small>made</small></button>
    <button class="act miss${dim}" data-a="shot" data-shot="${shot}" data-made="0">${label}<small>missed</small></button>`;

  return `<div class="live">
    <header class="top live-top">
      <button class="icon" data-a="go" data-to="#/" aria-label="Home">‹</button>
      <h1>vs ${esc(g.opponent)}</h1>
      <div class="top-r">${peersChip(g.id)}${statusDot()}</div>
    </header>
    <section class="live-a">
      <div class="periods" data-keep="periods">
        ${periods.map((p) => `<button class="${g.period === p ? 'on' : ''}" data-a="period" data-p="${p}">${p}</button>`).join('')}
        <button class="ot" data-a="addOT">+OT</button>
        <button class="subbtn" data-a="subOpen">⇄ Sub</button>
      </div>
      <div class="banner-row">
        <div class="banner${fresh}">${banner}</div>
        <button class="undo" data-a="undo" ${undoCount ? '' : 'disabled'}>↶ Undo${undoCount ? ` <small>${undoCount}</small>` : ''}</button>
      </div>
      <div class="court">${tiles}${emptyTiles}</div>
      <div class="ctx">${ctxRow(g, onCourt)}</div>
    </section>
    <section class="live-b">
      <div class="shots">
        ${shotBtn('three', 'Three')}
        ${shotBtn('two', 'Two')}
        ${shotBtn('layup', 'Layup')}
      </div>
      <div class="quick">
        <button class="q ft${dim}" data-a="ftStart">Free throws</button>
        <button class="q${dim}" data-a="quick" data-type="rebound" data-rtype="offensive">Off reb</button>
        <button class="q${dim}" data-a="quick" data-type="rebound" data-rtype="defensive">Def reb</button>
        <button class="q${dim}" data-a="quick" data-type="foul">Foul</button>
        <button class="q${dim}" data-a="quick" data-type="turnover">Turnover</button>
        <button class="q${dim}" data-a="quick" data-type="steal">Steal</button>
        <button class="q${dim}" data-a="quick" data-type="block">Block</button>
      </div>
    </section>
    ${gameTabs(g, 'live')}
    ${S.sub ? subPanel(g, onCourt) : ''}
  </div>`;
}

function miniBtns(ids, action) {
  return ids.map((id) => `<button class="mini" data-a="${action}" data-id="${id}">${esc(num(id))}<small>${esc(firstName(player(id)))}</small></button>`).join('');
}

function ctxRow(g, onCourt) {
  const c = S.ctx;
  const close = '<button class="mini x" data-a="ctxClose" aria-label="Dismiss">✕</button>';
  if (!c) {
    const sel = S.sel[g.id];
    return `<div class="ctx-hint muted">${sel ? `Selected: <b>${esc(num(sel))} ${esc(player(sel)?.name)}</b>` : onCourt.length ? 'Tap a player, then an action' : 'Tap ⇄ Sub to put players on court'}</div>`;
  }
  if (c.kind === 'assist') {
    return `<div class="ctx-label">Assist by <span class="muted">(optional)</span></div>
      <div class="ctx-btns">${miniBtns(onCourt.filter((id) => id !== c.shooter), 'assist')}${close}</div>`;
  }
  if (c.kind === 'rebound') {
    return `<div class="ctx-label">Rebound by
        <span class="tog">${['offensive', 'defensive'].map((v) => `<button class="${c.rtype === v ? 'on' : ''}" data-a="rtype" data-v="${v}">${v === 'offensive' ? 'Off' : 'Def'}</button>`).join('')}</span></div>
      <div class="ctx-btns">${miniBtns(onCourt, 'rebound')}${close}</div>`;
  }
  if (c.kind === 'ftcount') {
    return `<div class="ctx-label">Free throws for ${esc(num(c.player))}: how many?</div>
      <div class="ctx-btns">${[1, 2, 3].map((n) => `<button class="mini big" data-a="ftCount" data-n="${n}">${n}</button>`).join('')}${close}</div>`;
  }
  if (c.kind === 'ft') {
    return `<div class="ctx-label">${esc(num(c.player))} free throw <b>${c.i} of ${c.total}</b></div>
      <div class="ctx-btns">
        <button class="mini made wide" data-a="ft" data-made="1">Made</button>
        <button class="mini miss wide" data-a="ft" data-made="0">Missed</button>${close}</div>`;
  }
  return '';
}

function subPanel(g, onCourt) {
  const bench = players().filter((p) => !onCourt.includes(p.id));
  const out = S.sub.out;
  return `<div class="sheet-bg" data-a="subClose"></div>
  <div class="sheet">
    <div class="sheet-h"><b>Substitution</b><button class="btn small primary" data-a="subClose">Done</button></div>
    <p class="muted small">${out ? `Now tap a bench player to replace ${esc(num(out))}.` : 'Tap the player coming off, then the player going on.'}</p>
    <div class="sub-grid">${onCourt.map((id) => `<button class="chip ${out === id ? 'out' : 'on'}" data-a="subOut" data-id="${id}"><b>${esc(num(id))}</b> ${esc(player(id).name)}</button>`).join('')}</div>
    ${out ? `<button class="btn small" data-a="subBench">Take ${esc(num(out))} off without replacing</button>` : ''}
    <h3>Bench</h3>
    <div class="sub-grid">${bench.map((p) => `<button class="chip" data-a="subIn" data-id="${p.id}"><b>#${esc(p.number)}</b> ${esc(p.name)}</button>`).join('') || '<span class="muted">No one on the bench</span>'}</div>
  </div>`;
}

// ---- stat tables ----
const pctTxt = (m, a) => { const v = pct(m, a); return v == null ? '–' : v + '%'; };
const pctSort = (m, a) => (a ? m / a : -1);
const COLS = [
  { k: 'pts', h: 'PTS', v: (l) => l.pts },
  { k: 'fg', h: 'FG', v: (l) => `${l.fgm}-${l.fga}`, s: (l) => l.fgm * 1000 + l.fga },
  { k: 'fgp', h: 'FG%', v: (l) => pctTxt(l.fgm, l.fga), s: (l) => pctSort(l.fgm, l.fga) },
  { k: 'tp', h: '3P', v: (l) => `${l.tpm}-${l.tpa}`, s: (l) => l.tpm * 1000 + l.tpa },
  { k: 'tpp', h: '3P%', v: (l) => pctTxt(l.tpm, l.tpa), s: (l) => pctSort(l.tpm, l.tpa) },
  { k: 'tw', h: '2P', v: (l) => `${l.twm}-${l.twa}`, s: (l) => l.twm * 1000 + l.twa },
  { k: 'lu', h: 'LAY', v: (l) => `${l.lum}-${l.lua}`, s: (l) => l.lum * 1000 + l.lua },
  { k: 'ft', h: 'FT', v: (l) => `${l.ftm}-${l.fta}`, s: (l) => l.ftm * 1000 + l.fta },
  { k: 'ftp', h: 'FT%', v: (l) => pctTxt(l.ftm, l.fta), s: (l) => pctSort(l.ftm, l.fta) },
  { k: 'oreb', h: 'OR', v: (l) => l.oreb },
  { k: 'dreb', h: 'DR', v: (l) => l.dreb },
  { k: 'reb', h: 'REB', v: (l) => l.reb },
  { k: 'ast', h: 'AST', v: (l) => l.ast },
  { k: 'stl', h: 'STL', v: (l) => l.stl },
  { k: 'blk', h: 'BLK', v: (l) => l.blk },
  { k: 'tov', h: 'TO', v: (l) => l.tov },
  { k: 'pf', h: 'PF', v: (l) => l.pf },
  { k: 'eff', h: 'EFF', v: (l) => l.eff },
];

function sortRows(rows, cols, sort) {
  const col = cols.find((c) => c.k === sort.key);
  const key = sort.key === 'name' ? (r) => parseInt(r.p.number, 10) || 0 : (r) => (col.s || col.v)(r.l);
  return rows.sort((a, b) => {
    const x = key(a); const y = key(b);
    return (x > y ? 1 : x < y ? -1 : 0) * sort.dir || byNumber(a.p, b.p);
  });
}

function statTable(rows, total, { cols = COLS, sort, which = '', highlight = [], keep = 'tbl' }) {
  const arrow = (k) => (sort.key === k ? (sort.dir > 0 ? ' ▲' : ' ▼') : '');
  const th = `<th class="sticky"><button data-a="sort" data-k="name" data-which="${which}">Player${arrow('name')}</button></th>`
    + cols.map((c) => `<th class="${sort.key === c.k ? 'sorted' : ''}"><button data-a="sort" data-k="${c.k}" data-which="${which}">${c.h}${arrow(c.k)}</button></th>`).join('');
  const tr = sortRows(rows, cols, sort).map(({ p, l }) => `<tr class="${highlight.includes(p.id) ? 'oncourt' : ''}">
      <td class="sticky"><b>${esc(p.number)}</b> ${esc(firstName(p))}</td>
      ${cols.map((c) => `<td class="${sort.key === c.k ? 'sorted' : ''}">${c.v(l)}</td>`).join('')}</tr>`).join('');
  const tot = total ? `<tr class="total"><td class="sticky">Team</td>${cols.map((c) => `<td>${c.v(total)}</td>`).join('')}</tr>` : '';
  return `<div class="tbl-wrap" data-keep="${keep}"><table class="stats"><thead><tr>${th}</tr></thead><tbody>${tr}${tot}</tbody></table></div>`;
}

function gameRows(g, events) {
  const lines = computeLines(events);
  const ids = new Set([...players().map((p) => p.id), ...Object.keys(lines)]);
  return [...ids].map((id) => player(id)).filter(Boolean)
    .map((p) => ({ p, l: lines[p.id] || blank() }));
}
const blank = () => sumLines([]);

function viewStats(g) {
  const all = gameEvents(g.id);
  const evs = filterEvents(all, S.statsMode, g.period, CONFIG.recentMinutes);
  const rows = gameRows(g, evs);
  const total = sumLines(rows.map((r) => r.l));
  let note = '';
  if (S.statsMode === 'recent' && evs.length) note = `Since ${fmtTime(evs[0].created_at)} (last ${CONFIG.recentMinutes} min of logged play)`;
  if (S.statsMode === 'period') note = `${g.period} only`;
  return `${header(`vs ${esc(g.opponent)}`, '#/', peersChip(g.id))}
  <main class="pad with-tabs">
    <div class="stats-head">
      ${seg('statsMode', S.statsMode, [['game', 'Game'], ['period', `This ${g.period}`], ['recent', 'Recent']])}
      <div class="muted small">${note || `${all.length} events · tap a column to sort`}</div>
    </div>
    ${statTable(rows, total, { sort: S.sort, highlight: g.on_court || [] })}
    <p class="muted small">Highlighted rows are on court. EFF = PTS + REB + AST + STL + BLK − missed FG − missed FT − TO.</p>
  </main>
  ${gameTabs(g, 'stats')}`;
}

// ---- log ----
const TYPES = [['shot', 'Shot'], ['free_throw', 'Free throw'], ['rebound', 'Rebound'], ['assist', 'Assist'], ['foul', 'Foul'], ['turnover', 'Turnover'], ['steal', 'Steal'], ['block', 'Block']];

function viewLog(g) {
  const evs = gameEvents(g.id).reverse();
  const assists = assistIndex(evs);
  const rows = evs.map((e) => `<li class="logrow">
      <span class="per">${esc(e.period)}</span>
      <span class="desc">${esc(evText(e, assists))}<small class="muted">${fmtTime(e.created_at)}${e.coach ? ` · ${esc(e.coach)}` : ''}</small></span>
      <button class="btn small" data-a="editEvent" data-id="${e.id}">Edit</button>
      <button class="btn small danger" data-a="delEvent" data-id="${e.id}">${S.confirm === e.id ? 'Sure?' : 'Del'}</button>
    </li>`).join('');
  return `${header(`vs ${esc(g.opponent)}`, '#/', peersChip(g.id))}
  <main class="pad with-tabs">
    <h2>Event log <span class="muted small">${evs.length} events, newest first</span></h2>
    ${evs.length ? `<ul class="list log">${rows}</ul>` : '<p class="muted">Nothing logged yet.</p>'}
  </main>
  ${gameTabs(g, 'log')}
  ${S.edit ? editSheet(g) : ''}`;
}

function editSheet(g) {
  const e = S.edit;
  const opt = (list, cur) => list.map(([v, l]) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const roster = players(true).filter((p) => p.active || p.id === e.player_id).map((p) => [p.id, `#${p.number} ${p.name}`]);
  const periods = [...new Set([...periodsFor(g), e.period])].map((p) => [p, p]);
  return `<div class="sheet-bg" data-a="editClose"></div>
  <div class="sheet">
    <div class="sheet-h"><b>Edit event</b><button class="btn small" data-a="editClose">Cancel</button></div>
    <div class="form">
      <label>Player<select data-edit="player_id">${opt(roster, e.player_id)}</select></label>
      <label>Period<select data-edit="period">${opt(periods, e.period)}</select></label>
      <label>Type<select data-edit="type">${opt(TYPES, e.type)}</select></label>
      ${e.type === 'shot' ? `<label>Shot<select data-edit="shot_type">${opt([['three', 'Three'], ['two', 'Two'], ['layup', 'Layup']], e.shot_type || 'two')}</select></label>` : ''}
      ${e.type === 'shot' || e.type === 'free_throw' ? `<label>Result<select data-edit="made">${opt([['true', 'Made'], ['false', 'Missed']], e.made ?? true)}</select></label>` : ''}
      ${e.type === 'rebound' ? `<label>Rebound<select data-edit="rebound_type">${opt([['offensive', 'Offensive'], ['defensive', 'Defensive']], e.rebound_type || 'defensive')}</select></label>` : ''}
      <div class="row">
        <button class="btn primary" data-a="editSave">Save</button>
        <button class="btn danger" data-a="delEvent" data-id="${e.id}">${S.confirm === e.id ? 'Tap to confirm' : 'Delete'}</button>
      </div>
    </div>
  </div>`;
}

// ---- summary ----
function periodOrder(g, events) {
  return [...new Set([...periodsFor(g), ...events.map((e) => e.period)])];
}

function leaders(rows) {
  const top = (label, key, unit) => {
    const best = [...rows].sort((a, b) => b.l[key] - a.l[key])[0];
    if (!best || best.l[key] <= 0) return '';
    return `<div class="leader"><span class="muted small">${label}</span><b>${best.l[key]}<small>${unit}</small></b><span>#${esc(best.p.number)} ${esc(best.p.name)}</span></div>`;
  };
  const html = top('Points', 'pts', ' pts') + top('Rebounds', 'reb', ' reb') + top('Assists', 'ast', ' ast') + top('Efficiency', 'eff', ' eff');
  return html ? `<div class="leaders">${html}</div>` : '';
}

function viewSummary(g) {
  const evs = gameEvents(g.id);
  const rows = gameRows(g, evs).filter((r) => evs.some((e) => e.player_id === r.p.id) || (g.played || []).includes(r.p.id));
  const total = sumLines(rows.map((r) => r.l));
  const pers = periodOrder(g, evs).filter((p) => evs.some((e) => e.period === p) || periodsFor(g).includes(p));

  const perTeam = pers.map((p) => {
    const l = sumLines(Object.values(computeLines(evs.filter((e) => e.period === p))));
    return `<tr><td class="sticky">${p}</td><td>${l.pts}</td><td>${l.fgm}-${l.fga}</td><td>${pctTxt(l.fgm, l.fga)}</td>
      <td>${l.tpm}-${l.tpa}</td><td>${pctTxt(l.tpm, l.tpa)}</td><td>${l.ftm}-${l.fta}</td><td>${pctTxt(l.ftm, l.fta)}</td>
      <td>${l.reb}</td><td>${l.ast}</td><td>${l.tov}</td></tr>`;
  }).join('');

  const perLines = Object.fromEntries(pers.map((p) => [p, computeLines(evs.filter((e) => e.period === p))]));
  const matrix = [...rows].sort((a, b) => byNumber(a.p, b.p)).map(({ p, l }) => `<tr><td class="sticky"><b>${esc(p.number)}</b> ${esc(firstName(p))}</td>
    ${pers.map((per) => { const x = perLines[per][p.id]; return `<td>${x && x.fga ? `${x.fgm}/${x.fga} <small class="muted">${pctTxt(x.fgm, x.fga)}</small>` : '<span class="muted">–</span>'}</td>`; }).join('')}
    <td><b>${l.fgm}/${l.fga}</b> <small class="muted">${pctTxt(l.fgm, l.fga)}</small></td></tr>`).join('');

  const gf = S.gameForm;
  return `${header(`vs ${esc(g.opponent)}`, '#/', peersChip(g.id))}
  <main class="pad with-tabs">
    <div class="sum-head">
      <div><div class="big-score">${total.pts}<small> pts</small></div><div class="muted">${fmtDate(g.date)} · vs ${esc(g.opponent)}</div></div>
      <div class="sum-pcts">
        <span>FG <b>${pctTxt(total.fgm, total.fga)}</b></span><span>3P <b>${pctTxt(total.tpm, total.tpa)}</b></span><span>FT <b>${pctTxt(total.ftm, total.fta)}</b></span>
      </div>
    </div>
    ${leaders(rows)}
    <h2>Box score</h2>
    ${rows.length ? statTable(rows, total, { sort: S.sort, keep: 'box' }) : '<p class="muted">No stats yet.</p>'}
    <h2>By ${g.format === 'halves' ? 'half' : 'quarter'}</h2>
    <div class="tbl-wrap" data-keep="per"><table class="stats"><thead><tr><th class="sticky">Per</th><th>PTS</th><th>FG</th><th>FG%</th><th>3P</th><th>3P%</th><th>FT</th><th>FT%</th><th>REB</th><th>AST</th><th>TO</th></tr></thead>
      <tbody>${perTeam}</tbody></table></div>
    <h3>Field goals per player per period</h3>
    <div class="tbl-wrap" data-keep="mx"><table class="stats"><thead><tr><th class="sticky">Player</th>${pers.map((p) => `<th>${p}</th>`).join('')}<th>Game</th></tr></thead>
      <tbody>${matrix}</tbody></table></div>
    <div class="row export">
      <button class="btn" data-a="exportBox">⬇ Box score CSV</button>
      <button class="btn" data-a="exportEvents">⬇ Events CSV</button>
    </div>
    <h2>Game settings</h2>
    ${gf ? `<form class="form card" data-form="game" autocomplete="off">
        <label>Opponent<input name="opponent" value="${esc(gf.opponent)}" maxlength="40"></label>
        <label>Date<input name="date" type="date" value="${esc(gf.date)}"></label>
        ${seg('gameFormat', gf.format, [['quarters', 'Quarters'], ['halves', 'Halves']])}
        <div class="row"><button class="btn primary">Save</button><button type="button" class="btn" data-a="gameEditClose">Cancel</button></div>
      </form>`
      : `<div class="row"><button class="btn" data-a="gameEdit">Edit game details</button>
        <button class="btn danger" data-a="gameDelete">${S.confirm === g.id ? 'Tap again to delete game' : 'Delete game'}</button></div>`}
  </main>
  ${gameTabs(g, 'summary')}`;
}
A.gameEdit = () => { const g = game(); S.gameForm = { opponent: g.opponent, date: g.date, format: g.format || 'quarters' }; };
A.gameEditClose = () => { S.gameForm = null; };

// ---- season ----
function seasonData() {
  const gs = games();
  const ids = new Set(gs.map((g) => g.id));
  const evs = store.all('events').filter((e) => ids.has(e.game_id));
  const lines = computeLines(evs);
  const gp = {};
  for (const g of gs) {
    const inGame = new Set([...(g.played || []), ...evs.filter((e) => e.game_id === g.id).map((e) => e.player_id)]);
    for (const id of inGame) gp[id] = (gp[id] || 0) + 1;
  }
  const rows = players(true).filter((p) => p.active || lines[p.id])
    .map((p) => ({ p, l: { ...(lines[p.id] || blank()), gp: gp[p.id] || 0 } }));
  return { gs, rows };
}

const per = (k) => (l) => (l.gp ? (l[k] / l.gp).toFixed(1) : '–');
const SEASON_COLS = [
  { k: 'gp', h: 'GP', v: (l) => l.gp },
  { k: 'pts', h: 'PTS', v: (l) => l.pts },
  { k: 'ppg', h: 'PPG', v: per('pts'), s: (l) => (l.gp ? l.pts / l.gp : -1) },
  ...COLS.filter((c) => ['fg', 'fgp', 'tp', 'tpp', 'lu', 'ft', 'ftp'].includes(c.k)),
  { k: 'reb', h: 'REB', v: (l) => l.reb },
  { k: 'rpg', h: 'RPG', v: per('reb'), s: (l) => (l.gp ? l.reb / l.gp : -1) },
  { k: 'ast', h: 'AST', v: (l) => l.ast },
  { k: 'apg', h: 'APG', v: per('ast'), s: (l) => (l.gp ? l.ast / l.gp : -1) },
  ...COLS.filter((c) => ['stl', 'blk', 'tov', 'pf', 'eff'].includes(c.k)),
];

function viewSeason() {
  if (!store.loaded) return viewLoading();
  const { gs, rows } = seasonData();
  const total = { ...sumLines(rows.map((r) => r.l)), gp: gs.length };
  return `${header('Season')}
  <main class="pad">
    <p class="muted">${gs.length} game${gs.length === 1 ? '' : 's'} · tap a column to sort</p>
    ${statTable(rows, total, { cols: SEASON_COLS, sort: S.seasonSort, which: 'season', keep: 'season' })}
    <div class="row export"><button class="btn" data-a="exportSeason">⬇ Season CSV</button></div>
    <h2>Past games</h2>
    <ul class="list">${gs.map((g) => {
      const pts = sumLines(Object.values(computeLines(gameEvents(g.id)))).pts;
      return `<li><button class="prow" data-a="go" data-to="#/g/${g.id}/summary"><span class="muted">${fmtDate(g.date)}</span><span>vs ${esc(g.opponent)}</span><b>${pts}</b></button></li>`;
    }).join('') || '<li class="muted">No games yet.</li>'}</ul>
  </main>`;
}

// ---- CSV export ----
const CSV_HEAD = ['Number', 'Player', 'PTS', 'FGM', 'FGA', 'FG%', '3PM', '3PA', '3P%', '2PM', '2PA', 'LayupM', 'LayupA', 'FTM', 'FTA', 'FT%', 'OREB', 'DREB', 'REB', 'AST', 'STL', 'BLK', 'TO', 'PF', 'EFF'];
const csvLine = (l) => [l.pts, l.fgm, l.fga, pct(l.fgm, l.fga) ?? '', l.tpm, l.tpa, pct(l.tpm, l.tpa) ?? '', l.twm, l.twa, l.lum, l.lua, l.ftm, l.fta, pct(l.ftm, l.fta) ?? '', l.oreb, l.dreb, l.reb, l.ast, l.stl, l.blk, l.tov, l.pf, l.eff];

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function exportGameCSV(g, raw) {
  const evs = gameEvents(g.id);
  if (raw) {
    const rows = [['Time', 'Period', 'Number', 'Player', 'Type', 'Shot', 'Made', 'Rebound', 'Linked event', 'Coach', 'Event id']];
    for (const e of evs) {
      const p = player(e.player_id);
      rows.push([e.created_at, e.period, p?.number, p?.name, e.type, e.shot_type, e.made == null ? '' : e.made ? 'yes' : 'no', e.rebound_type, e.linked_event_id, e.coach, e.id]);
    }
    download(`${g.date}-${slug(g.opponent)}-events.csv`, toCSV(rows));
    return;
  }
  const rows = gameRows(g, evs).filter((r) => evs.some((e) => e.player_id === r.p.id) || (g.played || []).includes(r.p.id)).sort((a, b) => byNumber(a.p, b.p));
  const out = [CSV_HEAD, ...rows.map(({ p, l }) => [p.number, p.name, ...csvLine(l)])];
  out.push(['', 'Team', ...csvLine(sumLines(rows.map((r) => r.l)))]);
  download(`${g.date}-${slug(g.opponent)}-box-score.csv`, toCSV(out));
}

function exportSeasonCSV() {
  const { rows } = seasonData();
  const out = [['Number', 'Player', 'GP', ...CSV_HEAD.slice(2)], ...rows.sort((a, b) => byNumber(a.p, b.p)).map(({ p, l }) => [p.number, p.name, l.gp, ...csvLine(l)])];
  download(`season-totals-${todayISO()}.csv`, toCSV(out));
}

// ---- boot -------------------------------------------------------------------------
S.route = parseRoute();
if (S.route.name === 'new') S.newGame = { date: todayISO(), opponent: '', format: 'quarters', five: [] };
render();
store.init(DEVICE).then(() => store.setPresence(presence()));
store.setPresence(presence());

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
