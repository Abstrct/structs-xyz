/* Flavour: loading tips and short lines in the game's voice — terse,
 * systemic, a little menacing. */

export const TIPS = [
  'Ore can be taken. Refined Alpha cannot. Refine before someone else decides for you.',
  'When a planet’s last ore is gone, so is the planet — and everything standing on it.',
  'Nobody declared the Resource Wars. Nobody is coming to end them.',
  'Organic hands cannot hold raw Alpha. That is why Structs exist.',
  'A Struct does not sleep. It draws power, and it computes.',
  'To a Struct, Alpha Matter isn’t money. It’s breath.',
  'A Reactor is safe. A World Engine gives ten times the power — and carries ten times the risk.',
  'Fleet away, shields down. Every raid begins with an empty orbit.',
  'Smart weapons fear jammers. Ballistics fear evasive pilots.',
  'Only the Command Ship can drift between layers. Lose it away from home and the fleet is broken.',
  'A guild token is worth exactly the Alpha in its vault.',
  'Alliances are handshakes, not contracts. Verify.',
  'Explore. Extract. Expand. Exterminate. Exchange.',
  'Every unrefined gram is an invitation.',
  'Stealth hides you from other layers, never from your own.',
  'Charge is a rate limit, not a resource. Every action resets the battery.',
  'Proof-of-work gets cheaper if you wait. Initiate early, compute later.',
  'Load above capacity means offline. Offline means you cannot act.',
  'Every attack is a transaction. The chain remembers every shot.',
  'A substation splits its capacity evenly. Every new connection thins everyone’s share.',
  // Help for the newest commanders, in among the lore.
  'New here? The Academy teaches the whole game, one short lesson at a time.',
  'Lost on a screen? Press ? and it explains itself.',
  'Your first battle starts easy. Training battles can’t lose you anything.',
  'Never share your recovery phrase. Nobody honest will ever ask for it.',
];

export const BATTLE_LINES = {
  // (The ENGAGE banner's one line: always the goal, short enough for a 640-wide screen.)
  start: ['Take down their Command Ship', 'Guard yours. Sink theirs.', 'First Command Ship down loses'],
  win: ['Enemy Command Ship destroyed. Their fleet is broken and sent home.', 'The field is yours.'],
  lose: ['Your Command Ship is gone. The fleet falls back.', 'Defeat. The Spearpoint did not survive.'],
  draw: ['Stalemate. Neither fleet can finish the other.'],
};

/** One line of field lore per struct type, in the game's voice. */
export const STRUCT_LORE: Record<number, string> = {
  1: 'Every fleet answers to one Spearpoint. It is the only hull that can drift between battlegrounds, and the only one whose loss sends the whole fleet home.',
  2: 'The Cataclysm settles arguments at range. Its mass accelerator punches through armour on the ground; its jammers make smart missiles forget what they were aimed at.',
  3: 'Gambits fly in pairs and die in pairs. The plasma missile is honest; the attack run is a gamble that sometimes pays three times.',
  4: 'Skylight frigates hold the high orbit and the upper air with the same launcher. Unremarkable, until the sky is the only lane left.',
  5: 'Squalls hunt in the clouds and nowhere else. Their jammers turn guided ordnance into confetti.',
  6: 'Rolling Thunder is felt before it is seen. In stealth only its own sky can find it — and the moment it drops its bombs, everyone can.',
  7: 'Skimmers dance. Ballistic rounds miss two times in three; what reaches orbit or the air above it, the RPTR finds.',
  8: 'The Archer never answers a counter-attack, because nobody can reach it to make one. Indirect fire, land and sea, from far behind the line.',
  9: 'Breakaway tanks shrug off a point of every volley and hit back on the ground at close quarters. Slow, cheap, stubborn.',
  10: 'Longshot launchers watch the sky from the dirt. Anything flying low or orbiting high is in reach.',
  11: 'Hydra cruisers rule the coastline: missiles for the land and the sea, flak for the air, and jammers for whatever comes back.',
  12: 'The Kraken is built to punish. Fire on it from its own water and its counter-battery hits twice as hard.',
  13: 'Leviathans run silent. Submerged and stealthed, only the water can see them — until a Voidreach missile leaves the surface for orbit.',
  14: 'The Lasersword cuts one ore at a time from the planet’s core. Every cut leaves less world behind.',
  15: 'Greybox refineries turn stealable ore into Alpha Matter that no raider can take. Patience, made physical.',
  16: 'Shieldwall emitters thicken the planetary shield. They stop nothing on their own; they make every raid’s proof cost more.',
  17: 'The Observer listens to the sky and scrambles smart weapons aimed at the planet below. One per world is all the spectrum allows.',
  18: 'Hardshell bunkers bury the stockpile deep and add half a hundred to the shield. Raiders hate digging.',
  19: 'The Lookout fires on any raider that touches a planetary struct. It does not ask twice.',
  20: 'Magenta field generators burn Alpha for twice the power a reactor gives. Armoured, because what burns can also break.',
  21: 'Homestead plants feed a continent: five kilowatts per gram, and a fat target for anyone who wants the lights out.',
  22: 'The Constellation is a world engine — ten kilowatts per gram, and the most dangerous thing a commander can choose to build.',
};
