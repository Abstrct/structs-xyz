/* The struct catalogue: chain mechanics (synced from the testnet LCD) plus the
 * production copy (weapon names, drive and passive labels) and the art map. */
import raw from './structTypes.json';
import { asset } from '../core/base';

export type Ambit = 'space' | 'air' | 'land' | 'water';
export const AMBITS: Ambit[] = ['space', 'air', 'land', 'water'];
/** types/keys.go Ambit_flag — the reach bitmask. */
export const AMBIT_FLAG: Record<Ambit | 'local', number> = { water: 2, land: 4, air: 8, space: 16, local: 32 };
export const AMBIT_COLOR: Record<Ambit, number> = { space: 0x94a4e4, air: 0x80b2ff, land: 0xb3a38c, water: 0x408bff };
/** The Codex calls ambits Battlegrounds. */
export const AMBIT_NAME: Record<Ambit, string> = { space: 'Space', air: 'Air', land: 'Land', water: 'Water' };

export interface StructType {
  id: number;
  type: string;
  class: string;
  classAbbreviation: string;
  defaultCosmeticModelNumber: string;
  defaultCosmeticName: string;
  category: 'fleet' | 'planet';
  buildLimit: number;
  buildDifficulty: number;
  buildDraw: number;
  maxHealth: number;
  passiveDraw: number;
  possibleAmbit: number;
  movable: boolean;
  slotBound: boolean;
  primaryWeapon: string;
  primaryWeaponControl: string;
  primaryWeaponCharge: number;
  primaryWeaponAmbits: number;
  primaryWeaponTargets: number;
  primaryWeaponShots: number;
  primaryWeaponDamage: number;
  primaryWeaponBlockable: boolean;
  primaryWeaponCounterable: boolean;
  primaryWeaponRecoilDamage: number;
  primaryWeaponShotSuccessRateNumerator: number;
  primaryWeaponShotSuccessRateDenominator: number;
  primaryWeaponGuaranteedShots: number;
  primaryWeaponArmourPiercing: boolean;
  secondaryWeapon: string;
  secondaryWeaponControl: string;
  secondaryWeaponCharge: number;
  secondaryWeaponAmbits: number;
  secondaryWeaponTargets: number;
  secondaryWeaponShots: number;
  secondaryWeaponDamage: number;
  secondaryWeaponBlockable: boolean;
  secondaryWeaponCounterable: boolean;
  secondaryWeaponRecoilDamage: number;
  secondaryWeaponShotSuccessRateNumerator: number;
  secondaryWeaponShotSuccessRateDenominator: number;
  secondaryWeaponGuaranteedShots: number;
  secondaryWeaponArmourPiercing: boolean;
  passiveWeaponry: string;
  unitDefenses: string;
  oreReserveDefenses: string;
  planetaryDefenses: string;
  planetaryMining: string;
  planetaryRefinery: string;
  powerGeneration: string;
  activateCharge: number;
  buildCharge: number;
  defendChangeCharge: number;
  moveCharge: number;
  stealthActivateCharge: number;
  attackReduction: number;
  attackCounterable: boolean;
  stealthSystems: boolean;
  counterAttack: number;
  counterAttackSameAmbit: number;
  postDestructionDamage: number;
  generatingRate: number;
  planetaryShieldContribution: number;
  oreMiningDifficulty: number;
  oreRefiningDifficulty: number;
  unguidedDefensiveSuccessRateNumerator: number;
  unguidedDefensiveSuccessRateDenominator: number;
  guidedDefensiveSuccessRateNumerator: number;
  guidedDefensiveSuccessRateDenominator: number;
  triggerRaidDefeatByDestruction: boolean;
  canDefend: boolean;
  primary_weapon_label?: string;
  primary_weapon_description?: string;
  secondary_weapon_label?: string;
  secondary_weapon_description?: string;
  drive_label?: string;
  drive_description?: string;
  passive_weaponry_label?: string;
  passive_weaponry_description?: string;
  unit_defenses_label?: string;
  unit_defenses_description?: string;
}

export const CATALOGUE_HEIGHT: number = raw.height;
export const STRUCT_TYPES: StructType[] = raw.types as unknown as StructType[];
export const TYPES_BY_ID: Record<number, StructType> = Object.fromEntries(STRUCT_TYPES.map((t) => [t.id, t]));
export const COMMAND_SHIP_ID = 1;
export const typeOf = (id: number | string) => TYPES_BY_ID[Number(id)];

export type WeaponSystem = 'primaryWeapon' | 'secondaryWeapon';
export const WEAPON_SYSTEMS: WeaponSystem[] = ['primaryWeapon', 'secondaryWeapon'];

export function weaponField<K extends string>(t: StructType, ws: WeaponSystem, field: K): any {
  return (t as unknown as Record<string, unknown>)[(ws === 'secondaryWeapon' ? 'secondaryWeapon' : 'primaryWeapon') + field];
}
export function hasWeapon(t: StructType, ws: WeaponSystem) { return weaponField(t, ws, '') !== 'noActiveWeaponry'; }
export function ambitsOf(mask: number): Ambit[] { return AMBITS.filter((a) => (mask & AMBIT_FLAG[a]) !== 0); }
export function canTargetAmbit(t: StructType, ws: WeaponSystem, from: Ambit, to: Ambit) {
  let all = weaponField(t, ws, 'Ambits') || 0;
  if (all & AMBIT_FLAG.local) all |= AMBIT_FLAG[from];
  return (all & AMBIT_FLAG[to]) !== 0;
}
export function reachLabel(t: StructType, ws: WeaponSystem): string {
  const mask = weaponField(t, ws, 'Ambits') || 0;
  if (mask & AMBIT_FLAG.local) return 'Its own layer';
  return ambitsOf(mask).map((a) => AMBIT_NAME[a]).join(' · ');
}
export function weaponLabel(t: StructType, ws: WeaponSystem): string {
  const label = ws === 'primaryWeapon' ? t.primary_weapon_label : t.secondary_weapon_label;
  if (label) return label;
  const ctl = weaponField(t, ws, 'Control');
  return ctl === 'guided' ? 'Smart weapon' : ctl === 'unguided' ? 'Ballistic weapon' : 'Weapon';
}
/** Codex wording: guided = smart, unguided = ballistic. */
export const controlName = (c: string) => (c === 'guided' ? 'Smart' : c === 'unguided' ? 'Ballistic' : '—');

export const DEFENSE_NAME: Record<string, string> = {
  noUnitDefenses: '',
  signalJamming: 'Signal Jamming',
  defensiveManeuver: 'Defensive Maneuver',
  stealthMode: 'Stealth Mode',
  armour: 'Armour',
  indirectCombatModule: 'Indirect Combat',
};
export const DEFENSE_HINT: Record<string, string> = {
  signalJamming: 'Smart (guided) weapons miss it 2 times in 3.',
  defensiveManeuver: 'Ballistic (unguided) weapons miss it 2 times in 3.',
  stealthMode: 'Hidden: only units in its own layer can target it. Attacking reveals it.',
  armour: 'Every volley against it does 1 less damage (never below 1), unless armour piercing.',
  indirectCombatModule: 'Its attacks cannot be countered.',
};
export const PASSIVE_NAME: Record<string, string> = {
  noPassiveWeaponry: '',
  counterAttack: 'Counter-Attack',
  strongCounterAttack: 'Strong Counter-Attack',
  advancedCounterAttack: 'Advanced Counter-Attack',
  lastResort: 'Last Resort',
};

/* ── Art ───────────────────────────────────────────────────────────────── */

export interface ArtSpec { dir: string; bottom: string[]; top: string[]; hidden?: boolean }
/** battle-art.js, keyed by type id. 21 and 22 have no official art. */
export const ART: Record<number, ArtSpec | null> = {
  1: { dir: 'cmd-ship', bottom: [], top: ['top-weapon'] },
  2: { dir: 'battleship', bottom: [], top: [] },
  3: { dir: 'starfighter', bottom: ['bottom-weapon-smart'], top: ['top-weapon-ballistic'] },
  4: { dir: 'frigate', bottom: ['bottom-weapon'], top: [] },
  5: { dir: 'pursuit-fighter', bottom: ['bottom-weapon'], top: [] },
  6: { dir: 'stealth-bomber', bottom: ['bottom-weapon'], top: [] },
  7: { dir: 'interceptor', bottom: ['bottom-weapon'], top: [] },
  8: { dir: 'mobile-artillery', bottom: [], top: ['top-weapon'] },
  9: { dir: 'tank', bottom: [], top: ['top-weapon'] },
  10: { dir: 'sam-launcher', bottom: [], top: ['top-weapon'] },
  11: { dir: 'cruiser', bottom: ['bottom-ripples'], top: ['top-weapon-ballistic', 'top-weapon-smart'] },
  12: { dir: 'destroyer', bottom: ['bottom-ripples'], top: ['top-weapon'] },
  13: { dir: 'submersible', bottom: ['bottom-ripples'], top: ['top-weapon'], hidden: true },
  14: { dir: 'extractor', bottom: [], top: ['top-drill'] },
  15: { dir: 'refinery', bottom: [], top: ['top-bays'] },
  16: { dir: 'orb-shield', bottom: [], top: ['top-weapon'] },
  17: { dir: 'jamming-sat', bottom: [], top: ['top-weapon'] },
  18: { dir: 'ore-bunker', bottom: [], top: ['top-weapon'] },
  19: { dir: 'pdc', bottom: [], top: ['top-weapon'] },
  20: { dir: 'generator', bottom: [], top: ['top-tube'] },
  21: null,
  22: null,
};

export function artLayers(typeId: number, variant: 'base' | 'dmg' = 'base'): string[] {
  const a = ART[typeId];
  if (!a) return [];
  const p = (layer: string) => asset(`/img/structs/${a.dir}/${a.dir}-${layer}.webp`);
  return [...a.bottom.map(p), p('struct-' + variant), ...a.top.map(p)];
}

/** One-line role summary for the codex and tooltips. */
export function roleOf(t: StructType): string {
  if (t.id === COMMAND_SHIP_ID) return 'Flagship. Lose it away from home and the fleet is defeated.';
  if (t.planetaryMining !== 'noPlanetaryMining') return 'Mines ore from the planet.';
  if (t.planetaryRefinery !== 'noPlanetaryRefinery') return 'Refines ore into Alpha Matter.';
  if (t.powerGeneration !== 'noPowerGeneration') return 'Burns Alpha Matter for power.';
  if (t.planetaryDefenses === 'defensiveCannon') return 'Fires on raiders that strike planetary structs.';
  if (t.planetaryDefenses === 'lowOrbitBallisticInterceptorNetwork') return 'Jams smart weapons aimed at the planet.';
  if (t.planetaryShieldContribution > 0) return `Hardens the planetary shield (+${t.planetaryShieldContribution}).`;
  const reach = ambitsOf((t.primaryWeaponAmbits | t.secondaryWeaponAmbits) & 30).map((a) => AMBIT_NAME[a]).join(', ');
  return reach ? `Strikes ${reach}.` : 'Fleet struct.';
}
