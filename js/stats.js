// Pure stat calculations. Everything is derived from the events list.

export const SHOT_POINTS = { three: 3, two: 2, layup: 2 };
export const SHOT_LABEL = { three: 'three', two: 'two', layup: 'layup' };

export function blankLine() {
  return {
    pts: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, twm: 0, twa: 0, lum: 0, lua: 0,
    ftm: 0, fta: 0, oreb: 0, dreb: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, pf: 0, eff: 0,
  };
}

function addEvent(l, e) {
  switch (e.type) {
    case 'shot': {
      l.fga++;
      if (e.shot_type === 'three') l.tpa++;
      else if (e.shot_type === 'layup') l.lua++;
      else l.twa++;
      if (e.made) {
        l.fgm++;
        l.pts += SHOT_POINTS[e.shot_type] || 2;
        if (e.shot_type === 'three') l.tpm++;
        else if (e.shot_type === 'layup') l.lum++;
        else l.twm++;
      }
      break;
    }
    case 'free_throw':
      l.fta++;
      if (e.made) { l.ftm++; l.pts++; }
      break;
    case 'rebound':
      if (e.rebound_type === 'offensive') l.oreb++; else l.dreb++;
      l.reb++;
      break;
    case 'assist': l.ast++; break;
    case 'steal': l.stl++; break;
    case 'block': l.blk++; break;
    case 'turnover': l.tov++; break;
    case 'foul': l.pf++; break;
  }
}

export function efficiency(l) {
  return l.pts + l.reb + l.ast + l.stl + l.blk - (l.fga - l.fgm) - (l.fta - l.ftm) - l.tov;
}

// Returns { [player_id]: line }
export function computeLines(events) {
  const lines = {};
  for (const e of events) {
    if (!e.player_id) continue;
    addEvent(lines[e.player_id] ||= blankLine(), e);
  }
  for (const l of Object.values(lines)) l.eff = efficiency(l);
  return lines;
}

export function sumLines(lines) {
  const t = blankLine();
  for (const l of lines) for (const k in t) t[k] += l[k] || 0;
  t.eff = efficiency(t);
  return t;
}

export function pct(m, a) {
  return a ? Math.round((m / a) * 100) : null;
}

export function periodsFor(game) {
  const list = game?.format === 'halves' ? ['H1', 'H2'] : ['Q1', 'Q2', 'Q3', 'Q4'];
  for (let i = 1; i <= (game?.ot || 0); i++) list.push('OT' + i);
  return list;
}

// Events for the hot hand view: whole game, one period, or the last few
// minutes of logged play (measured back from the latest event, so breaks
// in play don't empty the view).
export function filterEvents(events, mode, period, recentMinutes = 5) {
  if (mode === 'period') return events.filter((e) => e.period === period);
  if (mode === 'recent') {
    if (!events.length) return [];
    const last = Math.max(...events.map((e) => Date.parse(e.created_at)));
    const from = last - recentMinutes * 60000;
    return events.filter((e) => Date.parse(e.created_at) >= from);
  }
  return events;
}

export function toCSV(rows) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\n');
}
