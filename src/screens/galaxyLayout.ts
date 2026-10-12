/* Where a planet sits in the drawn galaxy. Structs has no coordinates on
 * chain, so the map encodes the one spatial fact it does have: discovery
 * order. Planet 2-1 is at the core; every exploration pushes the frontier
 * outward along four spiral arms. Positions depend only on the planet's
 * index, so they never move as the galaxy grows. */
import * as THREE from 'three';
import { hash32, mulberry } from '../core/util';

export const GALAXY_RADIUS = 130;
const REFERENCE_COUNT = 60000;
const ARMS = 4;

export function planetPosition(index: number, out = new THREE.Vector3()): THREE.Vector3 {
  const rnd = mulberry(hash32('planet:' + index));
  const g = () => (rnd() + rnd() + rnd() - 1.5) / 1.5;           // ~gaussian in [-1, 1]
  const t = Math.sqrt(index / REFERENCE_COUNT);
  const r = GALAXY_RADIUS * t * (0.9 + rnd() * 0.2) + 2;
  const arm = Math.floor(rnd() * ARMS);
  const twist = r * 0.042;
  const spread = 0.28 + 0.5 * (1 - t);
  const angle = (arm / ARMS) * Math.PI * 2 + twist + g() * spread;
  const thickness = 1.2 + 7 * Math.exp(-r / 18);
  out.set(Math.cos(angle) * r, g() * thickness, Math.sin(angle) * r);
  return out;
}
