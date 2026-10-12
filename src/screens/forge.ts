/* The Forge: every message the chain's structs module accepts — all of them — as a form
 * built from the deployed proto schema. Smart defaults from your empire, the proto's own
 * documentation, a dry run against the chain, and one button to queue it.
 *   #/forge            the catalogue
 *   #/forge/<MsgName>  one message, ready to fill */
import '../styles/forge.css';
import '../styles/dc-lab.css';
import type { Engine } from '../core/engine';
import { h, toast, copyText, confirmBox } from '../core/dom';
import { audio } from '../core/audio';
import { PanelScreen } from './panelScreen';
import { MSGS, ENUMS, NESTED, PROTO_REF, type FieldSpec, type MsgSpec } from '../wallet/schema.gen';
import { encodeMsg, typeUrlOf, validateMsg, type Msg } from '../wallet/encode';
import { wallet } from '../wallet/wallet';
import { txq } from '../wallet/queue';
import { empire } from '../game/empire';
import { chainId, simulate, signTx, account, DEFAULT_GAS, FEE_DENOM, stripCosmosTail } from '../wallet/tx';
import { openVault } from '../ui/vault';
import { kids } from '../ui/opsDock';
import { replaceRoute } from '../core/nav';
import { icon } from '../ui/icons';
import { keepFocus } from '../ui/keepFocus';

/** Groups, in the order a commander reaches for them: a picture and a word each (the full name on
 * hover). Inside a group a message drops the group's own word ("Struct Attack" is "Attack" under Structs). */
interface Group { label: string; full: string; re: RegExp; ico: string; strip: string }
const GROUPS: Group[] = [
  { label: 'Structs', full: 'Structs', re: /^MsgStruct/, ico: 'build', strip: 'Struct ' }, { label: 'Fleet', full: 'Fleet', re: /^MsgFleet/, ico: 'ship', strip: 'Fleet ' },
  { label: 'Planet', full: 'Planet', re: /^MsgPlanet/, ico: 'planet', strip: 'Planet ' }, { label: 'Player', full: 'Player', re: /^MsgPlayer/, ico: 'base', strip: 'Player ' },
  { label: 'Bank', full: 'Guild bank', re: /^MsgGuildBank/, ico: 'bank', strip: 'Guild Bank ' }, { label: 'Members', full: 'Guild membership', re: /^MsgGuildMembership/, ico: 'team', strip: 'Guild Membership ' },
  { label: 'Guild', full: 'Guild', re: /^MsgGuild/, ico: 'flag', strip: 'Guild ' },
  { label: 'Reactors', full: 'Energy: reactors', re: /^MsgReactor/, ico: 'power', strip: 'Reactor ' }, { label: 'Substations', full: 'Energy: substations', re: /^MsgSubstation/, ico: 'grid', strip: 'Substation ' },
  { label: 'Allocations', full: 'Energy: allocations', re: /^MsgAllocation/, ico: 'send', strip: 'Allocation ' },
  { label: 'Providers', full: 'Energy market: providers', re: /^MsgProvider/, ico: 'market', strip: 'Provider ' }, { label: 'Agreements', full: 'Energy market: agreements', re: /^MsgAgreement/, ico: 'rules', strip: 'Agreement ' },
  { label: 'Permissions', full: 'Permissions', re: /^MsgPermission/, ico: 'lock', strip: 'Permission ' }, { label: 'Addresses', full: 'Addresses', re: /^MsgAddress/, ico: 'key', strip: 'Address ' },
  { label: 'Governance', full: 'Governance', re: /^MsgUpdateParams/, ico: 'gear', strip: '' },
];
const EVERYDAY = 'Everyday';

const START_HERE = ['MsgStructAttack', 'MsgStructBuildInitiate', 'MsgFleetMove', 'MsgPlanetExplore', 'MsgStructDefenseSet', 'MsgPlayerSend'];

const human = (n: string) => n.replace(/^Msg/, '').replace(/([a-z])([A-Z])/g, '$1 $2');

/** Charge-spending messages (ante maps.go) and the type field that prices them. */
const CHARGED = new Set(['MsgStructActivate', 'MsgStructAttack', 'MsgStructBuildInitiate', 'MsgStructDefenseClear', 'MsgStructDefenseSet', 'MsgStructMove', 'MsgStructStealthActivate', 'MsgStructStealthDeactivate', 'MsgStructTrash']);

export class ForgeScreen extends PanelScreen {
  private list!: HTMLElement;
  private form!: HTMLElement;
  private filter = '';
  private current: string | null = null;

  constructor(engine: Engine, navigate: (hash: string) => void) { super(engine, navigate, 'forge', 8.8); }

  /** The open group in the list (one at a time, like a console menu), and the ? button's state. */
  private openGroup: string | null = null;
  private why = false;
  private frame!: HTMLElement;
  /** The open form's signer refresh (null on the empty Code Lab). */
  private formSync: (() => void) | null = null;

  protected mount(params: Record<string, string>) {
    // The screen lives on between visits, but its search box comes back empty: so does the search.
    this.filter = '';
    const search = h('input', { class: 'input', placeholder: `Search ${Object.keys(MSGS).length} messages…`, 'aria-label': 'Search messages', spellcheck: false }) as HTMLInputElement;
    search.addEventListener('input', () => { this.filter = search.value.trim().toLowerCase(); this.paintList(); });
    this.list = h('div', { class: 'fg-list scroll' });
    this.form = h('div', { class: 'fg-form scroll' });
    const whyBtn = h('button', { class: 'btn ghost icon dc-why-btn' + (this.why ? ' active' : ''), 'aria-label': 'Explain', 'aria-pressed': this.why ? 'true' : 'false', title: 'Explain: show what each message and box means',
      onclick: () => { this.why = !this.why; audio.play('select'); this.frame.classList.toggle('dc-why', this.why); whyBtn.classList.toggle('active', this.why); whyBtn.setAttribute('aria-pressed', this.why ? 'true' : 'false'); } },
    h('span', { html: icon('help', 18) }));
    this.frame = h('div', { class: 'fg' + (this.why ? ' dc-why' : '') },
      h('aside', { class: 'fg-side panel' },
        h('div', { class: 'panel-head' }, h('span', { class: 'fg-title' }, h('span', { html: icon('code', 20) }), h('span', { class: 't-label' }, 'Code Lab')), h('span', { class: 't-tiny c-hint x-only' }, `structsd ${PROTO_REF}`), whyBtn),
        h('div', { class: 'panel-body' }, search), this.list),
      h('main', { class: 'fg-main panel player' }, this.form));
    this.root.append(this.frame);
    // Own names only: /forge/constructor must not find Object.prototype's.
    this.current = params.msg && Object.hasOwn(MSGS, params.msg) ? params.msg : null;
    // The message on show opens its own group; with none, the everyday moves.
    this.openGroup = this.current ? (GROUPS.find((g) => g.re.test(this.current!))?.label ?? EVERYDAY) : EVERYDAY;
    this.paintList();
    this.paintForm();
    // A vault unlocking (or locking) only changes who signs: the boxes keep what was typed.
    this.cleanup.push(wallet.onChange(() => (this.formSync ? this.formSync() : this.paintForm())));
  }

  private paintList() {
    const seen = new Set<string>();
    const match = (n: string) => !this.filter || n.toLowerCase().includes(this.filter) || human(n).toLowerCase().includes(this.filter) || MSGS[n].doc.toLowerCase().includes(this.filter);
    // The moves every commander makes come first (shown again in their own group below).
    const start = this.filter ? [] : START_HERE.filter((n) => MSGS[n]);
    const groups: { g: Group; names: string[] }[] = [
      ...(start.length ? [{ g: { label: EVERYDAY, full: 'Start here: everyday moves', re: /^$/, ico: 'star', strip: '' }, names: start }] : []),
      ...GROUPS.map((g) => {
        const names = Object.keys(MSGS).filter((n) => g.re.test(n) && !seen.has(n) && match(n));
        for (const n of names) seen.add(n);
        return { g, names };
      })].filter(({ names }) => names.length);
    // The cursor (keyboard, pad) stays on the header or message it was on.
    keepFocus(this.list, () => this.list.replaceChildren(...groups.map(({ g, names }) => {
      // A search opens every group with a hit; otherwise one group at a time.
      const open = !!this.filter || this.openGroup === g.label;
      return h('div', { class: 'fg-group' + (open ? ' open' : '') },
        h('button', { class: 'fg-gh', 'aria-expanded': open ? 'true' : 'false', title: g.full,
          onclick: () => { audio.play('select'); this.openGroup = this.openGroup === g.label ? null : g.label; this.paintList(); } },
        h('span', { class: 'fg-gh-ico', html: icon(g.ico, 18) }), h('span', { class: 'fg-gh-word' }, g.label), h('span', { class: 'fg-gh-n' }, String(names.length))),
        ...(open ? names.map((n) => h('button', { class: 'fg-item' + (n === this.current ? ' on' : ''), title: human(n) + (CHARGED.has(n) ? ' · spends charge' : ''), onclick: () => { audio.play('select'); this.current = n; replaceRoute('/forge/' + n); this.paintList(); this.paintForm(); } },
          h('span', null, g.strip && human(n).startsWith(g.strip) ? human(n).slice(g.strip.length) : human(n)), CHARGED.has(n) ? h('span', { class: 'fg-charge', 'aria-label': 'spends charge', html: icon('charge', 12) }) : null)) : []));
    })));
  }

  private paintForm() {
    const name = this.current;
    this.formSync = null;
    if (!name) {
      this.form.replaceChildren(h('div', { class: 'fg-hero', title: 'Every move in the game is a message: a command with named details, just like calling a function in code.' },
        h('span', { class: 'fg-hero-ico', html: icon('code', 64) }),
        h('div', { class: 't-display c-player' }, 'Code Lab'),
        h('div', { class: 'dc-num c-hint', title: `${Object.keys(MSGS).length} messages` }, h('span', { html: icon('rules', 16) }), String(Object.keys(MSGS).length)),
        h('div', { class: 'fg-pick' }, 'Pick a message'),
        h('div', { class: 't-body c-hint dc-hint' }, `Every move in the game is a message: a command with named details, just like calling a function in code. Here are all ${Object.keys(MSGS).length} messages the game accepts. Pick one on the left (try the everyday moves at the top), fill in its boxes, and watch it turn into code.`),
        h('div', { class: 't-tiny c-hint dc-hint' }, 'Messages marked ⚡ use charge: they wait until you have enough.')));
      return;
    }
    const spec = MSGS[name];
    const values: Record<string, unknown> = {};
    const out = h('pre', { class: 'fg-json mono' });
    // The same message as a function call: the shape of code a curious player already knows.
    const code = h('code', { class: 'fg-code-line' });
    const status = h('div', { class: 't-tiny fg-status' });
    const fields = spec.fields.filter((f) => !(f.name === 'creator' || f.name === 'authority'));
    const refresh = () => {
      const msg = this.build(name, spec, values);
      // Drafting without a vault is fine; only the signer is missing.
      const errs = validateMsg(msg).filter((e) => wallet.active || !/needs a creator/.test(e));
      let bytes = 0;
      try { bytes = encodeMsg(msg).length; } catch { /* reported by validate */ }
      out.textContent = JSON.stringify({ '@type': msg.typeUrl, ...msg.value }, null, 2);
      code.textContent = callFor(name, fields.map((f) => f.name), values);
      status.className = 't-tiny fg-status ' + (errs.length ? 'c-enemy' : 'c-player');
      status.replaceChildren(...(errs.length ? [errs.join(' · ')] : [h('span', { html: icon('check', 14) }), 'Valid', h('span', { class: 'x-only' }, ` · ${bytes} bytes on the wire`)]));
    };
    const inputs = fields.map((f) => this.field(name, f, values, refresh));
    const queue = h('button', { class: 'btn solid big', title: 'Queue it: sign and send this message' }, h('span', { class: 'dc-face a' }, 'A'), 'Queue') as HTMLButtonElement;
    const simWord = h('span', null, 'Dry run');
    const sim = h('button', { class: 'btn secondary big', title: 'Dry run: ask the chain whether it would accept this, without sending it' }, h('span', { class: 'dc-face x' }, 'X'), simWord) as HTMLButtonElement;
    queue.addEventListener('click', async () => {
      if (wallet.state !== 'unlocked') { openVault(); return; }
      try {
        const msg = this.build(name, spec, values);
        // Hand-built messages get one look before they're signed: what, by whom, with which values.
        const summary = Object.entries(msg.value).filter(([k]) => k !== 'creator').map(([k, v]) => `${k} = ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ');
        const acct = wallet.active;
        if (!(await confirmBox(human(name), `Sign as ${acct?.label || 'your commander'} (${acct?.address || ''}): ${summary || 'no fields'}`, 'Queue it', /Send|Bank|Reactor|Provider|Agreement|Allocation|Trash|Delete|Kick|Revoke|Owner/.test(name) ? 'enemy' : 'player'))) return;
        const p = acct?.playerId ? empire.players.get(acct.playerId) : undefined;
        txq.enqueue(msg, { source: 'forge', lane: CHARGED.has(name) ? 'action' : 'immediate', chargeCost: CHARGED.has(name) ? chargeFor(name, values, p) : undefined, label: human(name) });
        audio.play('confirm');
        toast(`${human(name)} queued`, 'player');
      } catch (e) { audio.play('deny'); toast((e as Error).message, 'enemy'); }
    });
    sim.addEventListener('click', async () => {
      if (wallet.state !== 'unlocked') { openVault(); return; }
      sim.disabled = true; simWord.textContent = 'Running…';
      try {
        const msg = this.build(name, spec, values);
        const key = wallet.key(wallet.activeIndex);
        const a = await account(key.address);
        const gas = await simulate(signTx(key, [msg], { chainId: await chainId(), accountNumber: a.accountNumber, sequence: a.sequence }, { amount: [{ denom: FEE_DENOM, amount: '0' }], gas: DEFAULT_GAS }));
        status.className = 't-tiny fg-status c-player'; status.textContent = `The chain would accept this now · ${gas.toLocaleString()} gas`;
        audio.play('ping');
      } catch (e) {
        status.className = 't-tiny fg-status c-enemy'; status.textContent = 'The chain would refuse: ' + stripCosmosTail(((e as Error).message || '').replace(/^.*?message index: \d+: /, ''));
        audio.play('deny');
      } finally { sim.disabled = false; simWord.textContent = 'Dry run'; }
    });
    const noSigner = 'No commander yet: you can build a message and see it as code, but testing or sending it needs a commander.';
    // Who signs: redrawn on its own when the vault changes, so typed values stay put.
    const signer = h('span', { class: 'fg-slot' });
    const signerNote = h('div', { class: 'fg-slot' });
    const paintSigner = () => {
      const acct = wallet.active;
      signer.replaceChildren(acct ? h('span', { class: 'chip fg-chip', title: `Signed by ${acct.label} · ${acct.address}` }, h('span', { html: icon('key', 12) }), acct.label, h('span', { class: 'x-only' }, ` · ${acct.address}`))
        : h('span', { class: 'chip fg-chip', title: noSigner }, h('span', { html: icon('lock', 12) }), 'No commander'));
      signerNote.replaceChildren(...(acct ? [] : [h('div', { class: 'fg-signer t-tiny c-hint dc-hint' }, noSigner)]));
    };
    paintSigner();
    this.formSync = () => { paintSigner(); refresh(); };
    this.form.replaceChildren(...kids(
      h('div', { class: 'fg-head' },
        h('div', { class: 't-display c-player', title: spec.doc || human(name) }, human(name)),
        h('div', { class: 'row wrap' },
          CHARGED.has(name) ? h('span', { class: 'chip warn fg-chip', title: 'Spends charge: it waits until you have enough' }, h('span', { html: icon('charge', 12) }), 'Charge') : null,
          h('span', { class: 'chip x-only' }, typeUrlOf(name)), h('span', { class: 'chip neutral x-only' }, `rpc ${spec.rpc}`),
          signer)),
      spec.doc ? h('div', { class: 't-body c-hint fg-doc dc-hint' }, spec.doc) : null,
      signerNote,
      h('div', { class: 'fg-fields' }, ...inputs),
      h('div', { class: 'fg-code', title: 'A move is a command plus named details, just like calling a function. Fill in the boxes and watch it change.' },
        h('span', { class: 'fg-code-k' }, h('span', { html: icon('code', 14) }), h('span', { class: 't-label c-hint' }, 'As code')), code,
        h('span', { class: 't-tiny c-hint dc-hint' }, 'A move is a command plus named details, just like calling a function. Fill in the boxes and watch it change.')),
      h('div', { class: 'fg-actions row wrap' }, queue, sim,
        h('button', { class: 'btn ghost', title: 'Copy as a structsd command', onclick: () => copyText(cliFor(spec, values), 'structsd command copied') }, h('span', { html: icon('terminal', 14) }), 'structsd'),
        h('button', { class: 'btn ghost', title: 'Copy the JSON', onclick: () => copyText(out.textContent || '', 'JSON copied') }, h('span', { html: icon('copy', 14) }), 'JSON')),
      status, out));
    refresh();
  }

  private build(name: string, spec: MsgSpec, values: Record<string, unknown>): Msg {
    const v: Record<string, unknown> = {};
    for (const f of spec.fields) if (values[f.name] !== undefined && values[f.name] !== '') v[f.name] = values[f.name];
    const acct = wallet.active;
    if (acct && spec.fields.some((f) => f.name === 'creator')) v.creator = acct.address;
    return { typeUrl: typeUrlOf(name), value: v };
  }

  /** One input for one proto field, with smart defaults and pickers. */
  private field(msg: string, f: FieldSpec, values: Record<string, unknown>, changed: () => void): HTMLElement {
    const id = `fg-${f.name}`;
    const label = h('label', { class: 'fg-label', for: id, title: f.doc || undefined }, h('span', { class: 't-label' }, f.name), h('span', { class: 't-tiny c-hint' }, kindLabel(f)));
    // The field's own documentation: on hover, while you are in the box, or under the ? button.
    const doc = f.doc ? h('div', { class: 't-tiny c-hint fg-fdoc' }, f.doc) : null;
    const set = (v: unknown) => { values[f.name] = v; changed(); };
    let input: HTMLElement;
    if (f.kind === 'enum') {
      const sel = h('select', { class: 'input', id }, ...(ENUMS[f.enum!] || []).map(([n]) => h('option', { value: n }, n))) as HTMLSelectElement;
      sel.addEventListener('change', () => set(sel.value));
      values[f.name] = sel.value;
      input = sel;
    } else if (f.kind === 'bool') {
      const cb = h('input', { type: 'checkbox', id }) as HTMLInputElement;
      cb.addEventListener('change', () => set(cb.checked));
      input = h('label', { class: 'row t-tiny' }, cb, 'true');
    } else if (f.kind === 'coin' && !f.repeated) {
      const amt = h('input', { class: 'input', id, placeholder: 'amount (base units)', inputmode: 'numeric' }) as HTMLInputElement;
      const den = h('input', { class: 'input', placeholder: 'denom', value: 'ualpha' }) as HTMLInputElement;
      const upd = () => set(amt.value ? { denom: den.value.trim(), amount: amt.value.trim() } : undefined);
      amt.addEventListener('input', upd); den.addEventListener('input', upd);
      input = h('div', { class: 'row' }, amt, den);
    } else if (f.kind === 'msg') {
      const sub: Record<string, unknown> = {};
      input = h('div', { class: 'fg-nested' }, ...(NESTED[f.msg!] || []).map((nf) => this.field(msg, nf, sub, () => { values[f.name] = { ...sub }; changed(); })));
    } else {
      const inp = h('input', { class: 'input', id, spellcheck: false, autocomplete: 'off', placeholder: placeholderFor(f) }) as HTMLInputElement;
      const dflt = defaultFor(msg, f);
      if (dflt) { inp.value = dflt; values[f.name] = f.repeated ? dflt.split(/[\s,]+/).filter(Boolean) : dflt; }
      const opts = optionsFor(f);
      if (opts.length) {
        const dl = h('datalist', { id: id + '-dl' }, ...opts.map(([v, l]) => h('option', { value: v }, l)));
        inp.setAttribute('list', id + '-dl');
        input = h('div', null, inp, dl);
      } else input = inp;
      inp.addEventListener('input', () => {
        const v = inp.value.trim();
        if (f.repeated) set(v ? v.split(/[\s,]+/).filter(Boolean) : undefined);
        else set(v || undefined);
      });
    }
    return h('div', { class: 'fg-field' }, label, input, doc);
  }
}

function kindLabel(f: FieldSpec) {
  const k = f.kind === 'enum' ? f.enum : f.kind === 'msg' ? f.msg : f.kind === 'dec' ? 'decimal' : f.kind;
  return f.repeated ? `${k}[]` : String(k);
}

function placeholderFor(f: FieldSpec): string {
  if (f.kind === 'coin' && f.repeated) return '100ualpha, 5uguild.0-1';
  if (f.repeated) return 'comma or space separated';
  if (f.kind === 'dec') return '0.05';
  if (/address/i.test(f.name)) return 'structs1…';
  if (/playerId$/.test(f.name)) return '1-…';
  if (/planetId$/.test(f.name)) return '2-…';
  if (/structId$/i.test(f.name) || /StructId$/.test(f.name)) return '5-…';
  if (/fleetId$/.test(f.name)) return '9-…';
  if (/guildId$/.test(f.name)) return '0-…';
  if (/substationId$/i.test(f.name)) return '4-…';
  if (/reactorId$/.test(f.name)) return '3-…';
  if (/allocationId$/.test(f.name)) return '6-…';
  if (/providerId$/.test(f.name)) return '10-…';
  if (/agreementId$/.test(f.name)) return '11-…';
  if (f.kind.startsWith('uint') || f.kind.startsWith('int')) return '0';
  return '';
}

/** The commander's own ids, offered first. */
function defaultFor(msg: string, f: FieldSpec): string {
  const p = wallet.active?.playerId ? empire.players.get(wallet.active.playerId) : undefined;
  if (!p) return '';
  if (f.name === 'playerId' && /^Msg(Planet|Player|StructBuild|Substation)/.test(msg)) return p.playerId;
  if (f.name === 'fleetId') return p.fleetId;
  if (f.name === 'planetId') return p.planetId;
  if (f.name === 'guildId' && /^MsgGuild/.test(msg)) return p.guildId;
  if (f.name === 'from_address' || f.name === 'delegator_address') return p.address;
  return '';
}

function optionsFor(f: FieldSpec): [string, string][] {
  const out: [string, string][] = [];
  if (/[sS]tructId$/.test(f.name) || f.name === 'structId') {
    for (const [p, s] of empire.allStructs()) if (p.account >= 0) out.push([s.id, `${s.type?.type || 'struct'} · ${p.name} · ${s.ambit} ${s.slot + 1}`]);
  }
  if (/playerId$/.test(f.name)) for (const a of wallet.accounts) if (a.playerId) out.push([a.playerId, a.label]);
  if (/[aA]ddress$/.test(f.name)) for (const a of wallet.accounts) out.push([a.address, a.label]);
  if (f.name === 'weaponSystem') out.push(['primaryWeapon', 'primary weapon'], ['secondaryWeapon', 'secondary weapon']);
  return out.slice(0, 200);
}

function chargeFor(msg: string, values: Record<string, unknown>, p?: { structs: Map<string, { type?: { activateCharge: number; buildCharge: number; defendChangeCharge: number; moveCharge: number; stealthActivateCharge: number; primaryWeaponCharge: number; secondaryWeaponCharge: number } }> }): number | undefined {
  const sid = String(values.structId || values.operatingStructId || values.defenderStructId || '');
  const t = p?.structs.get(sid)?.type;
  if (msg === 'MsgStructBuildInitiate') return 8;
  if (!t) return undefined;
  switch (msg) {
    case 'MsgStructActivate': return t.activateCharge;
    case 'MsgStructAttack': return values.weaponSystem === 'secondaryWeapon' ? t.secondaryWeaponCharge : t.primaryWeaponCharge;
    case 'MsgStructDefenseSet': case 'MsgStructDefenseClear': return t.defendChangeCharge;
    case 'MsgStructMove': return t.moveCharge;
    case 'MsgStructTrash': return (t as { buildCharge: number }).buildCharge;
    case 'MsgStructStealthActivate': case 'MsgStructStealthDeactivate': return t.stealthActivateCharge;
    default: return 0;
  }
}

/** structsd tx structs <kebab-rpc> <positional args…> — for players who live in a terminal. */
function cliFor(spec: MsgSpec, values: Record<string, unknown>): string {
  const kebab = spec.rpc.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  const args = spec.fields.filter((f) => f.name !== 'creator').map((f) => {
    const v = values[f.name];
    if (v == null || v === '') return `<${f.name}>`;
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' ? `${(x as { amount: string }).amount}${(x as { denom: string }).denom}` : String(x))).join(',');
    if (typeof v === 'object') return `${(v as { amount: string }).amount}${(v as { denom: string }).denom}`;
    return String(v);
  });
  return `structsd tx structs ${kebab} ${args.join(' ')} --from <key> --gas auto --fees 0ualpha -y`;
}

/** A message written as a call: structAttack({ operatingStructId: "5-12", … }); blanks show as ?. */
export function callFor(name: string, fields: string[], values: Record<string, unknown>): string {
  const fn = name.replace(/^Msg/, '').replace(/^./, (c) => c.toLowerCase());
  const args = fields.map((f) => {
    const v = values[f];
    const shown = v === undefined || v === '' ? '?' : typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);
    return `${f}: ${shown}`;
  });
  return `${fn}(${args.length ? '{ ' + args.join(', ') + ' }' : ''})`;
}
