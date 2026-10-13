/* What each screen is, in words: the page title and description the router sets as you move, and
 * the text the build prerenders into every route's HTML so crawlers, link previews and readers
 * without WebGL get a real page. Browser-free: the prerender script imports this under node. */

export const SITE_NAME = 'Structs Command Deck';
export const SITE_TAGLINE = 'A full browser client for Structs, the 5X space strategy game on the Cosmos blockchain.';
export const SITE_DESCRIPTION = 'Structs Command Deck: a full browser client for Structs. Build, mine, refine and raid on chain with proofs ground on your GPU; run replicants; chat with your guild; read the guild data layer; watch the live galaxy and replay every real attack.';

export interface RouteDoc {
  /** The route's path, as linked and prerendered. */
  path: string;
  title: string;
  /** One or two sentences: the meta description. */
  description: string;
  /** Paragraphs of body text for the prerendered page (plain text; the renderer escapes). */
  body: string[];
  /** Needs keys to be useful: still prerendered, but listed after the public screens. */
  commander?: boolean;
}

export const ROUTES: RouteDoc[] = [
  {
    path: '/lobby', title: 'The Concourse',
    description: 'The Structs lobby: walk a round plaza as a droid built from your PFP, talk with other commanders in speech balloons, and reach every part of the game from its kiosks.',
    body: [
      'The Concourse is where commanders meet. Your portrait becomes a droid you walk around in a plaza under a glass dome, with a kiosk for each part of the game (Base, Battle, Explore, Trade, Team and Lab), a warp gate to training battles, a live news wall, and the Academy.',
      'Each deck is a chat channel: what people say pops up as speech balloons over their droids, with stamps and quick phrases for pad players. New players build a droid, pick a name and a guild first, then ride the lift up.',
    ],
  },
  {
    path: '/academy', title: 'Academy',
    description: 'Learn Structs by playing it: short lessons and quizzes on strategy, economics and technology, from ambits and charge to supply and demand, proof of work and if-then robot rules.',
    body: [
      'The Academy teaches the game one short lesson at a time, in three tracks. Strategy covers units and ambits, charge, guards, stealth, Command Ships and the daily challenge. Economics covers Alpha Matter, risk, power supply and demand, scarcity, the energy market, price per unit and exchange rates. Technology covers blocks, proof-of-work hashing, the command line, real chain messages written as code, if-then robot rules, reading the robots’ program, and keeping a recovery phrase secret.',
      'Each lesson finishes itself when you do the thing (win a training battle, open a screen) or answer its quiz, and pays experience toward your rank. A glossary explains every game word in plain language. Nothing here needs an account.',
    ],
  },
  {
    path: '/galaxy', title: 'Live Galaxy',
    description: 'Every planet ever discovered on the Structs testnet, streamed from the chain and drawn as a spiral galaxy: guild-lit home worlds, raids in flight, battle sites.',
    body: [
      'The galaxy is read live from the Structs chain. Every discovered planet is placed in a spiral by discovery order; commanders’ home worlds are lit in their guild’s colour, fleets away on raids fly red arcs to their targets, and recent battles flash where they happened.',
      'Search for any commander by name, player id (1-…), planet id (2-…) or address (structs1…) to open their world. Nothing here needs a wallet.',
    ],
  },
  {
    path: '/combat', title: 'Combat Theatre',
    description: 'Every attack ever fought on the Structs testnet, newest first, replayed shot by shot from the chain’s own EventAttack records on a 3D battlefield.',
    body: [
      'The Combat Theatre lists every MsgStructAttack the chain has seen (thousands and counting). Each record carries the whole exchange: attacker, every shot, blocks, counters and damage, so a fight is replayed exactly as it happened, over the battlefield as it stood the block before the first shot.',
      'Engagements group the attacks of one raid; a single link opens the whole engagement.',
    ],
  },
  {
    path: '/grid', title: 'The Grid',
    description: 'The Structs energy economy, live: reactors, substations, every allocation and infusion, and the players connected to each substation.',
    body: [
      'Power is the rate limit on everything in Structs. The Grid draws the reactors, the substations that split their capacity, and every player connected to each one, with allocations and infusions read straight from the chain.',
    ],
  },
  {
    path: '/sim', title: 'Battle Simulator',
    description: 'A playable fleet-versus-computer battle running the Structs combat rules: presets, random fleets, your own layouts, or real fleets loaded from the chain.',
    body: [
      'The Battle Simulator runs structsd’s own combat rules locally. Fight presets, random fleets, an edited layout, or real fleets pulled from any planet. The Gauntlet runs five escalating engagements where hulls you lose stay lost; the Daily is the same battle for everyone.',
      'Every battle has a code. A replay link lets anyone watch the exact fight; a fleet link lets them fight the same fleets.',
    ],
  },
  {
    path: '/codex', title: 'Codex',
    description: 'All 22 Structs struct types: 3D models with full mechanics, weapons, charge costs, build costs and computed matchups of what each can strike and what threatens it.',
    body: [
      'The Codex documents every struct the chain can build: command ships, fleet hulls across space, air, land and water ambits, and planetary structures. Each entry shows the struct’s weapons, targets, damage, charge and build costs, defences and the matchups computed from the combat rules.',
    ],
  },
  {
    path: '/command', title: 'Command Deck', commander: true,
    description: 'Your commander’s vitals, planet and fleet slot boards with every struct, and what each can do right now. Build, mine, refine, move and attack from one screen.',
    body: [
      'The Command Deck is your commander’s seat: charge, alpha, ore at risk, power, shield and rank, the planet and fleet boards with every struct, and the actions each one can take this block. Click a struct to build, activate, move, mine, refine, defend or attack; proofs of work are ground on your GPU and queued as transactions signed in the browser.',
    ],
  },
  {
    path: '/ops', title: 'Operations', commander: true,
    description: 'The transaction queue, the proof-of-work engine, the replicant foundry, standing orders and a health panel for every link.',
    body: [
      'Ops is the engine room: every transaction and its fate, the proof-of-work engine with its threads and thresholds, replicants and their standing orders, and health for every link from the chain socket to the vault.',
    ],
  },
  {
    path: '/forge', title: 'The Forge', commander: true,
    description: 'Every message the Structs chain accepts, as a form generated from structsd’s own proto, with doc comments, smart pickers and a dry run before you sign.',
    body: [
      'The Forge exposes all of the chain’s messages as forms built from the proto definitions: field docs, pickers for your structs, players and addresses, a dry run against the node, and a signed submission through the queue.',
    ],
  },
  {
    path: '/economy', title: 'Economy', commander: true,
    description: 'Power supply against draw with a brownout what-if, reactor fuel, the power market, guild token banks and transfers between accounts.',
    body: [
      'Economy covers power (supply, draw, headroom, substations and every allocation verb), fuel (reactors, infusions and defusions), the market for power agreements, guild token banks (convert, redeem, swap, mint) and transfers between every account.',
    ],
  },
  {
    path: '/comms', title: 'Comms', commander: true,
    description: 'Matrix chat on your guild’s homeserver, signed in with one wallet signature: pinned, direct, guild and galaxy channels.',
    body: [
      'Comms is guild chat over Matrix, signed in with a single wallet signature. Pinned, direct, guild and galaxy channels, rich references to players and planets, and alerts that follow you around the deck.',
    ],
  },
  {
    path: '/intel', title: 'Intel',
    description: 'The guild data layer: the live GRASS event stream, guild dossiers, leaderboards, raids and a ledger for any commander.',
    body: [
      'Intel reads the guild data layer. Activity is the GRASS event stream, live and public. Guild dossiers combine profile, power, bank and roster; leaderboards rank commanders; raids and the ledger follow the alpha.',
    ],
  },
  {
    path: '/guild', title: 'Guild Hall', commander: true,
    description: 'Rosters and ranks, the membership desk, joining another guild, and permissions down to the bit.',
    body: [
      'The Guild Hall is membership: rosters and ranks, requests and invites, approve, deny, kick and promote, joining another guild, and the permission bits that say who may play, hash or transfer for you.',
    ],
  },
];

export const ROUTE_BY_PATH: Record<string, RouteDoc> = Object.fromEntries(ROUTES.map((r) => [r.path, r]));

/** Title and description for a route name and its parameters (the router's default; screens refine). */
export function describeRoute(name: string, params: Record<string, string>): { title: string; description: string } {
  const base = ROUTE_BY_PATH['/' + (name === 'planet' ? 'galaxy' : name)];
  if (name === 'planet') {
    const id = params.id || params.player;
    return { title: id ? `${params.player ? 'Commander' : 'Planet'} ${id}` : 'Planet', description: id ? `${params.player ? 'Commander' : 'Planet'} ${id} on the Structs testnet: the planet map in 3D, its owner’s dossier, structs, guards, raiders, ore and shield.` : base.description };
  }
  if (name === 'combat' && params.hash) return { title: `Attack ${params.hash.slice(0, 10)}…`, description: `A real Structs attack, replayed shot by shot from the chain’s EventAttack record.` };
  if (name === 'guild' && params.guild) return { title: `Guild ${params.guild}`, description: `Guild ${params.guild} on the Structs testnet: roster, ranks and membership.` };
  if (name === 'intel' && params.tab) return { title: `Intel · ${params.tab[0].toUpperCase()}${params.tab.slice(1)}`, description: base.description };
  if (name === 'economy' && params.tab) return { title: `Economy · ${params.tab[0].toUpperCase()}${params.tab.slice(1)}`, description: base.description };
  if (name === 'ops' && params.tab) return { title: `Ops · ${params.tab[0].toUpperCase()}${params.tab.slice(1)}`, description: base.description };
  if (name === 'forge' && params.msg) return { title: `Forge · ${params.msg}`, description: `${params.msg}: one of the messages the Structs chain accepts, as a form ready to fill, dry-run and sign.` };
  if (name === 'academy' && params.track) return { title: `Academy · ${params.track[0].toUpperCase()}${params.track.slice(1)}`, description: base.description };
  if (name === 'sim' && params.code) return { title: params.code.startsWith('R') ? 'Battle replay' : 'Shared battle', description: 'A battle in the Structs Battle Simulator, shared by link.' };
  return base ? { title: base.title, description: base.description } : { title: SITE_NAME, description: SITE_DESCRIPTION };
}
