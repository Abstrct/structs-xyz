/* The learning layer, in words: how the screens group into hubs, what every screen is for, the
 * glossary, and the Academy's lessons. Plain language first — the game's audience includes
 * thirteen-year-olds meeting strategy, economics and programming for the first time — but every
 * line stays true to the chain's rules. Browser-free: tests import it under node. */

/* ── Hubs: the top bar groups every screen into six places ─────────────────── */

export type HubId = 'base' | 'battle' | 'explore' | 'trade' | 'team' | 'lab';

export interface HubItem {
  /** A route (opens the screen) or a client action (the command line). */
  path?: string;
  action?: 'palette';
  label: string;
  /** One line: what you do there, for someone who has never seen it. */
  desc: string;
  /** Needs a commander (keys) to do much; still opens without one. */
  needsKeys?: boolean;
}

export interface Hub {
  id: HubId;
  label: string;
  /** The hub's promise, in a few words. */
  tagline: string;
  /** Its colour: every hub has one, so a place is recognisable at a glance. */
  color: string;
  /** The Academy track that teaches what the hub does. */
  track?: TrackId;
  items: HubItem[];
}

export const HUBS: Hub[] = [
  {
    id: 'base', label: 'Base', tagline: 'Your planet, your robots, your next move', color: '#43CDB6',
    items: [
      { path: '/command', label: 'My Base', desc: 'Build, mine and give orders. The advisor says what to do next.', needsKeys: true },
      { path: '/ops/record', label: 'Rank & Missions', desc: 'Your rank, your XP and the mission ladder from first build to first raid.' },
      { path: '/ops/queue', label: 'Moves in Progress', desc: 'Every move you have sent, and whether it landed.', needsKeys: true },
    ],
  },
  {
    id: 'battle', label: 'Battle', tagline: 'Practise tactics, then watch real fights', color: '#EE7D69', track: 'strategy',
    items: [
      { path: '/sim', label: 'Training Battles', desc: 'Your fleet against the computer. No account needed.' },
      { path: '/sim/daily', label: 'Daily Challenge', desc: 'One new battle a day, the same for every player. Beat it, then share it.' },
      { path: '/combat', label: 'Battle Replays', desc: 'Every real attack in the galaxy, replayed shot by shot.' },
      { path: '/codex', label: 'Unit Guide', desc: 'All 22 units: what each one hits, and what hits it.' },
    ],
  },
  {
    id: 'explore', label: 'Explore', tagline: 'The whole galaxy, live', color: '#94A4E4',
    items: [
      { path: '/galaxy', label: 'Galaxy Map', desc: 'Every planet and commander, updating as the game happens.' },
      { path: '/grid', label: 'Power Grid', desc: 'Where the galaxy’s energy comes from, and who it flows to.' },
      { path: '/intel', label: 'News & Rankings', desc: 'Live events, raids, leaderboards and charts.' },
    ],
  },
  {
    id: 'trade', label: 'Trade', tagline: 'Energy, money and the market', color: '#EBAA49', track: 'economics',
    items: [
      { path: '/economy/power', label: 'Power', desc: 'How much energy you make versus how much you use.', needsKeys: true },
      { path: '/economy/fuel', label: 'Fuel', desc: 'Reactors, and the alpha you can put in them to make power.' },
      { path: '/economy/market', label: 'Energy Market', desc: 'Buy or sell energy. Compare prices to find a good deal.' },
      { path: '/economy/banks', label: 'Banks', desc: 'Guild tokens, the alpha behind them, and swapping between them.' },
      { path: '/economy/transfers', label: 'Send & Balances', desc: 'What you own, and sending alpha to another player.', needsKeys: true },
    ],
  },
  {
    id: 'team', label: 'Team', tagline: 'Your guild and your friends', color: '#B794F0',
    items: [
      { path: '/comms', label: 'Chat', desc: 'Talk with your guild. Every planet and fleet has its own channel too.' },
      { path: '/guild', label: 'Guild Hall', desc: 'Your team: members, ranks, invites and who may act for you.' },
      { path: '/intel/guilds', label: 'All Guilds', desc: 'Every guild in the galaxy, with its members and power.' },
    ],
  },
  {
    id: 'lab', label: 'Lab', tagline: 'Code, robots and how the machine works', color: '#7FD88A', track: 'technology',
    items: [
      { action: 'palette', label: 'Command Line', desc: 'Type commands like a programmer: “build extractor”, “sail 2-7”. Shortcut: press the / key.' },
      { path: '/forge', label: 'Code Lab', desc: 'Every one of the game’s 97 messages as a form. See exactly what a move sends.' },
      { path: '/ops/replicants', label: 'Robot Helpers', desc: 'Make replicants: extra players that mine and fight for you.', needsKeys: true },
      { path: '/ops/orders', label: 'Robot Rules', desc: 'Standing orders: program what your robots do on their own.', needsKeys: true },
      { path: '/ops/proofs', label: 'Proof Engine', desc: 'Watch your computer solve the hash puzzles that finish builds.' },
      { path: '/ops/health', label: 'System Health', desc: 'Every connection the game uses, measured live.' },
    ],
  },
];

/** The hub a route belongs to (null for the Academy, which sits beside the hubs). The player's own
 * home planet is My Base's view, so it belongs to Base; any other planet is Explore. */
export function hubFor(path: string, homePlanet?: string | null): HubId | null {
  const p = path.replace(/\/+$/, '') || '/';
  if (homePlanet && p === '/planet/' + homePlanet) return 'base';
  if (p.startsWith('/academy')) return null;
  if (p.startsWith('/command') || p === '/ops' || p.startsWith('/ops/record') || p.startsWith('/ops/queue')) return 'base';
  if (p.startsWith('/ops')) return 'lab';
  if (p.startsWith('/forge')) return 'lab';
  if (p.startsWith('/sim') || p.startsWith('/combat') || p.startsWith('/codex')) return 'battle';
  if (p.startsWith('/economy')) return 'trade';
  if (p.startsWith('/comms') || p.startsWith('/guild') || p.startsWith('/intel/guild')) return 'team';
  return 'explore';
}

/** The friendly name of the screen a route opens (for the guide card and the page). */
export function placeFor(path: string): { hub: HubId | null; label: string } {
  const hub = hubFor(path);
  const p = path.replace(/\/+$/, '') || '/';
  if (p.startsWith('/academy')) return { hub, label: 'Academy' };
  if (p.startsWith('/planet') || p.startsWith('/player')) return { hub, label: 'Planet Map' };
  let best: HubItem | null = null;
  for (const hb of HUBS) for (const it of hb.items) if (it.path && (p === it.path || p.startsWith(it.path + '/')) && (!best || it.path.length > best.path!.length)) best = it;
  if (!best && p.startsWith('/ops')) best = HUBS[0].items[1];
  if (!best && p.startsWith('/economy')) best = HUBS[3].items[0];
  return { hub, label: best?.label || 'Galaxy Map' };
}

/* ── Glossary ──────────────────────────────────────────────────────────────── */

export interface Term { key: string; word: string; short: string; lesson?: string }

/** The words the game uses, explained the way you would to a friend. */
export const GLOSSARY: Term[] = [
  { key: 'alpha', word: 'Alpha Matter', short: 'The galaxy’s money. You make it by refining ore. Robots run on it, and nobody can steal it from your wallet.', lesson: 'alpha' },
  { key: 'ore', word: 'Ore', short: 'Raw rock dug out of your planet by an Ore Extractor. Ore in your hold can be stolen by raiders until you refine it.', lesson: 'risk' },
  { key: 'refine', word: 'Refine', short: 'Turning ore into Alpha Matter in a refinery. Refined alpha is safe from raiders.', lesson: 'alpha' },
  { key: 'struct', word: 'Struct', short: 'Any machine you build: ships, cannons, extractors, generators. Each one has a job.', lesson: 'units' },
  { key: 'ambit', word: 'Ambit', short: 'One of the four layers of a battlefield: space, air, land and water. A weapon can only hit the layers it reaches.', lesson: 'ambits' },
  { key: 'charge', word: 'Charge', short: 'Your action energy. It counts the blocks since your last move. Big moves need more charge, and almost every move resets it to zero.', lesson: 'charge' },
  { key: 'block', word: 'Block', short: 'One tick of the game clock, about every 6 seconds. Each block carries everyone’s moves, in order.', lesson: 'blocks' },
  { key: 'power', word: 'Power', short: 'How fast energy flows, measured in watts (W) and kilowatts (kW). Capacity is what you can supply; load is what your machines use.', lesson: 'power' },
  { key: 'online', word: 'Online / offline', short: 'Your grid is online while load stays at or under capacity. Go over it and you are offline: you cannot act until you fix it.', lesson: 'power' },
  { key: 'shield', word: 'Shield', short: 'Your planet’s defence against raids. A stronger shield makes the raid puzzle harder to solve.', lesson: 'risk' },
  { key: 'fleet', word: 'Fleet', short: 'Your ships, led by a Command Ship. It can stay home to defend or sail to another planet.', lesson: 'flagship' },
  { key: 'command-ship', word: 'Command Ship', short: 'The leader of a fleet. Destroy it while its fleet is away from home and that fleet loses the battle.', lesson: 'flagship' },
  { key: 'guard', word: 'Guard', short: 'A unit told to protect another. If it is in the same layer, it blocks shots aimed at the unit it protects, and it fires back.', lesson: 'guards' },
  { key: 'stealth', word: 'Stealth', short: 'A hidden unit can’t be targeted from other battlefield layers, only from its own.', lesson: 'stealth' },
  { key: 'raid', word: 'Raid', short: 'Sailing your fleet to another planet, beating its defenders, then solving the raid puzzle to take its ore.', lesson: 'risk' },
  { key: 'hash', word: 'Hash / proof of work', short: 'A puzzle your computer solves by guessing millions of times a second. Solving it finishes builds, mining and raids.', lesson: 'hash' },
  { key: 'replicant', word: 'Replicant', short: 'An extra player made from your own key. It follows the rules you give it, like a robot helper.', lesson: 'ifthen' },
  { key: 'guild', word: 'Guild', short: 'A team of players. Guilds share power, chat together and can have their own bank.' },
  { key: 'reactor', word: 'Reactor', short: 'A big power plant. Players put alpha in as fuel, and it gives out energy.', lesson: 'grid' },
  { key: 'substation', word: 'Substation', short: 'Shares power out to the players connected to it. More connections means a thinner share each.', lesson: 'grid' },
  { key: 'market', word: 'Energy market', short: 'Where players sell spare energy for alpha. Prices are in alpha per kilowatt per day.', lesson: 'market' },
  { key: 'token', word: 'Guild token', short: 'A guild’s own coin. Each one is backed by alpha in the guild’s bank.', lesson: 'banks' },
  { key: 'message', word: 'Message', short: 'A move, written as a command with named fields, like a function call in code. Your browser signs it and sends it to the chain.', lesson: 'message' },
  { key: 'chain', word: 'Blockchain', short: 'The shared record of every move in the game. Everyone can read it, and nobody can secretly change it.', lesson: 'blocks' },
  { key: 'vault', word: 'Vault', short: 'Where your commander’s key lives, sealed inside this browser.', lesson: 'keys' },
  { key: 'phrase', word: 'Recovery phrase', short: '24 secret words that ARE your commander. Anyone who has them controls it. Never share them, not even with friends.', lesson: 'keys' },
  { key: 'testnet', word: 'Testnet', short: 'The practice version of the Structs network. Its tokens are for playing, not real money.' },
  { key: 'turn', word: 'Turn', short: 'In a training battle, one block of game time: 2 seconds, or 6 at real game speed. Charge goes up by one every turn.', lesson: 'charge' },
  { key: 'commandline', word: 'Command line', short: 'A box where you type commands instead of clicking, like “build extractor” or “sail 2-7”. Press / to open it.', lesson: 'commandline' },
  { key: 'expert', word: 'Expert mode', short: 'A switch in the More menu that shows the technical details: block numbers, raw events and where data comes from. Off by default.', lesson: 'hood' },
  { key: 'ids', word: 'IDs: 1-…, 2-…, 0-…', short: 'Everything has a number. Players start with 1-, planets with 2-, guilds with 0-, fleets with 9-.' },
];

export const termByKey = new Map(GLOSSARY.map((t) => [t.key, t]));

/* ── Screen guides: the first time you open a screen ───────────────────────── */

export interface Guide { title: string; what: string; tries: string[]; lesson?: string }

/** Keyed by router screen name. */
export const GUIDES: Record<string, Guide> = {
  galaxy: { title: 'Galaxy Map', what: 'Every planet anyone has ever found, live. Lit dots are players’ home worlds; red arcs are fleets out raiding.', tries: ['Every screen lives in the six glowing buttons at the top. New? Open Battle and pick Training Battles.', 'Drag to spin the galaxy, scroll to zoom, click any planet.', 'Click a red target ring to watch the latest battle there.'] },
  planet: { title: 'Planet Map', what: 'One world up close: its defences, its fleet and its owner’s stats. Real attacks play out here as they happen.', tries: ['Point at any ship or building to see its health and job.', 'Press the A button at the bottom (Fight a copy, or Practice defence / raid) to fight these real fleets in a training battle. Nothing can be lost.', 'Tap the planet bar at the top (on a big screen, the left panel) for its stats: point at any icon to see what it counts, or Pin its commander to the top bar.'], lesson: 'units' },
  combat: { title: 'Battle Replays', what: 'Every real attack in the galaxy, replayed shot by shot from the blockchain’s own records.', tries: ['Pick any fight from the list.', 'Press ▶ Fight (or E) to see a full raid from start to end.', 'Press Refight to see if you could have done better.'], lesson: 'replay' },
  grid: { title: 'Power Grid', what: 'Where the galaxy’s energy comes from: reactors at the top feed substations, and substations feed players.', tries: ['Hover a glowing beam to see who powers whom.', 'Click a substation to see how its power is shared.', 'Click a reactor to see its fuel.'], lesson: 'grid' },
  sim: { title: 'Training Battles', what: 'Your fleet against the computer, using the real game’s combat rules. Nothing here can be lost.', tries: ['Pick how big the enemy is, then press Start.', 'Click one of your ships, choose a weapon, then click a red-ringed enemy.', 'Destroy the enemy Command Ship to win.'], lesson: 'firstwin' },
  codex: { title: 'Unit Guide', what: 'Every unit in the game, with what it can hit and what can hit it. Know your units, win your battles.', tries: ['Click any unit in the list.', 'Drag the 3D model to turn it.', 'Press Matchups to see who beats whom.'], lesson: 'units' },
  command: { title: 'My Base', what: 'Your commander’s home: planet slots to build in, your fleet, and an advisor with your best next moves.', tries: ['No commander yet? Press Enlist: it’s free and takes seconds. Every move is signed right here in your browser.', 'Click an empty + slot to build, or a machine to give it orders. Point at any icon (⚡ charge, ◆ alpha, ore, shield, power) to see what it means.', 'The big card is your best next move: press its A button. +N shows the other moves.'] },
  economy: { title: 'Trade', what: 'The money side of the galaxy: energy, fuel, the market, guild banks and sending alpha.', tries: ['Power: is your supply bigger than your use?', 'Market: compare prices before you buy.', 'Banks: see how guild tokens are backed by alpha.'], lesson: 'power' },
  intel: { title: 'News & Rankings', what: 'What is happening right now: live events, who is raiding whom, leaderboards and charts.', tries: ['Activity shows events the moment they happen.', 'Leaderboards rank the galaxy’s top commanders.', 'Click a guild to see its members.'] },
  comms: { title: 'Chat', what: 'Talk with your guild. Every planet and fleet has its own channel too.', tries: ['Already chat in another Matrix app? Paste its token to join here.', 'Be kind, and never share your recovery phrase.', 'Type @ to mention someone.'], lesson: 'keys' },
  guild: { title: 'Guild Hall', what: 'Your team: who is in it, their ranks, and who is allowed to act for you.', tries: ['See every member and their rank.', 'Request to join another guild.', 'Permissions decide who can play for you.'] },
  forge: { title: 'Code Lab', what: 'Every move in the game is a message with named fields, like a function call in code. Here you can see and build any of them.', tries: ['Pick a message from the list.', 'Fill in a box and watch the “As code” line change.', 'Press “Dry run” to test it without sending.'], lesson: 'message' },
  ops: { title: 'Engine Room', what: 'The machinery behind your base: your moves, the puzzle solver, robot helpers, robot rules and your rank.', tries: ['Proof Engine: watch your computer solve puzzles.', 'Robot Helpers: make players that work for you.', 'Robot Rules: read your robots’ program, then change it.'], lesson: 'hash' },
  academy: { title: 'Academy', what: 'Learn strategy, economics and technology by playing. Every lesson earns XP toward your rank.', tries: ['Pick a track: Strategy, Economics or Technology.', 'Press “Try it” to jump to the right screen.', 'Answer quizzes to finish lessons.'] },
};

/* ── The Academy ───────────────────────────────────────────────────────────── */

export type TrackId = 'strategy' | 'economics' | 'technology';

/** How a lesson is finished: by doing something (seen a route, a record, an event) or by a quiz. */
export type LessonCheck =
  | { route: string }
  | { stat: 'wins' | 'flagships' | 'dailyWins' | 'gauntlet' | 'battles'; min: number }
  | { event: 'palette' | 'glossary' | 'help' | 'expert' };

export interface Quiz { q: string; choices: string[]; answer: number; why: string }

export interface Lesson {
  id: string;
  title: string;
  /** Two or three sentences: the idea, in plain words. */
  learn: string;
  xp: number;
  /** Where "Try it" goes (a route, or 'palette' for the command line). */
  go?: string;
  check?: LessonCheck;
  quiz?: Quiz;
}

export interface Track { id: TrackId; label: string; tagline: string; color: string; badge: string; lessons: Lesson[] }

export const TRACKS: Track[] = [
  {
    id: 'strategy', label: 'Strategy', tagline: 'Think like a commander', color: '#EE7D69', badge: 'Strategist',
    lessons: [
      { id: 'units', title: 'Meet your units', xp: 30, go: '/codex', check: { route: '/codex' },
        learn: 'Every struct has a job: some shoot down planes, some sink ships, some guard, some only mine. Open the Unit Guide and look at one.' },
      { id: 'ambits', title: 'Space, air, land and water', xp: 40, go: '/codex',
        learn: 'A battlefield has four layers: space, air, land and water. A weapon can only hit the layers it reaches.',
        quiz: { q: 'The enemy fleet is all air units. Which of your weapons will help?', choices: ['One that reaches air', 'One that only reaches water', 'Any weapon: they all hit everything'], answer: 0, why: 'Weapons only hit the layers they reach. Bring what can touch the air.' } },
      { id: 'charge', title: 'Charge: patience is power', xp: 40, go: '/sim',
        learn: 'Charge goes up by one every block (about 6 seconds). Big moves need more, and almost every move resets it to zero.',
        quiz: { q: 'Your charge is 3 and a build needs 8. What do you do?', choices: ['Wait about 5 more blocks (around 30 seconds)', 'Build anyway: charge can go below zero', 'Nothing. Charge never comes back'], answer: 0, why: 'Charge goes up by one every block. Five more blocks and you have 8.' } },
      { id: 'firstwin', title: 'Win a practice battle', xp: 60, go: '/sim', check: { stat: 'wins', min: 1 },
        learn: 'Training battles use the real combat rules, but nothing can be lost. Destroy the enemy Command Ship to win.' },
      { id: 'guards', title: 'Guards and blocking', xp: 40, go: '/sim',
        learn: 'Tell a unit to guard another in the same layer: shots at the protected unit hit the guard instead, and guards shoot back.',
        quiz: { q: 'Your Command Ship is being targeted. What can a guard do?', choices: ['Block shots aimed at it', 'Make it invisible forever', 'Refill its charge'], answer: 0, why: 'Guards block attacks on the unit they protect, and they take the damage themselves.' } },
      { id: 'stealth', title: 'Hide and seek', xp: 40, go: '/codex',
        learn: 'A hidden (stealth) unit can only be targeted by enemies in its own layer. Attacking reveals it.',
        quiz: { q: 'Your Submersible is hidden in the water layer. Who can still target it?', choices: ['Only enemies in the water layer', 'Nobody, ever', 'Only enemies in space'], answer: 0, why: 'Stealth hides you from other layers, never from your own.' } },
      { id: 'flagship', title: 'Take down a Command Ship', xp: 60, go: '/sim', check: { stat: 'flagships', min: 1 },
        learn: 'Every fleet is led by a Command Ship. Sink a raiding fleet’s Command Ship and that whole fleet is beaten, so go for the leader.' },
      { id: 'replay', title: 'Watch a real battle', xp: 30, go: '/combat', check: { route: '/combat' },
        learn: 'Every shot of every real battle is saved on the blockchain. Watching them is how commanders learn new tricks.' },
      { id: 'daily', title: 'Beat the Daily Challenge', xp: 80, go: '/sim/daily', check: { stat: 'dailyWins', min: 1 },
        learn: 'One new battle every day, the same for every player: same fleets, same dice. Win it, then compare with friends.' },
      { id: 'gauntlet', title: 'Run the Gauntlet', xp: 80, go: '/sim', check: { stat: 'gauntlet', min: 2 },
        learn: 'Five battles in a row: ships you lose stay lost and damage carries over. Clear two rounds to pass.' },
    ],
  },
  {
    id: 'economics', label: 'Economics', tagline: 'Make your empire rich', color: '#EBAA49', badge: 'Economist',
    lessons: [
      { id: 'alpha', title: 'Alpha Matter: the galaxy’s money', xp: 30,
        learn: 'Extractors dig ore out of your planet. Refineries turn ore into Alpha Matter, the money every robot wants.',
        quiz: { q: 'What do you get when you refine ore?', choices: ['Alpha Matter', 'More ore', 'Charge'], answer: 0, why: 'Refineries turn raw ore into Alpha Matter.' } },
      { id: 'risk', title: 'Protect what you own', xp: 40,
        learn: 'Raiders can steal ore from your hold, never refined alpha. Refining goes one ore at a time, so keep a refinery running.',
        quiz: { q: 'Raiders are coming and you have 40 ore in your hold. Best move?', choices: ['Keep a refinery running to turn it into alpha', 'Leave it where it is', 'Mine even more ore first'], answer: 0, why: 'Raiders can only steal ore. Refining is slow, so start early.' } },
      { id: 'power', title: 'Power: supply and demand', xp: 40, go: '/economy/power',
        learn: 'Machines use power (load). Keep load at or under your capacity. Go over and your grid is offline until you fix it.',
        quiz: { q: 'Your load is 9 kW and your capacity is 8 kW. What happens?', choices: ['You go offline until you fix it', 'Nothing at all', 'You get a free kilowatt'], answer: 0, why: 'Load above capacity means offline. Add capacity or switch something off.' } },
      { id: 'grid', title: 'Follow the power', xp: 30, go: '/grid', check: { route: '/grid' },
        learn: 'Power flows from reactors to substations to players. Each new player on a substation thins everyone’s share.' },
      { id: 'scarcity', title: 'Nothing lasts forever', xp: 40,
        learn: 'Each planet holds a limited amount of ore. When the last of it is dug up, the planet is finished, and so is everything on it: explore for a new one.',
        quiz: { q: 'The ore left in your planet reaches 0. What now?', choices: ['Explore to claim a new planet', 'Wait for the ore to grow back', 'Keep mining. It never runs out'], answer: 0, why: 'A spent planet has nothing left to mine. Explore for a fresh one.' } },
      { id: 'market', title: 'Shop the energy market', xp: 30, go: '/economy/market', check: { route: '/economy/market' },
        learn: 'Players sell spare energy for alpha, priced per kilowatt per day. A lower price is a better deal, if the seller can deliver.' },
      { id: 'unitprice', title: 'Price per unit', xp: 40, go: '/economy/market',
        learn: 'The total cost is kilowatts × days × price. Work it out before you buy: that’s how you spot a good deal.',
        quiz: { q: 'Energy costs 0.5 alpha per kW per day. You need 2 kW for 3 days. What does it cost?', choices: ['3 alpha', '1.5 alpha', '6 alpha'], answer: 0, why: 'Multiply all three. 2 kW × 3 days × 0.5 alpha = 3 alpha.' } },
      { id: 'banks', title: 'Banks and exchange rates', xp: 40, go: '/economy/banks',
        learn: 'A guild token is worth the alpha in its bank divided by the number of tokens. That’s the exchange rate.',
        quiz: { q: 'Each token is worth 2 alpha. You convert 10 alpha. About how many tokens do you get, before fees?', choices: ['5', '20', '10'], answer: 0, why: '10 alpha ÷ 2 alpha per token = 5 tokens.' } },
    ],
  },
  {
    id: 'technology', label: 'Technology', tagline: 'How the machine works', color: '#7FD88A', badge: 'Engineer',
    lessons: [
      { id: 'blocks', title: 'Blocks: the game’s heartbeat', xp: 30,
        learn: 'Structs runs on a blockchain, a shared record everyone can read. About every 6 seconds a new block of moves lands.',
        quiz: { q: 'About how often does a new block land?', choices: ['Every few seconds', 'Once a day', 'Once a year'], answer: 0, why: 'A block lands about every 6 seconds, so charge builds up quickly.' } },
      { id: 'hash', title: 'Proof of work: puzzle power', xp: 40, go: '/ops/proofs',
        learn: 'To finish a build, your computer guesses millions of numbers a second until one’s hash is small enough. Waiting makes it easier.',
        quiz: { q: 'Why does your computer “hash”?', choices: ['To solve a puzzle that proves work was done', 'To make the screen look cool', 'To send chat messages'], answer: 0, why: 'A solved hash puzzle is proof your computer did the work, so builds, mining and raids can finish.' } },
      { id: 'commandline', title: 'Type your first command', xp: 30, go: 'palette', check: { event: 'palette' },
        learn: 'Programmers type instead of clicking. Press / (or Ctrl+K) and type a verb plus details, like “build extractor”.' },
      { id: 'message', title: 'Look inside a real move', xp: 40, go: '/forge/MsgStructAttack', check: { route: '/forge/' },
        learn: 'Every move is a message with named fields, like a function call with arguments. The Code Lab shows each one as code.' },
      { id: 'ifthen', title: 'Robot rules: if this, then that', xp: 40, go: '/ops/orders',
        learn: 'Robot helpers run a program of if-then rules. You set its numbers, like “keep 2 alpha, send the rest home.”',
        quiz: { q: 'A helper’s rule says “if alpha is above 2, send the rest home.” It has 5 alpha. What does it do?', choices: ['Sends 3 alpha home and keeps 2', 'Keeps all 5', 'Sends all 5 home'], answer: 0, why: 'Above 2 means anything over 2 goes home: 5 − 2 = 3.' } },
      { id: 'readcode', title: 'Read the robots’ program', xp: 40, go: '/ops/orders',
        learn: 'Robot Rules shows your helpers’ orders as a program. It runs top to bottom, and the first rule that fits is the move.',
        quiz: { q: 'A raider helper’s planet still has ore, its machines are on and all its ships are built. Its meeting point is empty. Which line runs?', choices: ['sail("home")', 'explore()', 'sendHome(alpha − 2)'], answer: 0, why: 'Top to bottom, the first rule that fits wins. The planet, machine and build rules don’t fit, so the raider rule runs.' } },
      { id: 'keys', title: 'Your secret key', xp: 40,
        learn: 'Your commander is controlled by a 24-word recovery phrase. Anyone with those words controls it, so never share them.',
        quiz: { q: 'Someone in chat asks for your recovery phrase to “help” you. You…', choices: ['Never share it, with anyone', 'Share it if they seem nice', 'Share just half of it'], answer: 0, why: 'Nobody honest ever needs your phrase. Sharing it, even part of it, gives away control.' } },
      { id: 'hood', title: 'Look under the hood', xp: 30, go: 'expert', check: { event: 'expert' },
        learn: 'Switch on Expert mode (the three-dot menu, top right) to see the real data: block numbers, hashes and raw event names.' },
      { id: 'health', title: 'Engineers watch their systems', xp: 30, go: '/ops/health', check: { route: '/ops/health' },
        learn: 'The game talks to many services. System Health measures each one live, so you can find out what is slow.' },
    ],
  },
];

export const LESSONS: Lesson[] = TRACKS.flatMap((t) => t.lessons);
export const lessonById = new Map(LESSONS.map((l) => [l.id, l]));
export const trackOf = (lessonId: string) => TRACKS.find((t) => t.lessons.some((l) => l.id === lessonId));
/** XP for finishing a whole track. */
export const BADGE_XP = 150;
