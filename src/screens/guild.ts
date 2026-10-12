/* The Guild Hall: your guild from the inside. The roster and its ranks, the membership desk
 * (requests, invites, approvals, kicks), joining another guild, and the permission system —
 * who may do what with your objects — down to the bit.
 *   #/guild                 your guild
 *   #/guild/<guildId>       another guild (request to join)
 *   #/guild/perms           permissions on your player and objects */
import '../styles/ops.css';
import '../styles/dc-trade.css';
import type { Engine } from '../core/engine';
import { h, toast, confirmBox, portrait } from '../core/dom';
import { audio } from '../core/audio';
import { PanelScreen } from './panelScreen';
import { store } from '../chain/store';
import { LCD_URL } from '../chain/lcd';
import { wallet } from '../wallet/wallet';
import { txq } from '../wallet/queue';
import { empire } from '../game/empire';
import { openVault } from '../ui/vault';
import { kids } from '../ui/opsDock';
import { loadGuilds, type GuildEntry } from '../game/onboard';
import { replaceRoute } from '../core/nav';
import { icon } from '../ui/icons';
import { guildLabel } from '../guild/directory';
import { keepFocus } from '../ui/keepFocus';

/** Roster tiles per page: a page of faces, console style; the filter finds anyone. */
const PAGE = 24;

/** structsd v0.21 permission bits (x/structs/types/permissions.go). */
export const PERMS: [number, string, string][] = [
  [1, 'Play', 'Struct actions: build, attack, move, defend…'], [2, 'Admin', 'Grant and revoke permissions'], [4, 'Update', 'Change settings'], [8, 'Delete', 'Delete the object'],
  [16, 'Transfer', 'Send tokens'], [32, 'Infuse', 'Infuse reactors'], [64, 'Migrate', 'Move infusions'], [128, 'Defuse', 'Withdraw infusions'],
  [256, 'Allocations', 'Create and change energy allocations'], [512, 'Membership', 'Guild membership decisions'], [1024, 'Substation link', 'Connect to substations'], [2048, 'Allocation link', 'Connect allocations'],
  [4096, 'Token burn', 'Confiscate and burn guild tokens'], [8192, 'Token mint', 'Mint guild tokens'], [16384, 'Endpoint', 'Update the guild endpoint'], [32768, 'Join rules', 'Join minimum and bypass'],
  [65536, 'Entry substation', 'Update the entry substation'], [131072, 'Provider withdraw', 'Withdraw provider balance'], [262144, 'Provider open', 'Open restricted agreements'], [524288, 'Guild charter', 'Create a guild from a reactor'],
  [1 << 20, 'Hash build', 'Submit build proofs'], [1 << 21, 'Hash mine', 'Submit mining proofs'], [1 << 22, 'Hash refine', 'Submit refining proofs'], [1 << 23, 'Hash raid', 'Submit raid proofs'], [1 << 24, 'Guild UGC', 'Rename guild-owned objects'],
];
export const PERM_ALL = 33554431;

interface Application { guildId: string; playerId: string; joinType: string; registrationStatus: string; proposer: string; substationId: string }
interface PermRecord { permissionId: string; value: string }

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(LCD_URL + path);
  if (!r.ok) throw new Error('LCD ' + r.status);
  return r.json() as Promise<T>;
}

export class GuildScreen extends PanelScreen {
  private body!: HTMLElement;
  private nav!: HTMLElement;
  private view: 'hall' | 'perms' = 'hall';
  private guildId = '';
  private directory: GuildEntry[] = [];
  private apps: Application[] = [];
  private filter = '';
  private page = 0;
  /** The screen's one live region (visually hidden): says once when the roster is being read. */
  private live!: HTMLElement;

  constructor(engine: Engine, navigate: (hash: string) => void) { super(engine, navigate, 'guild', 6.4); }

  protected mount(params: Record<string, string>) {
    // A fresh visit starts on the first page with no filter (the screen object is reused).
    this.filter = ''; this.page = 0;
    this.view = params.guild === 'perms' ? 'perms' : 'hall';
    this.guildId = params.guild && params.guild !== 'perms' ? params.guild : this.myGuild() || '';
    this.nav = h('div', { class: 'ops-nav dct-tabs' });
    this.body = h('div', { class: 'ops-page scroll' });
    this.live = h('span');
    this.root.append(h('div', { class: 'ops-wrap panel player dct-guild', style: '--hub:#B794F0' },
      h('div', { class: 'panel-head dct-guild-head' }, h('span', { class: 'dct-title-ico', title: 'Guild Hall: your team, its members and ranks, and who may act for you', html: icon('team', 24) }), this.nav), this.body,
      h('span', { class: 'dcp-sr', role: 'status' }, this.live)));
    this.cleanup.push(store.onCore(() => this.paint()), wallet.onChange(() => this.paint()),
      // Only membership moves change the desk; and never repaint over a form being filled in.
      txq.onSettled((j) => { if (j.msgs.some((m) => /GuildMembership|PlayerUpdateGuildRank/.test(m.typeUrl))) void this.loadApps().then(() => { if (this.view === 'hall' && !this.typing()) this.paint(); }); }));
    this.paint();
    void loadGuilds().then((g) => { this.directory = g; this.paint(); }).catch(() => { /* the chain registry still names them */ });
    // Never waited on: a slow testnet must not hold the screen (or, on a first load, the boot
    // splash) back. The hall shows its receiving state until the roster lands.
    void store.loadCore().catch(() => { /* the receiving state stays; Retry is the hub again */ });
    void this.loadApps().then(() => this.paint());
  }

  private myGuild() { const pid = wallet.active?.playerId; return pid ? store.players.get(pid)?.guildId || empire.players.get(pid)?.guildId || '' : ''; }
  private me() { const pid = wallet.active?.playerId; return pid ? store.players.get(pid) : undefined; }

  private async loadApps() {
    try { this.apps = (await getJson<{ GuildMembershipApplication: Application[] }>('/structs/guild_membership_application?pagination.limit=2000')).GuildMembershipApplication || []; } catch { this.apps = []; }
  }

  private q(typeUrl: string, value: Record<string, unknown>, label: string) {
    if (wallet.state !== 'unlocked') { openVault(); return; }
    try { txq.enqueue({ typeUrl: '/structs.structs.' + typeUrl, value }, { label, source: 'you' }); audio.play('confirm'); toast(label + ' — queued', 'player'); }
    catch (e) { audio.play('deny'); toast((e as Error).message, 'enemy'); }
  }

  private typing() { const a = document.activeElement as HTMLElement | null; return !!a && this.root.contains(a) && /INPUT|SELECT|TEXTAREA/.test(a.tagName); }
  private paintToken = 0;

  /** Repaint, keeping a keyboard or pad cursor on the same control (by its data-k key). */
  // (A control that is gone, such as a lobby card just pressed, hands the cursor to the active pill.)
  private paint() { if (this.root?.isConnected) keepFocus(this.root, () => this.paintNow(), () => this.root.querySelector<HTMLElement>('.dct-tab.active')); }

  private paintNow() {
    const token = ++this.paintToken;
    const guilds = [...store.guilds.values()];
    // Icon pills: the Hall, Permissions, then one pill per guild (its colour and tag; the name is the hover).
    const pill = (key: string, on: boolean, ico: string | HTMLElement, label: string, title: string, run: () => void) => h('button', { class: 'btn dct-tab' + (on ? ' active' : ''), title, 'data-k': 'tab:' + key, onclick: run },
      typeof ico === 'string' ? h('span', { class: 'dct-tab-ico', html: icon(ico, 18) }) : ico, h('span', { class: 'dct-word' }, label));
    this.nav.replaceChildren(
      // Hall is your own guild's hall (or the way to pick one); a guild's pill shows any guild.
      pill('hall', this.view === 'hall' && this.guildId === this.myGuild(), 'team', 'Hall', 'Guild Hall: your guild', () => { this.view = 'hall'; this.guildId = this.myGuild(); this.page = 0; replaceRoute('/guild' + (this.guildId ? '/' + this.guildId : '')); this.paint(); }),
      pill('perms', this.view === 'perms', 'lock', 'Permissions', 'Permissions: who may act for your commander', () => { this.view = 'perms'; replaceRoute('/guild/perms'); this.paint(); }),
      ...guilds.map((g) => pill(g.id, this.view === 'hall' && g.id === this.guildId, h('span', { class: 'dct-gdot', style: `--gc:#${store.guildColor(g.id).toString(16).padStart(6, '0')}` }), guildLabel(g.id).tag, this.name(g.id),
        () => { this.view = 'hall'; this.guildId = g.id; this.page = 0; replaceRoute('/guild/' + g.id); audio.play('select'); this.paint(); })));
    if (this.view === 'perms') { void this.paintPerms(token); return; }
    this.paintHall();
  }

  private name(id: string) { return this.directory.find((d) => d.id === id)?.meta?.name || store.guildName(id); }

  /** While the roster is read: the receiving pill, then the hall's shape (the guild's card and a
   * page of faces) as placeholders under a scan line, as Trade does. */
  private receiving(): HTMLElement[] {
    const bars = () => h('span', { class: 'dcp-bars', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i'));
    return [
      h('span', { class: 'dcp-rx', 'aria-hidden': 'true', title: 'Receiving: reading the guilds and their members from the testnet…' },
        h('span', { class: 'dcp-dish', html: icon('team', 16) }), bars(), 'Receiving'),
      h('div', { class: 'foundry panel dct-ghero dct-skel dcp-sweep', 'aria-hidden': 'true' }, h('i', { class: 'big w40' }), h('i', { class: 'w60' }), h('i', { class: 'w30' })),
      h('div', { class: 'guild-roster dct-roster dcp-sweep', 'aria-hidden': 'true' }, ...Array.from({ length: 8 }, () =>
        h('div', { class: 'dct-member dct-skel dcp-ghost' }, h('span', { class: 'dcp-face' }), h('i', { class: 'w60' }), h('i', { class: 'w30' })))),
    ];
  }

  private paintHall() {
    const g = store.guilds.get(this.guildId);
    const said = store.coreLoaded ? '' : 'Reading the guild roster…';
    if (this.live.textContent !== said) this.live.textContent = said;
    if (!g) {
      if (!store.coreLoaded) { this.body.replaceChildren(...this.receiving()); return; }
      // Not in a guild yet: the hall is a lobby of guild cards to look inside, biggest first,
      // with one verb on top (Enlist, or Compare once you have a vault). What guilds are is the hover.
      const list = [...store.guilds.values()].sort((a, b) => store.members(b.id) - store.members(a.id));
      this.body.replaceChildren(
        h('div', { class: 'dct-blank guild-empty', title: 'Guilds are teams. Players in a guild share power, chat together and help each other out. Look inside any guild below, or compare them all in News & Rankings.' },
          h('span', { class: 'dct-blank-ico', html: icon('team', 26) }), h('span', { class: 'dct-blank-words' }, 'Pick a guild'),
          wallet.state === 'empty' ? h('button', { class: 'btn solid', title: 'Enlist a commander and join a guild', onclick: () => openVault() }, 'Enlist')
            : h('a', { class: 'btn solid', href: '/intel/guilds', title: 'Compare all guilds' }, 'Compare')),
        h('div', { class: 'dct-gcards' }, ...list.map((x) => {
          const name = this.name(x.id), tag = guildLabel(x.id).tag;
          return h('button', { class: 'dct-gcard', 'data-k': 'guild:' + x.id, style: `--gc:#${store.guildColor(x.id).toString(16).padStart(6, '0')}`, title: `Look inside ${name}`,
            onclick: () => { this.view = 'hall'; this.guildId = x.id; this.page = 0; replaceRoute('/guild/' + x.id); audio.play('select'); this.paint(); } },
            h('span', { class: 'dct-gmono' }, tag.slice(0, 4)),
            h('span', { class: 'dct-gcard-name' }, name),
            h('span', { class: 'dct-num', title: `${store.members(x.id)} members` }, h('span', { class: 'dct-num-ico', html: icon('team', 16) }), String(store.members(x.id))),
            h('span', { class: 'dct-gcard-go' }, h('span', { class: 'dc-face a' }, 'A'), 'Look'));
        })));
      return;
    }
    const meta = this.directory.find((d) => d.id === g.id)?.meta;
    const me = this.me();
    const mine = me?.guildId === g.id;
    const owner = store.players.get(g.owner);
    const members = [...store.players.values()].filter((p) => p.guildId === g.id);
    const pending = this.apps.filter((a) => a.guildId === g.id && a.registrationStatus === 'proposed');
    const myApp = me ? this.apps.find((a) => a.guildId === g.id && a.playerId === me.id && a.registrationStatus === 'proposed') : undefined;
    const f = this.filter.toLowerCase();
    const matched = members.filter((p) => !f || (p.name || '').toLowerCase().includes(f) || p.id.includes(f)).sort((a, b) => Number(a.guildRank) - Number(b.guildRank) || Number(b.index) - Number(a.index));
    const pages = Math.max(1, Math.ceil(matched.length / PAGE));
    this.page = Math.min(this.page, pages - 1);
    const shown = matched.slice(this.page * PAGE, this.page * PAGE + PAGE);
    const search = h('input', { class: 'input mini-select dct-find', placeholder: 'find a member…', value: this.filter, 'aria-label': 'Find a member', title: 'Filter by name or player id' }) as HTMLInputElement;
    // The repaint replaces the box: put the caret back in the new one (not the invite box beside it).
    search.addEventListener('input', () => { this.filter = search.value; this.page = 0; const pos = search.selectionStart; this.paintHall(); const s2 = this.body.querySelector('input.dct-find') as HTMLInputElement | null; s2?.focus(); s2?.setSelectionRange(pos, pos); });
    const invite = h('input', { class: 'input mini-select', placeholder: 'player id or name to invite', 'aria-label': 'Player to invite' }) as HTMLInputElement;
    const turn = (d: number) => { this.page = (this.page + d + pages) % pages; audio.play('select'); keepFocus(this.body, () => this.paintHall()); };
    const closed = (g as unknown as { joinInfusionMinimumBypassByRequest?: string }).joinInfusionMinimumBypassByRequest === 'closed';
    // The guild's card: name and tag big, its motto, then numbers with pictures (members, leader);
    // the chain's settings are an expert's detail.
    this.body.replaceChildren(...kids(
      h('div', { class: 'foundry panel dct-ghero' },
        h('div', { class: 'col grow', style: 'gap:6px; min-width:0' },
          h('div', { class: 'row wrap' }, h('div', { class: 't-display c-player' }, meta?.name || this.name(g.id)), meta?.tag ? h('span', { class: 'chip neutral x-only' }, meta.tag) : null, h('span', { class: 'chip x-only' }, g.id),
            mine ? h('span', { class: 'chip player', title: 'Your guild' }, h('span', { html: icon('check', 12) })) : null),
          meta?.description ? h('div', { class: 't-tiny c-hint dct-motto' }, meta.description) : null,
          h('div', { class: 'row wrap dct-gstats' },
            h('span', { class: 'dct-num', title: `${members.length} members` }, h('span', { class: 'dct-num-ico', html: icon('team', 16) }), String(members.length)),
            h('a', { class: 'dct-num dct-leader', href: '/player/' + g.owner, title: `Led by ${owner?.name || g.owner}` }, h('span', { class: 'dct-num-ico', html: icon('crown', 16) }), owner?.name || g.owner),
            h('span', { class: 'x-only t-tiny c-hint' }, `entry rank ${g.entryRank} · join minimum ${g.joinInfusionMinimum} ualpha · reactor ${g.primaryReactorId} · entry substation ${g.entrySubstationId}`))),
        h('div', { class: 'col dct-gacts', style: 'gap:6px' },
          mine ? h('button', { class: 'btn ghost', title: 'Guild chat', onclick: () => this.navigate('/comms') }, h('span', { html: icon('chat', 16) }), 'Chat') : null,
          me && !mine && !myApp && closed ? h('span', { title: 'This guild takes members by invitation only (requests are closed).' }, h('span', { class: 'chip warn' }, h('span', { html: icon('lock', 12) }), 'invite only')) : null,
          me && !mine && !myApp && !closed ? h('button', { class: 'btn solid', title: `Ask ${this.name(g.id)} to take you in`, onclick: async () => {
            if (await confirmBox('Request to join', `Ask ${this.name(g.id)} to take you in? If they approve, you leave ${store.guildName(me.guildId)} and connect to their entry substation.`, 'Send request', 'player'))
              this.q('MsgGuildMembershipRequest', { guildId: g.id, playerId: me.id }, `Request to join ${this.name(g.id)}`);
          } }, 'Join') : null,
          // Only a request of yours can be withdrawn; an invite is answered on the desk below.
          myApp?.joinType === 'request' ? h('button', { class: 'btn ghost', title: 'Withdraw your join request', onclick: () => this.q('MsgGuildMembershipRequestRevoke', { guildId: g.id, playerId: me!.id }, 'Withdraw join request') }, 'Withdraw') : null,
          h('button', { class: 'btn ghost', title: 'This guild in News & Rankings', onclick: () => this.navigate('/intel/guild/' + g.id) }, h('span', { html: icon('news', 16) }), 'Intel'))),
      pending.length ? h('div', { class: 'panel dct-desk' },
        h('div', { class: 't-label-lg c-warn', title: 'Membership desk: join requests and invites waiting for an answer' }, h('span', { html: icon('flag', 16) }), ` Requests · ${pending.length}`),
        ...pending.map((a) => {
          const p = store.players.get(a.playerId);
          const isReq = a.joinType === 'request';
          return h('div', { class: 'rep' }, portrait(p?.pfpClientRenderAttributes, 'sm', a.playerId),
            h('div', { class: 'col grow', style: 'gap:2px', title: `${isReq ? 'asks to join' : 'invited'} · ${a.playerId} · from ${store.guildName(p?.guildId || '')}` }, h('span', { class: 't-label-lg' }, p?.name || a.playerId), h('span', { class: 't-tiny c-hint' }, isReq ? 'asks' : 'invited')),
            mine && isReq ? h('button', { class: 'btn mini solid', onclick: () => this.q('MsgGuildMembershipRequestApprove', { guildId: g.id, playerId: a.playerId, ...(a.substationId ? { substationId: a.substationId } : {}) }, `Approve ${p?.name || a.playerId}`) }, 'Approve') : null,
            mine && isReq ? h('button', { class: 'btn mini danger', onclick: () => this.q('MsgGuildMembershipRequestDeny', { guildId: g.id, playerId: a.playerId }, `Deny ${p?.name || a.playerId}`) }, 'Deny') : null,
            mine && !isReq ? h('button', { class: 'btn mini ghost', onclick: () => this.q('MsgGuildMembershipInviteRevoke', { guildId: g.id, playerId: a.playerId }, `Revoke invite to ${p?.name || a.playerId}`) }, 'Revoke') : null,
            !isReq && me?.id === a.playerId ? h('button', { class: 'btn mini solid', onclick: async () => {
              // Accepting moves you just like joining does: say so and ask first.
              if (await confirmBox('Accept invite', `Join ${this.name(g.id)}? You leave ${store.guildName(me.guildId)} and connect to their entry substation.`, 'Accept', 'player'))
                this.q('MsgGuildMembershipInviteApprove', { guildId: g.id, playerId: a.playerId }, `Accept invite to ${this.name(g.id)}`);
            } }, 'Accept') : null,
            !isReq && me?.id === a.playerId ? h('button', { class: 'btn mini danger', onclick: () => this.q('MsgGuildMembershipInviteDeny', { guildId: g.id, playerId: a.playerId }, 'Decline invite') }, 'Decline') : null);
        })) : null,
      mine ? h('div', { class: 'ops-bar' }, h('span', { class: 'dct-chip-ico', title: 'Invite a player', html: icon('send', 18) }), invite, h('button', { class: 'btn mini', onclick: () => {
        const v = invite.value.trim();
        const pid = /^1-\d+$/.test(v) ? v : [...store.players.values()].find((p) => p.name?.toLowerCase() === v.toLowerCase())?.id;
        if (!pid) { toast('No such commander', 'warn'); return; }
        this.q('MsgGuildMembershipInvite', { guildId: g.id, playerId: pid }, `Invite ${store.playerName(pid)}`);
      } }, 'Invite')) : null,
      h('div', { class: 'ops-bar dct-rbar' }, h('span', { class: 't-label c-hint', title: `${members.length} members` }, `Roster · ${members.length}`), h('div', { class: 'grow' }),
        pages > 1 ? h('div', { class: 'dct-pager' },
          h('button', { class: 'btn ghost dct-iconbtn', 'aria-label': 'Previous page', title: 'Previous page', 'data-k': 'pager:prev', onclick: () => turn(-1) }, '◀'),
          h('span', { class: 'dct-pager-n' }, `${this.page + 1}/${pages}`),
          h('button', { class: 'btn ghost dct-iconbtn', 'aria-label': 'Next page', title: 'Next page', 'data-k': 'pager:next', onclick: () => turn(1) }, '▶')) : null,
        search),
      // A page of faces, character-select style: the whole tile opens the player; rank is a pill.
      h('div', { class: 'guild-roster dct-roster' }, ...shown.map((p) => h('div', { class: 'dct-member' + (p.id === me?.id ? ' me' : '') },
        h('a', { class: 'dct-member-link', href: '/player/' + p.id, 'data-k': 'member:' + p.id + ':open', title: `${p.name || p.id} · ${p.id} · guild rank ${p.guildRank} (lower is senior)${p.id === g.owner ? ' · owner' : ''}` },
          portrait(p.pfpClientRenderAttributes, 'sm' + (p.id === me?.id ? ' player' : ''), p.id),
          h('span', { class: 'dct-member-name' }, p.name || p.id),
          h('span', { class: 'dct-rank' + (p.id === g.owner ? ' lead' : '') }, h('span', { html: icon(p.id === g.owner ? 'crown' : 'rank', 13) }), p.guildRank)),
        mine && me && p.id !== me.id && p.id !== g.owner ? h('div', { class: 'dct-member-acts' },
          h('button', { class: 'btn ghost mini', title: `Set ${p.name || p.id}’s guild rank`, 'data-k': 'member:' + p.id + ':rank', onclick: async () => {
            const r = prompt(`New guild rank for ${p.name || p.id} (lower is senior):`, p.guildRank);
            if (r && /^\d+$/.test(r)) this.q('MsgPlayerUpdateGuildRank', { playerId: p.id, guildRank: r, guildId: g.id }, `Rank ${p.name || p.id} → ${r}`);
          } }, 'Rank'),
          h('button', { class: 'btn ghost mini', title: `Remove ${p.name || p.id} from the guild`, 'data-k': 'member:' + p.id + ':kick', onclick: async () => {
            if (await confirmBox('Kick member', `Remove ${p.name || p.id} from the guild? They lose its substation power.`, 'Kick')) this.q('MsgGuildMembershipKick', { guildId: g.id, playerId: p.id }, `Kick ${p.name || p.id}`);
          } }, 'Kick')) : null))),
      !shown.length ? h('div', { class: 'pane-empty dct-empty', title: 'No member matches the filter' }, 'No match') : null));
  }

  /** Addresses that act as this player — the commander's own key, plus any linked "field keys". */
  private addressPanel(pid: string, addrs: { address: string; permissions: string }[]) {
    const linkable = wallet.accounts.filter((a) => !a.playerId && !addrs.some((x) => x.address === a.address));
    const pick = h('select', { class: 'input mini-select' }, ...linkable.map((a) => h('option', { value: String(a.index) }, `${a.label} · ${a.address.slice(0, 14)}…`))) as HTMLSelectElement;
    const preset = h('select', { class: 'input mini-select' },
      h('option', { value: String(1 | (0xf << 20)) }, 'Play + hash (field key)'), h('option', { value: String(0xf << 20) }, 'Hash only (proof rig)'), h('option', { value: String(PERM_ALL) }, 'Everything')) as HTMLSelectElement;
    return h('div', { class: 'panel', style: 'padding:10px; display:flex; flex-direction:column; gap:6px' },
      h('div', { class: 't-label-lg', title: 'Keys that act as this player. Link another key from your vault with only the permissions it needs — a field key for automation can play and hash but never move your alpha.' }, h('span', { html: icon('key', 16) }), ' Linked keys'),
      h('div', { class: 't-tiny c-hint x-only' }, 'Keys that act as this player. Link another key from your vault with only the permissions it needs — a field key for automation can play and hash but never move your alpha.'),
      ...addrs.map((a) => h('div', { class: 'rep' }, h('div', { class: 'col grow', style: 'gap:2px; min-width:0' },
        h('span', { class: 'mono t-tiny' }, a.address), h('div', { class: 'row wrap t-tiny c-hint' }, ...(Number(a.permissions) === PERM_ALL ? [h('span', { class: 'chip warn' }, 'everything')] : PERMS.filter(([b]) => Number(a.permissions) & b).map(([, l]) => h('span', { class: 'chip' }, l))))),
        a.address !== wallet.active?.address ? h('button', { class: 'btn mini danger', onclick: async () => { if (await confirmBox('Unlink address', `Stop ${a.address} acting as ${pid}?`, 'Unlink')) this.q('MsgAddressRevoke', { address: a.address }, `Unlink ${a.address.slice(0, 14)}…`); } }, 'Unlink') : h('span', { class: 'chip player' }, 'this key'))),
      linkable.length ? h('div', { class: 'row wrap' }, pick, preset, h('button', { class: 'btn mini solid', onclick: async () => {
        if (wallet.state !== 'unlocked') { openVault(); return; }
        const idx = Number(pick.value);
        const acct = wallet.account(idx);
        if (!acct) return;
        if (!(await confirmBox('Link address', `Let ${acct.label} (${acct.address}) act as ${pid} with: ${preset.selectedOptions[0]?.textContent}?`, 'Link', 'player'))) return;
        // The new key proves itself: it signs PLAYER<id>ADDRESS<its address>, the chain checks it.
        const proof = wallet.signMessage(idx, `PLAYER${pid}ADDRESS${acct.address}`);
        this.q('MsgAddressRegister', { playerId: pid, address: acct.address, proofPubKey: proof.pubkey, proofSignature: proof.signature, permissions: preset.value }, `Link ${acct.label} to ${pid}`);
      } }, 'Link')) : h('div', { class: 'pane-empty dct-empty', title: 'To link a key, add an account in the vault first (Ops → Replicants creates them; an unregistered one can be linked instead of born).' }, 'No spare keys'));
  }

  /* ── Permissions ─────────────────────────────────────────────────── */

  private async paintPerms(token: number) {
    const me = this.me();
    if (!me) {
      this.body.replaceChildren(h('div', { class: 'dct-blank guild-empty', title: 'Permissions decide who else may play, solve puzzles or send alpha for your commander: a teammate or a robot helper. Enlist first, then set them here.' },
        h('span', { class: 'dct-blank-ico', html: icon('lock', 26) }), h('span', { class: 'dct-blank-words' }, 'Who acts for you'),
        wallet.state === 'empty' ? h('button', { class: 'btn solid', onclick: () => openVault() }, 'Enlist') : null));
      return;
    }
    this.body.replaceChildren(h('div', { class: 't-label c-hint cd-loading', title: 'Reading permissions…' }, 'Reading…'));
    let recs: PermRecord[] = [];
    try { recs = (await getJson<{ permissionRecords: PermRecord[] }>(`/structs/permission/object/${me.id}?pagination.limit=500`)).permissionRecords || []; } catch { /* none */ }
    // A newer paint (another tab, another guild) owns the body now.
    if (token !== this.paintToken || this.view !== 'perms') return;
    let addrs: { address: string; permissions: string }[] = [];
    try { addrs = (await getJson<{ address: { address: string; permissions: string }[] }>(`/structs/address_by_player/${me.id}?pagination.limit=10000`)).address || []; } catch { /* none */ }
    if (token !== this.paintToken || this.view !== 'perms') return;
    const grantee = h('input', { class: 'input mini-select', placeholder: 'player id to grant' }) as HTMLInputElement;
    const checks = PERMS.map(([bit, label, hint]) => {
      const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
      return { bit, el: h('label', { class: 'perm', title: hint }, cb, h('span', { class: 't-tiny' }, label)), cb };
    });
    const mask = () => checks.reduce((m, c) => m + (c.cb.checked ? c.bit : 0), 0);
    this.body.replaceChildren(
      h('div', { class: 't-display c-player', title: `Who else may act for ${me.name || me.id}: a teammate or a robot helper. “Play” lets them give your machines orders, “Hash” lets their computers solve your puzzles, and “Transfer” lets them move your alpha.` }, 'Permissions'),
      h('div', { class: 't-tiny c-hint x-only', style: 'max-width:760px' }, `Who may act for ${me.name || me.id}. Grants are bitmasks per (object, player): Play lets them fight your structs, the Hash bits let their browsers grind your proofs, Transfer moves your alpha. Replicants you make grant your commander everything.`),
      // Safety stays plain and visible.
      h('div', { class: 'dct-alert vault-alert s-only' }, h('span', { class: 'dct-alert-ico', html: icon('lock', 16) }), 'Transfer moves your alpha: grant it only to people you trust'),
      h('div', { class: 'col' }, ...(recs.length ? recs.map((r) => {
        const [, who] = r.permissionId.split('@');
        const v = Number(r.value);
        return h('div', { class: 'rep' }, h('div', { class: 'col grow', style: 'gap:3px' },
          h('div', { class: 'row' }, h('a', { class: 't-label-lg lnk', href: '/player/' + who }, store.playerName(who)), h('span', { class: 'chip' }, who), h('span', { class: 'chip ' + (v === PERM_ALL ? 'warn' : '') }, v === PERM_ALL ? 'everything' : `mask ${v}`)),
          h('div', { class: 'row wrap t-tiny c-hint' }, ...PERMS.filter(([b]) => v & b).map(([, l]) => h('span', { class: 'chip' }, l)))),
          who === me.id ? h('span', { class: 'chip player' }, 'you') : h('button', { class: 'btn mini danger', onclick: async () => { if (await confirmBox('Revoke', `Revoke every permission ${store.playerName(who)} holds on ${me.id}?`, 'Revoke')) this.q('MsgPermissionRevokeOnObject', { objectId: me.id, playerId: who, permissions: v }, `Revoke ${store.playerName(who)}`); } }, 'Revoke'));
      }) : [h('div', { class: 'pane-empty dct-empty', title: 'Nobody holds permissions on your player.' }, 'Nobody yet')])),
      this.addressPanel(me.id, addrs),
      h('div', { class: 'panel', style: 'padding:10px; display:flex; flex-direction:column; gap:8px' },
        h('div', { class: 't-label-lg', title: 'Give a player permissions on your commander' }, h('span', { html: icon('key', 16) }), ' Grant'),
        h('div', { class: 'perm-grid' }, ...checks.map((c) => c.el)),
        h('div', { class: 'row wrap' }, grantee,
          h('button', { class: 'btn mini ghost', onclick: () => { for (const c of checks) c.cb.checked = c.bit >= 1 << 20 && c.bit <= 1 << 23; } }, 'Hash bits'),
          h('button', { class: 'btn mini ghost', onclick: () => { for (const c of checks) c.cb.checked = true; } }, 'Everything'),
          h('button', { class: 'btn mini solid', onclick: async () => {
            const who = grantee.value.trim();
            if (!/^1-\d+$/.test(who)) { toast('Grant to a player id (1-…)', 'warn'); return; }
            const m = mask();
            if (!m) { toast('Pick at least one permission', 'warn'); return; }
            if (await confirmBox('Grant permissions', `Let ${store.playerName(who)} (${who}) ${PERMS.filter(([b]) => m & b).map(([, l]) => l).join(', ')} on ${me.name || me.id}?`, 'Grant', 'player'))
              this.q('MsgPermissionGrantOnObject', { objectId: me.id, playerId: who, permissions: m }, `Grant ${store.playerName(who)} mask ${m}`);
          } }, 'Grant'))));
  }
}
