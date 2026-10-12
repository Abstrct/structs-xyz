/* Shared pieces for the Intel tabs: the tab context, id links, stat tiles, guild logos, and
 * loading/error states. */
import { h } from '../../core/dom';
import { audio } from '../../core/audio';
import { store } from '../../chain/store';
import { GuildApiError, type GuildApi } from '../../guild/api';
import { guildLabel, type GuildMeta } from '../../guild/directory';
import { hrefFor } from '../../grass/describe';
import { icon } from '../icons';

export interface IntelCtx {
  body: HTMLElement;
  navigate(hash: string): void;
  /** Route argument (#/intel/<tab>/<arg>). */
  arg?: string;
  /** The guild whose Guild API (and GRASS) Intel reads from. */
  guildId: string;
  api: GuildApi;
  /** Teardown for listeners and timers. */
  cleanup: (() => void)[];
  /** Re-mount the current tab (after a source switch…). */
  refresh(): void;
  /** False once the tab is gone: async work checks it before painting. */
  alive(): boolean;
}

/** A clickable id (player/planet/guild) or plain text. */
export function idLink(ctx: Pick<IntelCtx, 'navigate'>, text: string, id?: string): HTMLElement {
  const href = id ? hrefFor(id) : null;
  if (!href) return h('span', { class: id ? 'id-plain' : '' }, text);
  return h('a', { class: 'id-link' + (id!.startsWith('1-') ? ' who' : ''), href, title: id, onclick: (e: Event) => { e.preventDefault(); audio.play('select'); ctx.navigate(href); } }, text);
}


export function playerLink(ctx: Pick<IntelCtx, 'navigate'>, id: string, name?: string): HTMLElement {
  return idLink(ctx, name || store.playerName(id), id);
}

/** A stat tile, number first: [icon] value, then a word or two. A string `sub` (what the number
 * means) is the hover and shows in Expert mode; a Node sub (a sparkline) stays on screen. */
export function tile(label: string, value: string | Node, sub?: string | Node, tone = '', ico?: string): HTMLElement {
  const words = typeof sub === 'string' ? sub : null;
  return h('div', { class: 'itile ' + tone, title: words ? `${label}: ${words}` : label },
    h('div', { class: 'itile-v' }, ico ? h('span', { class: 'itile-ico', html: icon(ico, 18) }) : null, value),
    h('div', { class: 't-label' }, label),
    sub ? h('div', { class: 't-tiny c-hint itile-sub' + (words ? ' x-only' : '') }, sub) : null);
}

/** A section: an optional icon and a word or two; `hint` (the longer name) is the head's hover. */
export function section(title: string | { text: string; hint?: string; icon?: string }, ...kids: (Node | null | false)[]): HTMLElement {
  const t = typeof title === 'string' ? { text: title } : title;
  return h('section', { class: 'isec' }, h('div', { class: 'isec-head', title: t.hint || null }, t.icon ? h('span', { class: 'isec-ico', html: icon(t.icon, 18) }) : null, h('span', { class: 't-label-lg' }, t.text)), ...kids.filter((k): k is Node => !!k));
}

/** A signal meter where a number is about to land (dc-polish.css): never a bare ellipsis. */
export function waiting(title = 'Reading the testnet…'): HTMLElement {
  return h('span', { class: 'dcp-bars', role: 'img', 'aria-label': 'Reading', title }, h('i'), h('i'), h('i'), h('i'));
}

/** Reading: the receiving pill (a dish, a signal meter, one word); what is being read is the hover.
 * Not a live region: tabs rebuild these as data lands, and the screen's own status says it once. */
export function loading(text = 'Reading…', ico = 'news', word = 'Reading'): HTMLElement {
  return h('div', { class: 'iloading', title: text },
    h('span', { class: 'dcp-rx' }, h('span', { class: 'dcp-dish', 'aria-hidden': 'true', html: icon(ico, 16) }), waiting(text), word));
}

/** A live feed with nothing in it yet: the same pill, listening. Feeds remove `.empty-live` when
 * their first row lands. */
export function listening(title: string): HTMLElement {
  const el = loading(title, 'news', 'Listening');
  el.classList.add('empty-live');
  return el;
}

/** A list (or a whole tab) still dialling in: a dish under a scan line, a meter and a word or two;
 * the sentence is the hover. `calm` once connected and only waiting: the rings go on, the sweep stops. */
export function receiving(words: string, title: string, ico = 'news', calm = false): HTMLElement {
  return h('div', { class: 'dcp-scan' + (calm ? ' calm' : ''), title },
    h('span', { class: 'dcp-dish big', 'aria-hidden': 'true', html: icon(ico, 34) }),
    h('span', { class: 'dcp-scan-line' }, waiting(title), h('span', { class: 'dcp-word' }, words)));
}

/** A quiet "nothing here": a few words on screen, the sentence on hover. */
export function quiet(words: string, title?: string): HTMLElement {
  return h('div', { class: 'iquiet t-tiny c-hint', title: title || null }, words);
}

export function errorBox(e: unknown): HTMLElement {
  const msg = e instanceof Error ? e.message : String(e);
  // A guild that doesn't open its API to this site: say so in two words with a lock, the
  // sentence on hover and the details for experts.
  if (e instanceof GuildApiError && e.code === 'blocked') return h('div', { class: 'ierror dct-locked t-tiny', title: msg },
    h('span', { html: icon('lock', 16) }), h('span', { class: 't-label' }, 'Members only'), h('span', { class: 'x-only' }, ` ${msg}${e.errors.detail ? ` (${e.errors.detail})` : ''}`));
  return h('div', { class: 'ierror t-tiny' }, h('span', { class: 't-label c-enemy' }, 'Unavailable'), ' ', msg);
}

/** A guild's logo, or its tag drawn as a monogram when it has none (or the image fails). */
export function guildLogo(id: string, meta: Pick<GuildMeta, 'logo' | 'tag' | 'name'> | null, cls = ''): HTMLElement {
  const tag = (meta?.tag || guildLabel(id).tag || '?').slice(0, 4);
  const box = h('div', { class: 'glogo ' + cls, style: `--gc:#${store.guildColor(id).toString(16).padStart(6, '0')}` }, h('span', null, tag));
  if (meta?.logo) {
    const img = h('img', { src: meta.logo, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', draggable: false });
    img.addEventListener('error', () => img.remove());
    img.addEventListener('load', () => box.classList.add('has-img'));
    box.appendChild(img);
  }
  return box;
}

/** Run `load`, show loading, then its content; a missing session shows the sign-in CTA instead. */
export function slot<T>(ctx: IntelCtx, load: () => Promise<T>, paint: (v: T) => Node, opts: { cta?: string; quiet?: boolean } = {}): HTMLElement {
  const el = h('div', { class: 'islot' }, opts.quiet ? null : loading());
  load().then((v) => { if (ctx.alive()) el.replaceChildren(paint(v)); }, (e) => {
    if (!ctx.alive()) return;
    el.replaceChildren(errorBox(e));
  });
  return el;
}

export const short = (s: string, n = 10) => (s.length > n + 3 ? s.slice(0, n) + '…' + s.slice(-4) : s);
export const timeOf = (iso: string | number) => { const d = new Date(iso); return Number.isNaN(+d) ? '' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
