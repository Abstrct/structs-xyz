/* The DC kit's icons: chunky round-stroke glyphs on a 24×24 grid, drawn in currentColor so each
 * hub tints its own. An icon is the label: every place, verb and resource has one, so the screen
 * can say it without words. */

const svg = (body: string, size = 16) => `<svg class="ico" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const solid = (d: string) => `<path d="${d}" fill="currentColor" stroke="none"/>`;

const GLYPHS: Record<string, string> = {
  // Places (the six hubs).
  base: '<path d="M3 11 L12 4 L21 11 V20 H14 V14 H10 V20 H3 Z"/>',
  battle: '<path d="M5 5 L19 19 M19 5 L5 19 M15 19 L19 15 M5 15 L9 19"/>',
  explore: '<circle cx="12" cy="12" r="5"/><ellipse cx="12" cy="12" rx="10.5" ry="3.6" transform="rotate(-20 12 12)"/>',
  trade: '<path d="M4 8 H19 L15 4 M20 16 H5 L9 20"/>',
  team: '<circle cx="8" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M2 20 C2 15 5 13 8 13 C11 13 14 15 14 20 M15 14 C19 14 22 16 22 20"/>',
  lab: '<path d="M9 3 H15 M10 3 V9 L4 19 C3 21 4 21 5 21 H19 C20 21 21 21 20 19 L14 9 V3 M7 15 H17"/>',
  // The top bar.
  academy: '<path d="M2 9 L12 4 L22 9 L12 14 Z M6 11 V16 C8 18 16 18 18 16 V11 M22 9 V15"/>',
  find: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 L21 21"/>',
  more: solid('M4 10.5 A2 2 0 1 0 4 13.5 A2 2 0 1 0 4 10.5 Z M12 10.5 A2 2 0 1 0 12 13.5 A2 2 0 1 0 12 10.5 Z M20 10.5 A2 2 0 1 0 20 13.5 A2 2 0 1 0 20 10.5 Z'),
  help: '<path d="M9 9 C9 6 15 6 15 9.5 C15 12 12 12 12 15"/><circle cx="12" cy="19.5" r="0.6" fill="currentColor"/>',
  star: solid('M12 2.5 L14.8 9 L21.5 9.4 L16.4 13.8 L18 20.5 L12 16.8 L6 20.5 L7.6 13.8 L2.5 9.4 L9.2 9 Z'),
  check: '<path d="M4 12.5 L9.5 18 L20 6"/>',
  play: solid('M7 4 L20 12 L7 20 Z'),
  book: '<path d="M12 6 C9 4 5 4 3 5 V19 C5 18 9 18 12 20 C15 18 19 18 21 19 V5 C19 4 15 4 12 6 Z M12 6 V20"/>',
  terminal: '<rect x="2.5" y="4" width="19" height="16" rx="3"/><path d="M7 9 L10 12 L7 15 M12.5 15 H17"/>',
  // Things the game counts: the icon goes next to the number.
  alpha: solid('M12 3 L20 12 L12 21 L4 12 Z'),
  ore: solid('M4 16 L7 8 L13 5 L19 9 L20 16 L13 20 Z'),
  charge: solid('M13 2 L5 13 H11 L10 22 L19 10 H13 Z'),
  shield: solid('M12 3 L20 6 V12 C20 17 16 20 12 21 C8 20 4 17 4 12 V6 Z'),
  // A plug: power you draw.
  power: '<path d="M9 2 V7 M15 2 V7 M6 7 H18 V11 A6 6 0 0 1 6 11 Z M12 17 V22"/>',
  planet: '<circle cx="12" cy="12" r="8"/><path d="M5 9 C9 11 15 11 19 9 M6 16 C10 14 14 14 18 16"/>',
  ship: solid('M3 6 L21 12 L3 18 L7 12 Z'),
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7 V12 L15.5 14"/>',
  // Screens inside the hubs.
  record: solid('M12 2.5 L14.8 9 L21.5 9.4 L16.4 13.8 L18 20.5 L12 16.8 L6 20.5 L7.6 13.8 L2.5 9.4 L9.2 9 Z'),
  queue: '<path d="M4 6 H14 M4 12 H11 M4 18 H14 M17 9 L21 12 L17 15"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><path d="M12 1.5 V5 M12 19 V22.5 M1.5 12 H5 M19 12 H22.5"/>',
  daily: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10 H21 M8 3 V7 M16 3 V7"/><circle cx="12" cy="15.5" r="2" fill="currentColor"/>',
  replay: '<path d="M4 12 A8 8 0 1 0 7 5.8 M4 3 V8 H9"/><path d="M10 9 L15 12 L10 15 Z" fill="currentColor"/>',
  grid: solid('M13 2 L5 13 H11 L10 22 L19 10 H13 Z'),
  news: '<path d="M4 20 C2 14 4 8 9 5 M20 20 C22 14 20 8 15 5"/><circle cx="12" cy="11" r="2.5" fill="currentColor"/><path d="M12 13.5 V21"/>',
  fuel: '<path d="M12 3 C8 9 6 12 6 15 A6 6 0 0 0 18 15 C18 12 16 9 12 3 Z"/>',
  market: '<path d="M12 3 V21 M5 21 H19 M4 8 H20 M4 8 L1.5 14 H6.5 Z M20 8 L17.5 14 H22.5 Z"/>',
  bank: '<path d="M3 9 L12 4 L21 9 Z M5 10 V18 M9.5 10 V18 M14.5 10 V18 M19 10 V18 M3 21 H21"/>',
  send: '<path d="M3 12 L21 4 L15 21 L11 13 Z M11 13 L21 4"/>',
  chat: '<path d="M4 5 H20 C21 5 21 6 21 6 V15 C21 16 20 16 20 16 H10 L5 20 V16 H4 C3 16 3 15 3 15 V6 C3 5 4 5 4 5 Z"/>',
  flag: '<path d="M5 21 V4 M5 4 H18 L15 8.5 L18 13 H5"/>',
  code: '<path d="M8 6 L2.5 12 L8 18 M16 6 L21.5 12 L16 18 M14 4 L10 20"/>',
  robot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8 V4 M2 13 V16 M22 13 V16"/><circle cx="9" cy="13.5" r="1.4" fill="currentColor"/><circle cx="15" cy="13.5" r="1.4" fill="currentColor"/>',
  rules: '<path d="M8 6 H20 M8 12 H20 M8 18 H20"/><path d="M3.5 6 L4.5 7 L6 5 M3.5 12 L4.5 13 L6 11 M3.5 18 L4.5 19 L6 17"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2 V6 M15 2 V6 M9 18 V22 M15 18 V22 M2 9 H6 M2 15 H6 M18 9 H22 M18 15 H22"/>',
  health: '<path d="M2 12 H6 L9 5 L14 19 L17 12 H22"/>',
  sound: '<path d="M4 9 H8 L13 5 V19 L8 15 H4 Z M17 8.5 C19 10.5 19 13.5 17 15.5"/>',
  mute: '<path d="M4 9 H8 L13 5 V19 L8 15 H4 Z M17 9.5 L22 14.5 M22 9.5 L17 14.5"/>',
  gear: '<circle cx="12" cy="12" r="3.5"/><path d="M12 2 V5 M12 19 V22 M2 12 H5 M19 12 H22 M4.9 4.9 L7 7 M17 17 L19.1 19.1 M4.9 19.1 L7 17 M17 7 L19.1 4.9"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="3"/><path d="M8 10 V7 A4 4 0 0 1 16 7 V10"/>',
  back: '<path d="M10 5 L3 12 L10 19 M3 12 H21"/>',
  // The base screens: the four battlegrounds, a pick for ore still in the ground, a build slot.
  space: solid('M12 2 L14.2 9.8 L22 12 L14.2 14.2 L12 22 L9.8 14.2 L2 12 L9.8 9.8 Z'),
  air: '<path d="M7 18 H17 A4 4 0 0 0 17 10 A5.5 5.5 0 0 0 6.5 9 A4.5 4.5 0 0 0 7 18 Z"/>',
  land: '<path d="M2 20 L9 8 L13 14 L16 10 L22 20 Z"/>',
  water: '<path d="M2 9 C5 6 7 6 9.5 9 C12 12 14 12 16.5 9 C19 6 21 7 22 8 M2 16 C5 13 7 13 9.5 16 C12 19 14 19 16.5 16 C19 13 21 14 22 15"/>',
  mine: '<g transform="rotate(-35 12 12)"><path d="M4 8.5 Q12 2 20 8.5 M12 5.2 V22"/></g>',
  build: '<rect x="3" y="3" width="18" height="18" rx="5"/><path d="M12 8 V16 M8 12 H16"/>',
  eye: '<path d="M2 12 C5 6.5 8.5 5 12 5 C15.5 5 19 6.5 22 12 C19 17.5 15.5 19 12 19 C8.5 19 5 17.5 2 12 Z"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
  refresh: '<path d="M20 12 A8 8 0 1 1 17 5.8 M20 3 V8 H15"/>',
  // The Lab: hashing, speed, keys, copying.
  hash: '<path d="M9.5 3 L7.5 21 M16.5 3 L14.5 21 M4 8.5 H20.5 M3.5 15.5 H20"/>',
  gauge: '<path d="M3.5 17 A9 9 0 1 1 20.5 17"/><path d="M12 14 L16.5 8.5"/><circle cx="12" cy="14" r="1.8" fill="currentColor"/>',
  key: '<circle cx="7.5" cy="12" r="4.5"/><path d="M12 12 H22 M18 12 V16 M21 12 V15"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="3"/><path d="M16 8 V5 A2 2 0 0 0 14 3 H5 A2 2 0 0 0 3 5 V14 A2 2 0 0 0 5 16 H8"/>',
  // Fires back: a shield that shoots out when hit (not the ↻ of replay or shuffle).
  counter: '<path d="M15.5 3.5 L21.5 6 V11 C21.5 15.2 18.8 18.1 15.5 19.2 C12.2 18.1 9.5 15.2 9.5 11 V6 Z"/><path d="M9.5 11.5 H2.5 M6 8 L2.5 11.5 L6 15"/>',
  // The watch screens (replays, grid, galaxy): a hit landing, a share link, a substation, a hot spot, the mouse.
  boom: solid('M12 1.5 L14.3 8 L20.5 4.5 L17 10.7 L23 13 L16.5 14.7 L18.5 21.5 L12 17.3 L5.5 21.5 L7.5 14.7 L1 13 L7 10.7 L3.5 4.5 L9.7 8 Z'),
  link: '<path d="M9.5 14.5 L14.5 9.5 M11 6.5 L13 4.5 A4.2 4.2 0 0 1 19.5 11 L17.5 13 M13 17.5 L11 19.5 A4.2 4.2 0 0 1 4.5 13 L6.5 11"/>',
  station: '<path d="M12 2.5 L20.2 7.2 V16.8 L12 21.5 L3.8 16.8 V7.2 Z"/><circle cx="12" cy="12" r="2.8" fill="currentColor"/>',
  hot: '<path d="M12 21.5 C7.5 21.5 5 18.2 5 14.8 C5 10.5 9 8.5 9 3 C12.5 5.2 14.2 8.2 13.8 11.2 C15.3 10.4 15.8 8.8 15.8 7.6 C18.2 9.6 19 12.3 19 14.8 C19 18.4 16.5 21.5 12 21.5 Z"/>',
  mouse: '<rect x="6" y="2.5" width="12" height="19" rx="6"/><path d="M12 6.5 V10"/>',
  // Trade and Team: a guild rank (chevrons), its leader (a crown), and a feed's pause.
  rank: '<path d="M5 12 L12 6 L19 12 M5 18.5 L12 12.5 L19 18.5"/>',
  crown: solid('M3 7.5 L8 11.5 L12 4.5 L16 11.5 L21 7.5 L19.5 18.5 H4.5 Z'),
  pause: '<rect x="5.5" y="4" width="4.5" height="16" rx="1.6" fill="currentColor" stroke="none"/><rect x="14" y="4" width="4.5" height="16" rx="1.6" fill="currentColor" stroke="none"/>',
  // Added for the battle and the top bar (usability pass): shuffle, a weapon, joining.
  dice: '<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="16" cy="16" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="16" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="16" r="1.3" fill="currentColor"/>',
  missile: '<path d="M4 20 L8 16 M15 3 H21 V9 L10 20 L4 14 Z M7 13 L4 12 M11 17 L12 20"/>',
  join: '<circle cx="10" cy="8" r="4"/><path d="M3 21 C3 16 6 14 10 14 C12 14 13.5 14.5 14.5 15.5 M19 14 V22 M15 18 H23"/>',
};

/** Each hub menu item's picture, by its path (or action). */
export const ITEM_ICONS: Record<string, string> = {
  '/command': 'base', '/ops/record': 'record', '/ops/queue': 'queue',
  '/sim': 'target', '/sim/daily': 'daily', '/combat': 'replay', '/codex': 'book',
  '/galaxy': 'explore', '/grid': 'grid', '/intel': 'news',
  '/economy/power': 'power', '/economy/fuel': 'fuel', '/economy/market': 'market', '/economy/banks': 'bank', '/economy/transfers': 'send',
  '/comms': 'chat', '/guild': 'team', '/intel/guilds': 'flag',
  palette: 'terminal', '/forge': 'code', '/ops/replicants': 'robot', '/ops/orders': 'rules', '/ops/proofs': 'chip', '/ops/health': 'health',
};

/** An icon's SVG markup by name (an empty ring for an unknown name). */
export function icon(name: string, size = 16): string {
  return svg(GLYPHS[name] || '<circle cx="12" cy="12" r="8"/>', size);
}

/** The brand mark: the Structs emblem, the same chevron as the app icon (public/icon.svg), in flat
 *  colours: a teal hull with the dark cut through its middle. */
export const MARK = '<svg class="mark" viewBox="2 3 12 10" aria-hidden="true">'
  + '<path d="M2.5 3.5h7.5l3.5 4.5-3.5 4.5H2.5l3.5-4.5z" fill="#43CDB6"/>'
  + '<path d="M2.5 3.5h7.5l1.75 2.25H4.25z" fill="#D8FCF2" opacity=".55"/>'
  + '<path d="M6 8l-2.2-2.8H8.1L10.3 8 8.1 10.8H3.8z" fill="#0B1240"/></svg>';
