/* The VMU: the console's little memory-card screen, 48×32 one-bit pixels, in the top bar. It says
 * how your commander is doing without a word: a face (happy, waiting, worried), a battery that
 * fills with charge, the charge as digits, and a warning bar when ore sits at risk. With no
 * commander pinned it keeps a pet, as the real one did: an egg that hatches with your first
 * battle won and grows up by five, strolling under the stars, with a heart after each win. */
import { flashTooltip, h } from '../core/dom';
import { audio } from '../core/audio';
import { commander, type CommanderState } from '../chain/commander';
import { live } from '../chain/live';
import { loadRecord } from '../screens/battle/record';

const W = 48, H = 32;
const INK = '#18241C', LCD = '#A9C3A6';
/** 3×5 digits, rows top to bottom, three bits each (4 = left column). */
const DIGITS: Record<string, number[]> = {
  0: [7, 5, 5, 5, 7], 1: [2, 6, 2, 2, 7], 2: [7, 1, 7, 4, 7], 3: [7, 1, 3, 1, 7], 4: [5, 5, 7, 1, 1],
  5: [7, 4, 7, 1, 7], 6: [7, 4, 7, 5, 7], 7: [7, 1, 2, 2, 2], 8: [7, 5, 7, 5, 7], 9: [7, 5, 7, 1, 7], '+': [0, 2, 7, 2, 0],
};
/** 12×12 faces: eyes and a mouth on a round head, one row of bits per line (2048 = leftmost). */
const FACE_RIM = [0x1F8, 0x606, 0x801, 0x801, 0x801, 0x801, 0x801, 0x801, 0x801, 0x801, 0x606, 0x1F8];
/** The pet's three ages, 12×12, two frames each (its feet). */
const PET: Record<'egg' | 'baby' | 'adult', string[][]> = {
  egg: [[
    '....####....', '...#....#...', '..#......#..', '..#..##..#..', '.#........#.', '.#.##.....#.',
    '.#........#.', '.#.....##.#.', '..#......#..', '..#......#..', '...#....#...', '....####....',
  ]],
  baby: [[
    '............', '............', '....####....', '...######...', '..##.##.##..', '..########..',
    '..##....##..', '..########..', '...######...', '...#....#...', '..##....##..', '............',
  ], [
    '............', '............', '....####....', '...######...', '..##.##.##..', '..########..',
    '..##....##..', '..########..', '...######...', '....#..#....', '...##..##...', '............',
  ]],
  adult: [[
    '..#......#..', '...#....#...', '...######...', '..########..', '.##.####.##.', '.##########.',
    '.###....###.', '.##########.', '..########..', '..##....##..', '.##......##.', '............',
  ], [
    '..#......#..', '...#....#...', '...######...', '..########..', '.##.####.##.', '.##########.',
    '.###....###.', '.##########.', '..########..', '...##..##...', '..##....##..', '............',
  ]],
};
const HEART = ['.##.##.', '#######', '#######', '.#####.', '..###..', '...#...'];
const MOUTHS = { happy: [[3, 7], [4, 8], [5, 8], [6, 8], [7, 8], [8, 7]], wait: [[4, 8], [5, 8], [6, 8], [7, 8]], sad: [[3, 9], [4, 8], [5, 8], [6, 8], [7, 8], [8, 9]] };

/** While you're in the Concourse, the VMU shows your deck and how many droids are on it. */
let lobby: { deck: string; count: number } | null = null;
export function vmuLobby(v: { deck: string; count: number } | null) { lobby = v; }

export function mountVmu(): HTMLElement {
  const canvas = h('canvas', { width: W, height: H, class: 'vmu-lcd', 'aria-hidden': 'true' }) as HTMLCanvasElement;
  // A button: a tap (or A) says what the little screen is showing.
  const el = h('button', { type: 'button', class: 'vmu', 'aria-label': 'VMU' }, canvas) as HTMLButtonElement;
  const about = () => {
    if (lobby) return `Deck ${lobby.deck} · ${lobby.count} here`;
    if (st) return `${st.name}: charge ${st.charge}${st.online ? '' : ' · grid offline'}${st.storedOre ? ` · ${st.storedOre} ore at risk` : ''}`;
    return wins >= 5 ? `Your pet is grown · ♥ ${wins} wins` : wins >= 1 ? `Your pet · ♥ ${wins} · grows up at 5 wins` : 'An egg · win a battle to hatch it';
  };
  el.addEventListener('click', () => {
    const r = el.getBoundingClientRect();
    flashTooltip(Math.max(8, r.left - 180), r.bottom + 4, about(), 2600);
    audio.play('select');
  });
  const g = canvas.getContext('2d')!;
  const px = (x: number, y: number, w = 1, hh = 1) => g.fillRect(x, y, w, hh);
  const text = (s: string, x: number, y: number) => {
    for (const ch of s) {
      const rows = DIGITS[ch];
      if (rows) rows.forEach((bits, r) => { for (let c = 0; c < 3; c++) if (bits & (4 >> c)) px(x + c, y + r); });
      x += 4;
    }
  };
  let st: CommanderState | null = null;
  let frame = 0, blink = 0;
  const sprite = (rows: string[], x: number, y: number, flip = false) => rows.forEach((row, r) => { for (let c = 0; c < row.length; c++) if (row[flip ? row.length - 1 - c : c] === '#') px(x + c, y + r); });
  // The pet: its age from wins (read now and then: the record lives in this browser), a heart per new win.
  let wins = loadRecord().wins, heart = 0, petX = 18, petDir = 1;
  const stars = Array.from({ length: 14 }, (_, i) => ({ x: (i * 37) % W, y: 2 + ((i * 11) % (H - 4)), s: 1 + (i % 3) }));

  const draw = () => {
    g.fillStyle = LCD; g.fillRect(0, 0, W, H);
    g.fillStyle = INK;
    if (lobby) {
      // The beacon's chevron and the deck; a little droid and the head count.
      sprite(['###..', '.###.', '..###', '.###.', '###..'], 3, 3);
      if (/^\d$/.test(lobby.deck)) text(lobby.deck, 12, 3); else px(12, 3, 3, 5);
      sprite(['.###.', '.#.#.', '.###.', '#####', '.#.#.'], 3, 18 - (frame % 8 < 4 ? 0 : 1));
      text(String(Math.min(999, lobby.count)), 11, 18);
      px(0, 30, W, 1);
      return;
    }
    if (!st) {
      // Idle: the pet under slow stars; a block landing flashes one star.
      for (const s of stars) { if (s.y < 16) { s.x = (s.x - s.s * 0.15 + W) % W; px(Math.floor(s.x), s.y); } }
      if (blink > 0) { const s = stars[frame % stars.length]; if (s.y < 16) { px(Math.floor(s.x) - 1, s.y, 3, 1); px(Math.floor(s.x), s.y - 1, 1, 3); } blink--; }
      px(0, 30, W, 1);
      const age = wins >= 5 ? 'adult' : wins >= 1 ? 'baby' : 'egg';
      const frames = PET[age];
      if (age === 'egg') sprite(frames[0], 18 + (frame % 16 < 2 ? (frame % 2 ? 1 : -1) : 0), 18);
      else {
        // A stroll: a step every other frame, turning at the edges; it hops while a heart is up.
        if (frame % 2 === 0) { petX += petDir; if (petX > 34 || petX < 2) petDir = -petDir; }
        const hop = heart > 0 && frame % 4 < 2 ? 2 : 0;
        sprite(frames[frame % 4 < 2 ? 0 : 1], petX, 18 - hop, petDir < 0);
        if (heart > 0) { sprite(HEART, petX + 3, 9 - hop); heart--; }
      }
      return;
    }
    // A commander: face (left), battery (right), charge digits (bottom right), ore at risk (bottom bar).
    const mood: keyof typeof MOUTHS = !st.online || st.storedOre > 0 ? 'sad' : st.charge >= 8 ? 'happy' : 'wait';
    FACE_RIM.forEach((bits, r) => { for (let c = 0; c < 12; c++) if (bits & (2048 >> c)) px(3 + c, 4 + r); });
    const eyesShut = frame % 40 === 0;
    if (eyesShut) { px(6, 8, 2, 1); px(10, 8, 2, 1); } else { px(6, 7, 2, 2); px(10, 7, 2, 2); }
    for (const [c, r] of MOUTHS[mood]) px(3 + c, 4 + r);
    const bars = Math.min(4, Math.floor(st.charge / 2));
    px(22, 4, 20, 10); g.fillStyle = LCD; px(23, 5, 18, 8); g.fillStyle = INK; px(42, 7, 2, 4);
    for (let i = 0; i < bars; i++) px(24 + i * 4, 6, 3, 6);
    text(st.charge > 9999 ? '9999+' : String(st.charge), 22, 18);
    if (st.storedOre > 0 && frame % 8 < 5) px(3, 27, 42, 2);
    if (!st.online) { px(3, 27, 2, 2); px(7, 27, 2, 2); px(11, 27, 2, 2); }
  };

  commander.onChange((s) => {
    st = s;
    el.title = about();
    el.setAttribute('aria-label', 'VMU: ' + about());
  });
  live.onBlock(() => { blink = 6; });
  // A battle won anywhere in this browser: the pet notices (and may grow).
  const checkWins = () => {
    const w = loadRecord().wins;
    if (w > wins) {
      heart = 24;
      // Hatched (first win) or grown up (fifth): the VMU lights up and chirps.
      if ((wins < 1 && w >= 1) || (wins < 5 && w >= 5)) { el.classList.remove('vmu-flash'); void el.offsetWidth; el.classList.add('vmu-flash'); audio.play('confirm'); }
    }
    wins = w;
    el.title = about();
    el.setAttribute('aria-label', 'VMU: ' + about());
  };
  window.addEventListener('storage', checkWins);
  setInterval(checkWins, 3000);
  // Eight frames a second, as an LCD would; nothing while the tab or the VMU (narrow screens) is hidden.
  setInterval(() => { if (document.hidden || !el.isConnected || el.offsetParent === null) return; frame++; draw(); }, 125);
  draw();
  return el;
}
