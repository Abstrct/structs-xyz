/* Generates src/wallet/schema.gen.ts — every structs.structs Msg the chain accepts, with its
 * fields (name, number, wire type) and the doc comments from the proto, so the client can
 * encode any transaction and build a form for it.
 *
 * usage: node scripts/gen-msgs.mjs [git-ref] [path-to-structs-repo]
 *   git-ref defaults to v0.21.0 (what public.testnet runs: /cosmos/base/tendermint/v1beta1/node_info).
 * Reads the proto files out of git at that ref, so the schema matches the deployed chain. */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ref = process.argv[2] || 'v0.21.0';
const repo = process.argv[3] || join(dirname(fileURLToPath(import.meta.url)), '../../structs');
const show = (p) => execFileSync('git', ['-C', repo, 'show', `${ref}:proto/structs/structs/${p}`], { encoding: 'utf8' });

const SCALARS = new Set(['string', 'uint64', 'int64', 'uint32', 'int32', 'bool', 'bytes']);

function parse(src) {
  const messages = {};
  const enums = {};
  const lines = src.split('\n');
  let pending = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('//')) { pending.push(line.replace(/^\/\/\s?/, '')); continue; }
    let m;
    if ((m = /^enum\s+(\w+)\s*\{/.exec(line))) {
      const vals = [];
      for (i++; i < lines.length && !lines[i].includes('}'); i++) {
        const v = /^\s*(\w+)\s*=\s*(\d+)/.exec(lines[i]);
        if (v) vals.push([v[1], Number(v[2])]);
      }
      enums[m[1]] = vals;
      pending = [];
      continue;
    }
    if ((m = /^message\s+(\w+)\s*\{(.*)$/.exec(line))) {
      const name = m[1];
      const doc = pending.join(' ').trim();
      pending = [];
      // Gather the body up to the matching brace, dropping [...] option blocks and nested option lines.
      let depth = 1, body = m[2] + '\n';
      if (m[2].includes('}')) depth = 0;
      while (depth > 0 && ++i < lines.length) {
        for (const ch of lines[i]) { if (ch === '{') depth++; if (ch === '}') depth--; }
        body += lines[i] + '\n';
      }
      body = body.replace(/\[[^\]]*\]/gs, '');
      const fields = [];
      let fdoc = [];
      for (const raw of body.split('\n')) {
        const l = raw.trim();
        if (l.startsWith('//')) { fdoc.push(l.replace(/^\/\/\s?/, '')); continue; }
        const f = /^(repeated\s+)?([\w.]+)\s+(\w+)\s*=\s*(\d+)\s*;\s*(?:\/\/\s?(.*))?$/.exec(l);
        if (f && f[2] !== 'option') {
          const note = [...fdoc, f[5] || ''].join(' ').trim();
          fields.push({ name: f[3], no: Number(f[4]), type: f[2], repeated: !!f[1], ...(note ? { doc: note } : {}) });
        }
        if (l && !l.startsWith('//')) fdoc = [];
      }
      messages[name] = { doc, fields, raw: body };
      continue;
    }
    if (line) pending = [];
  }
  return { messages, enums };
}

const tx = parse(show('tx.proto'));
const keys = parse(show('keys.proto'));
// Nested message types a Msg may carry (by short name) — pulled from the other structs protos.
const others = {};
for (const f of ['fleet.proto', 'guild.proto', 'planet.proto', 'struct.proto', 'params.proto']) {
  try { Object.assign(others, parse(show(f)).messages); } catch { /* not at this ref */ }
}

const svc = show('tx.proto').match(/service Msg \{([\s\S]*?)\n\}/)[1];
const rpcs = [...svc.matchAll(/^\s*rpc\s+(\w+)\s*\(\s*(\w+)\s*\)/gm)].map((r) => ({ rpc: r[1], msg: r[2] }));

const DEC_FIELDS = new Set();
for (const [name, m] of Object.entries(tx.messages)) {
  // gogoproto customtype LegacyDec on a string: the wire form is the 18-decimal integer.
  const re = /string\s+(\w+)\s*=\s*\d+\s*\[[^\]]*LegacyDec/gs;
  const src = show('tx.proto');
  const block = src.slice(src.indexOf(`message ${name} {`));
  const end = block.indexOf('\n}');
  for (const d of block.slice(0, end).matchAll(re)) DEC_FIELDS.add(`${name}.${d[1]}`);
  void m;
}

const unknown = new Set();
const nested = {};
function kindOf(type, owner, field) {
  if (DEC_FIELDS.has(`${owner}.${field}`)) return { kind: 'dec' };
  if (SCALARS.has(type)) return { kind: type };
  if (type === 'cosmos.base.v1beta1.Coin') return { kind: 'coin' };
  const short = type.replace(/^structs\.structs\./, '');
  if (keys.enums[short] || tx.enums[short]) return { kind: 'enum', enum: short };
  const sub = tx.messages[short] || others[short];
  if (sub) {
    if (!nested[short]) {
      nested[short] = null;
      nested[short] = sub.fields.map((f) => ({ name: f.name, no: f.no, repeated: f.repeated, ...kindOf(f.type, short, f.name) }));
    }
    return { kind: 'msg', msg: short };
  }
  unknown.add(type);
  return { kind: 'string' };
}

const out = {};
for (const { rpc, msg } of rpcs) {
  const m = tx.messages[msg];
  if (!m) { unknown.add(msg); continue; }
  out[msg] = {
    rpc,
    doc: m.doc,
    fields: m.fields.map((f) => ({ name: f.name, no: f.no, repeated: f.repeated, ...kindOf(f.type, msg, f.name), ...(f.doc ? { doc: f.doc } : {}) })),
  };
}
if (unknown.size) console.warn('unknown types (encoded as string):', [...unknown].join(', '));

const enumsUsed = {};
const allEnums = { ...keys.enums, ...tx.enums };
const walk = (fields) => { for (const f of fields) { if (f.kind === 'enum') enumsUsed[f.enum] = allEnums[f.enum]; } };
for (const m of Object.values(out)) walk(m.fields);
for (const f of Object.values(nested)) walk(f);
// The game-wide enums are useful everywhere (ambits, object types, statuses).
for (const e of ['objectType', 'ambit', 'raidStatus', 'fleetStatus', 'planetStatus', 'allocationType', 'guildJoinBypassLevel', 'guildJoinType', 'registrationStatus', 'techActiveWeaponry', 'techPassiveWeaponry', 'techUnitDefenses']) if (allEnums[e]) enumsUsed[e] = allEnums[e];

const header = `/* GENERATED by scripts/gen-msgs.mjs from structs ${ref} proto/structs/structs/tx.proto — do not edit.
 * Every Msg the chain's structs module accepts, its fields and their wire kinds. */
/* eslint-disable */
`;
const body = `${header}
export type FieldKind = 'string' | 'uint64' | 'int64' | 'uint32' | 'int32' | 'bool' | 'bytes' | 'enum' | 'coin' | 'dec' | 'msg';
export interface FieldSpec { name: string; no: number; repeated: boolean; kind: FieldKind; enum?: string; msg?: string; doc?: string }
export interface MsgSpec { rpc: string; doc: string; fields: FieldSpec[] }

export const PROTO_REF = ${JSON.stringify(ref)};
export const MSGS: Record<string, MsgSpec> = ${JSON.stringify(out, null, 1)};
export const NESTED: Record<string, FieldSpec[]> = ${JSON.stringify(nested, null, 1)};
export const ENUMS: Record<string, [string, number][]> = ${JSON.stringify(enumsUsed)};
`;
const dest = join(dirname(fileURLToPath(import.meta.url)), '../src/wallet/schema.gen.ts');
writeFileSync(dest, body);
console.log(`wrote ${Object.keys(out).length} msgs, ${Object.keys(nested).length} nested types, ${Object.keys(enumsUsed).length} enums → ${dest}`);
