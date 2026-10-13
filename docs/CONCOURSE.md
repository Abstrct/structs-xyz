# The Concourse

The lobby at `/lobby`. Your PFP is a droid you walk around a round plaza in, the deck's chat channel plays out as speech balloons over people's droids, and a kiosk for each hub opens that hub's places. The design canvas **Structs × PSO Design Plan** holds the plan, boards 00–14.

## Getting in

- **A commander with a player:** PRESS START goes straight to the lobby. Settings › Start in the lobby switches it off, so the title's doors show instead (`startIn` in `src/core/settings.ts`).
- **A visitor:** keeps the title's doors, with Battle focused (the playtest bot needs this). The first door is **Join**, which opens player setup in the hangar under the plaza:
  1. Build a droid: each PFP layer can be stepped through, or press Roll.
  2. Pick a name.
  3. Pick a guild.
  4. Launch. The guild signup carries the droid as `pfp_client_render_attributes`, so it's on chain from the player's first block.
- **The arrival bay:** shows the signup's steps while the guild creates the player, and offers a practice battle and a lesson while you wait. When the player lands, *Rise to the Concourse* takes the lift up.
- **Players only:** a Matrix user without a commander (`@1-…`) gets no droid, balloon or log line here. The full Comms panel is unchanged.

## Code

| Where | What |
|---|---|
| `src/data/droidParts.ts` | PFP layers → part families. Spire and Twin bodies hover; the rest walk. `pfpAttrs()` reads a portrait the way `portrait()` does. |
| `src/gfx/droid/kit.ts` | Faceted primitives in one buffer, each vertex on a bone: a whole droid is one rigidly skinned mesh and one draw call. |
| `src/gfx/droid/droid.ts` | The part recipes per family, the bone frame per gait, and `skinnedDroid()`. |
| `src/gfx/droid/skin.ts` | Reads the layer pixels into an atlas: a palette per part, the layer as a decal on the part's front, and an emissive mask of its bright, rare pixels (eyes, visors, screens). |
| `src/gfx/droid/actor.ts` | One droid in the world: shared builds per PFP, gaits, talking, eight emotes, and the flat-bust sprite for far or low-end crowds. |
| `src/screens/lobby/layout.ts` | The plaza's plan, pure: stations, colliders, the spawn, each person's seeded home spot, and `clampWalk`. |
| `src/screens/lobby/world.ts` | The hall: a floor painted per deck, hull walls under tall windows onto a planet, ceiling ribs carrying light, the central pillar with the chevron in its capsule, a counter per hub (attendant, monitor), the warp pad, the news screen, the Academy console, the deck lift, and the hangar below. `setTheme()` recolours it for each deck. |
| `src/screens/lobby/lobby.ts` | The screen: hangar or plaza, walking, the camera, stations, the HUD, the Mirror, profile cards and the Instructor. |
| `src/screens/lobby/crowd.ts` | Who's on the deck and where they stand, plus the local mute and block lists. |
| `src/screens/lobby/talk.ts` | Decks (channels), the five-line log, the input (with the recovery-phrase guard), stamps and phrases. |
| `src/screens/lobby/tags.ts` | Nameplates, balloons, typing dots and edge chips, in the DOM. |
| `src/screens/lobby/menus.ts` | The window kit: station dialogs, the ring menu, decks, stamps, emotes, phrases, profile cards, part rows. |
| `src/screens/lobby/setup.ts` | Player setup and the arrival bay. |
| `src/styles/dc-concourse.css` | The window kit, HUD, balloons and setup. |

Tests: `scripts/droid.test.ts` covers every family combination (inside 1,800 triangles) and the family tables. `scripts/lobby.test.ts` covers room state, stamps, and the plaza plan.

## The look

The hall follows the Dreamcast-era lobbies: high-key light, pale hull panelling, periwinkle floors with maroon bands, magenta, cyan and amber light strips, and green CRT monitors. We studied a PSO disc for proportions and palette only. Every shape and texture here is drawn in code; nothing from the disc ships. Each deck gets its own floor, band and light colour (`THEMES` in world.ts), the way the old lobbies did.

Bloom only takes the lamps. Light strips burn at `LAMP` (2.6× white) and the lobby's bloom threshold is 1. Lit paint peaks around 0.85, so it never blooms. The camera stays inside the wall (`CAM_R`) and stops short of the pillar.

The HUD has my plate (aura gem, name, power in use, charge) at the top left, the deck plate under it, and the three nearest droids under the map.

## Controls

| Action | Keyboard | Pad | Touch |
|---|---|---|---|
| Walk | WASD or arrows (Shift runs) | Left stick or d-pad | Left thumb |
| Look | Drag | Right stick | Drag on the right |
| Use | E or Space | A | Tap the station |
| Talk | Enter | Start | Talk |
| Stamp | X, or 1–8 | X | Stamp |
| Menu | R | Y | Menu |
| Face ahead | F | L or R | Walk: the camera swings in behind you |

The lobby reads the pad itself while you walk (`capturePad` in `src/core/pad.ts`). Any window on top gives the pad back, and so does focus anywhere else: the top bar, a guide card, a toast or the Comms dock. From the top bar, Escape (B) or a click on the 3D view goes back to walking.

## Talking

- **Joining decks:** the plaza shows one deck (channel) at a time; the deck lift or the deck plate switches. The lobby never joins a room on its own: if you aren't on that channel (you left it, or signed in with a pasted token), the chat note offers **Join**, so a leave sticks as it does in Comms.
- **Sending:**
  - Stamps are limited to one a second.
  - Anything that looks like a recovery phrase asks first, and is sent only if you confirm.
- **Mute and block:** both are local to this browser. They're on each droid's card, and the ring menu's **People** lists everyone you've muted or blocked, with the way back.

## Where people stand

- **Phase 1:** everyone has a home spot seeded from their Matrix id. No server is needed.
- **Phase 2:** when you stand still, the client writes a room state event, `xyz.structs.lobby.spot`, keyed by your Matrix id. It holds `{x, z, yaw, t}` and is sent at most every 6 s. Everyone else then walks your droid there.

The rooms must allow the event first. A room admin adds it to each deck room's power levels (#sn-corp, #help, #infrastructure):

```
"events": { "xyz.structs.lobby.spot": 0 }
```

You can add it in Element via `/devtools` › Explore room state › `m.room.power_levels` › Edit. Or PUT the whole `m.room.power_levels` content back with that key added. Until then the server answers M_FORBIDDEN, the client stops asking for that visit, and Phase 1 holds.

## Dev

On a dev server, `/lobby?plaza` walks into the plaza without a commander. `&crowd=14` adds a pretend deck of real commanders' PFPs who chat on a timer. Nothing is sent anywhere, and builds drop it (`src/screens/lobby/dev.ts`).
