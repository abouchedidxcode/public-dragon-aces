// Scoreboard and end-of-match results (podium, awards, your stats). Rendering happens only when the data
// changes; the per-frame update just moves the countdown bar.
import { BREEDS, MATCH, TEAMS } from '../../shared/constants.js';
import { $, breedTint, esc } from './ui-util.js';

const CROWN = '<svg class="crown" viewBox="0 0 28 20" aria-hidden="true"><path d="M2 17 0 4l7 6 7-9 7 9 7-6-2 13Z" fill="currentColor"/></svg>';

// In Team Deathmatch chips take the flight's colour; otherwise the breed's.
const colorOf = (e, tdm) => (tdm && TEAMS[e.team] ? TEAMS[e.team].color : breedTint(e.breed));
const chip = (e, tdm) => `<span class="chip" style="background:${colorOf(e, tdm)}"></span>`;
const teamLine = (t = [0, 0]) =>
  `<b style="color:${TEAMS[0].color}">${TEAMS[0].name} ${t[0]}</b> : <b style="color:${TEAMS[1].color}">${t[1]} ${TEAMS[1].name}</b>`;
const MEDAL_LABELS = { firstblood: 'First Blood', revenge: 'Revenge', closecall: 'Close Call', sniper: 'Sniper', bounty: 'Bounty Hunter', shutdown: 'Shutdown' };
// awards (one per category, e.g. Top Ace) and medals earned during the match
const medalHtml = (e) =>
  (e.awards || []).map((a) => `<em class="award">${esc(a)}</em>`)
    .concat(Object.entries(e.medals || {}).map(([k, n]) => `<em>${MEDAL_LABELS[k] || esc(k)}${n > 1 ? ` x${n}` : ''}</em>`))
    .join(' ');

export function renderScoreboard(body, sub, rows, meId, info = {}) {
  const tdm = info.mode === 'tdm';
  if (tdm) sub.innerHTML = `Team Deathmatch · ${teamLine(info.teams)}`;
  else sub.textContent = `${rows.length} dragon${rows.length === 1 ? '' : 's'} in the sky`;
  body.innerHTML = rows
    .map((e, i) => `<tr class="${e.id === meId ? 'me' : ''}"><td class="rank">${i + 1}</td><td class="${e.bot ? 'bot' : ''}">${chip(e, tdm)}${e.bounty ? '\u2605 ' : ''}${esc(e.name)}${e.bot ? ' <small>(bot)</small>' : ''}</td><td>${BREEDS[e.breed].name}</td><td>${e.kills}</td><td>${e.deaths}</td><td>${e.score}</td></tr>`)
    .join('');
}

export class Results {
  constructor() {
    this.el = $('results');
    this.board = null;
    this.shown = false;
    this.nextSec = -1;
  }

  update(show, board, meId, nextIn, stats, audio, info = {}) {
    if (show !== this.shown) {
      this.shown = show;
      this.el.classList.toggle('hidden', !show);
      $('hud').classList.toggle('dim', show);
      if (!show) this.board = null;
    }
    if (!show || !board) return;
    if (board !== this.board) {
      this.board = board;
      this.render(board, meId, stats, audio, info);
    }
    const sec = Math.ceil(nextIn);
    if (sec !== this.nextSec) {
      this.nextSec = sec;
      $('res-next').textContent = `Next battle in ${sec}s`;
    }
    $('res-bar').style.transform = `scaleX(${Math.max(0, Math.min(1, nextIn / MATCH.resultsTime))})`;
  }

  render(board, meId, stats, audio, info = {}) {
    const tdm = info.mode === 'tdm';
    const top = board[0];
    const myIdx = board.findIndex((b) => b.id === meId);
    const me = myIdx >= 0 ? board[myIdx] : null;
    const placed = me ? ` · you placed #${myIdx + 1} of ${board.length}` : '';
    let win;
    if (tdm && info.result) {
      // team result first: the flight that won, then the score line
      const w = info.result.winner;
      win = w >= 0 && me && me.team === w;
      $('res-title').textContent = w < 0 ? 'Draw' : win ? 'Victory' : me ? 'Defeat' : `${TEAMS[w].name} wins`;
      $('res-sub').innerHTML = `${w < 0 ? 'Neither flight rules the sky' : `${TEAMS[w].name} flight rules the sky`} · ${teamLine(info.teams)}${placed}`;
    } else {
      win = top && top.id === meId;
      $('res-title').textContent = win ? 'Victory' : myIdx >= 0 && myIdx < 3 ? 'Well flown' : 'Battle over';
      $('res-sub').textContent = top ? `${win ? 'You are the Ace of the sky' : `${top.name} rules the sky`}${placed}` : '';
    }
    this.el.classList.toggle('win', !!win);

    // podium: second, first, third
    const order = [[1, 'p2'], [0, 'p1'], [2, 'p3']].filter(([i]) => board[i]);
    $('res-podium').innerHTML = order
      .map(([i, cls]) => {
        const e = board[i];
        return `<div class="pod ${cls}${e.id === meId ? ' me' : ''}" style="--c:${colorOf(e, tdm)}">${i === 0 ? CROWN : ''}<div class="who">${esc(e.name)}</div><div class="meta">${e.kills} kills<span class="s"> · ${e.score} pts</span></div><div class="step">${i + 1}</div></div>`;
      })
      .join('');

    // your numbers
    const tiles = me
      ? [
          ['Place', `#${myIdx + 1}`, true], ['Kills', me.kills], ['Deaths', me.deaths],
          ['K/D', me.deaths ? (me.kills / me.deaths).toFixed(1) : String(me.kills)], ['Score', me.score, true], ['Damage', stats.damage],
        ]
      : [];
    $('res-stats').innerHTML = tiles
      .map(([k, v, hl], i) => `<div class="tile${hl ? ' hl' : ''}" style="animation-delay:${0.5 + i * 0.07}s"><b>${v}</b><small>${k}</small></div>`)
      .join('');

    // awards: one chip per player, however many they won
    const won = new Map();
    const give = (label, e) => {
      if (!won.has(e.id)) won.set(e.id, { e, labels: [] });
      won.get(e.id).labels.push(label);
    };
    // awards the room handed out (Top Ace, Heavy Hitter, Wingman...) come first
    for (const e of board) for (const a of e.awards || []) give(a, e);
    if (top && !won.size) give('MVP', top);
    const byKills = [...board].sort((a, b) => b.kills - a.kills || b.score - a.score)[0];
    if (byKills && byKills.kills > 0) give(`${byKills.kills} kills`, byKills);
    const careful = board.filter((b) => b.kills >= 3).sort((a, b) => a.deaths - b.deaths || b.kills - a.kills)[0];
    if (careful) give(`Only ${careful.deaths} falls`, careful);
    const chips = [...won.values()].map(({ e, labels }) => [labels.join(' · '), e]);
    if (stats.bestStreak >= 2 && me) chips.push([`Best streak ${stats.bestStreak}`, me]);
    $('res-awards').innerHTML = chips
      .slice(0, 4)
      .map(([k, e]) => `<div class="award${e.id === meId ? ' me' : ''}"><div><small>${k}</small><b style="color:${colorOf(e, tdm)}">${esc(e.name)}</b></div></div>`)
      .join('');

    $('res-body').innerHTML = board
      .map((e, i) => `<tr class="${e.id === meId ? 'me' : ''}"><td class="rank">${i + 1}</td><td class="${e.bot ? 'bot' : ''}">${chip(e, tdm)}${esc(e.name)}</td><td>${e.kills}</td><td>${e.deaths}</td><td>${e.assists || 0}</td><td>${e.score}</td><td class="medals">${medalHtml(e)}</td></tr>`)
      .join('');
    // bring your own row into view
    const row = $('res-body').querySelector('tr.me');
    const wrap = this.el.querySelector('.res-table');
    if (row) wrap.scrollTop = Math.max(0, row.offsetTop - wrap.clientHeight / 2);
    if (audio) audio.ui(win ? 'confirm' : 'open');
  }
}
