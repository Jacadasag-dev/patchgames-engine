# Game tags and starters

A game is described by **up to three tags**. There are no modes: the tags decide the
host rules a game runs under, a **starter** is only the content a new game begins
from, and a starter's tags are a suggestion the creator can change at any time.
Tags never cap the roster: the engine's 32-player limit is the only hard limit, and
the number of seats is a lobby setting. A lobby picks a **game**, never a mode or a
base; the game brings its tags and its base with it.

This document replaces the base-mode design (`docs/game-rule-flags.md`, now
removed). [Arena](arena.md) and [RPG and Just Chatting](session-modes.md) describe
the starters' content.

## The tag vocabulary

| Tag | Kind | What it contributes to the rules |
| --- | --- | --- |
| `duel` | archetype | A 60 s clock, a closed roster, one life. The round ends when at most one player is standing; at the clock the highest health wins, equal health draws. Rated when the matchmaking queue made the room. Replays. Opens with 2 seats. |
| `arena` | archetype | A 300 s clock, a closed roster, one life, contact healing. The last living player wins; nobody or several at the clock is a draw. Unrated. Replays. Opens with 32 seats. |
| `rpg` | archetype | No clock. Honours content's `cooperative` contract: locked party, downed players, teammate revives, party victory or defeat. Content without it is an open world with a 3 s respawn. Opens with 5 seats. |
| `social` | archetype | No clock, open roster, no damage, host text chat. Shown as "Just Chatting"; `just-chatting` is accepted as an alias on input. Opens with 32 seats. |
| `team` | modifier | Two teams by seat parity (Blue, Orange). No friendly fire for damage, blockers or healing. One life. The round is competitive and closed: a team with nobody standing loses at once, content may end it for a team through `teamObjective(ctx)`, and at the clock more living players wins, then more total health, else a draw. Needs one player on each team; a team duel opens with 4 seats. |
| `creative` | modifier | No damage, no healing, no winner, no clock. The round is an open session the host ends, players join and leave freely, and one player is enough. |
| `survival` | modifier | Hunger: every living player loses a full health bar per 240 s of play, applied by the host before content damage. Checked healing entities work in every game that has damage and never revive. |

A game with **no tags** is **free play**: no clock, open roster, damage on, a 3 s
respawn, no winner, no chat, no replay, 32 seats. It is what a blank canvas runs as
until its creator says what it is.

### Rosters: no hard caps

No tag caps the roster. The only hard limit is the engine's `MAX_MATCH_PLAYERS`
(32): a duel-tagged game can seat 32 players and an arena can seat 2. What a tag
fixes is the **minimum** a round needs and the **seats a lobby opens with**; the
host changes the seat count in the lobby (1–32, never below the minimum), and that
count, not the tags, is the room's roster.

| Rules | Minimum | Opens with | Large roster | Small roster |
| --- | --- | --- | --- | --- |
| free play, `social`, `creative` | 1 connected player | 32 (creative keeps its kind's seats) | open session, players come and go | one player alone |
| `rpg` | 1 | 5 | one party of everyone seated; content decides how many classes it has | a solo campaign |
| `duel` | 2 | 2 (4 with `team`) | one life each, the round ends when one player stands, else the highest health at 60 s | the classic 1 v 1, unchanged |
| `arena` | 2 | 32 | last standing within 300 s | a 2-player arena is a longer duel with healing and no clock tiebreak |
| `team` | 2 (one per team) | the kind's seats, 4 for a duel | seat parity splits any count into Blue and Orange; odd counts give Blue one more | 1 v 1 is a valid team round |

The minimums are the only roster rules: "at least one connected player" for open
sessions and "at least two" (one per team) for competitive rounds. Leaving a
one-life round with teams or more than two seated eliminates the leaver and the
round goes on; leaving a two-player round forfeits it at once, as a duel always did. Everything else
that depended on a roster size now reads the seat count: the lobby's seat grid, the
room's player slots, the arena's bot fill, the start condition and the replay
header. Content reads the actual participant count from `setup` as it always did.

Legacy content-shape limits (`modeRules(mode)` in `gameModes.ts`: Duel 2–2, RPG
1–5) remain the range the isolated content verification probes a shape at. They no
longer gate a room; widening the probes is left out (below).

### The game declares its roster

Declare the roster in `src/game/roster.json`. The build reads this file into the game package. Its JSON schema documents the available fields:

```
{ "players": 8 | [min, max], "teams": 0 | 2–16, "teamSize": n }   (every field optional)
```

- `players`: one count, or an inclusive range, within the engine's 1–32.
- `teams`: 0 (no teams) or 2–16. One team is rejected.
- `teamSize`: players per team, only with teams; `teams × teamSize` must equal a
  declared count or fall inside a declared range.
- Validation is the contract's (`parseRoster`, read through `readRosterFile`):
  an invalid file fails the build in its settings stage with a `ContractError`
  naming the field, like any other contract mistake, and the editor's form shows
  the same message by field before any build (the schema's limits first, the
  contract's rules on top), so an invalid file never passes the form silently.
  A missing or empty file declares nothing and keeps today's behaviour: the
  tags' seats, and two teams by seat parity under the `team` tag. A `roster`
  field on the logic object is refused by `describe()` with a pointer to the file.

**Composition.** Tags decide the rules; the declaration is the game's intent
about the roster, applied on top of them (`gameRules(tags, roster)`):

| Field | Without a declaration | With one |
| --- | --- | --- |
| `maxPlayers` | the engine's 32 | the declared count or range maximum |
| `minPlayers` | the tag minimum (1 open, 2 competitive) | the larger of the tag minimum, the declared minimum and the team count |
| `seats` | the tag default (duel 2, team duel 4, rpg 5, else 32) | the declared count or range maximum |
| `teams` | 2 with the `team` tag, else 0 | the declared count with the `team` tag, else 0 |

The host's seat setting varies only within the declaration: a game declaring
exactly 6 players seats 6 and the dropdown offers nothing else; a game declaring
2–8 lets the host pick inside that range; a game declaring nothing keeps 1–32.
Players beyond a smaller count move to the spectators as today.

Alternatives considered: the declaration setting the `team` tag by itself
(rejected: tags are the creator's and content never changes them) and the host
overriding a declaration (rejected: the declaration is the game's intent, and a
game that wants variation declares a range).

**Any JSON file with a sibling schema.** The editor validates `<name>.json`
against `<name>.schema.json` when one exists, in the declarative format tuning
uses, extended with `optional`, `integer`, `pair` and `default` so a field can
be left out, must be whole, may be a `[min, max]` pair, or has a value the form
inserts when it is added. Tuning and the roster add their own rules on top; any
other pair of files validates against the schema alone; JSON without a schema is
free. Build and launch stay blocked while any settings file is invalid.

### How rules are derived

`gameRules(tags)` builds one record every host component reads:

```
minPlayers, maxPlayers (always 32), seats, durationMs, openSession, damage, healing,
teams, oneLife, respawnMs, attritionMs, competitive, cooperative, chat, rated, replay,
archetype, shape
```

`seats` is the roster a lobby opens with; `minPlayers` the fewest a round starts
with; `maxPlayers` is the engine limit and never varies.

Derivation is deterministic and ordered: start from free play, apply the archetype
tag (at most one, see below), then the modifiers in vocabulary order (`team`,
`creative`, `survival`). Each tag sets fields; later tags win where two touch the
same field. The only such overlaps in this set are intended: `team` closes the
roster and makes any archetype one-life and competitive; `creative` reopens it,
removes the clock, damage and the winner; `survival` turns healing on. `team` and
`creative` together, or `creative` and `survival`, are rejected rather than resolved
(below), so no result depends on a subtle override.

`archetype` is the archetype tag or `free`. `shape` is the legacy mode id content
still sees as `ctx.mode` and declares in `supportedModes` (`duel`, `battle-royale`,
`rpg`, `just-chatting`): the four archetypes map one to one, and free play reports
`just-chatting`, the only legacy shape with a 1–32 open roster. The content
contract keeps those ids because every built package, saved game test and content
starter already speaks them; host applications never need them again.

### Validation: the cap and the invalid pairs

One function, `normalizeTags`, validates a set and returns it in vocabulary order:
known ids (aliases mapped), no duplicates, **at most three tags**, at most one
archetype, and none of these pairs:

| | duel | arena | rpg | social |
| --- | --- | --- | --- | --- |
| team | ✓ 2 v 2 | ✓ | ✗ a party is already one team | ✗ no competition |
| creative | ✓ | ✓ | ✓ | ✗ already implied |
| survival | ✓ | ✓ | ✓ | ✗ damage is off |

plus `creative`+`survival` (nothing to drain) and `creative`+`team` (nothing to
compete for). With this vocabulary the largest valid set is an archetype and two
modifiers (`arena`, `team`, `survival`) or two modifiers alone; the cap of three
binds future tags. A tagless game is valid.

Two alternatives were considered for disagreeing tags:

- **Priority by kind without exclusion** (two archetypes allowed, the later one
  wins). Cheap to implement but every "duel + arena" game would silently be an
  arena; rejected because a tag that does nothing misleads host applications.
- **Union of permissions** (widest roster, longest clock). Rejected because the
  archetypes are coherent rule sets, not independent dials; an arena with a duel's
  knockout rule is neither game.

## Starters

A starter is the seeded game a new game begins from, and the game a lobby can pick
without anyone having published anything. There is **one starter per tag** plus
the blank canvas; a starter exists when it has stock content or a season elected
one:

| Starter | Stock content | After an election | Tags it pre-fills |
| --- | --- | --- | --- |
| `duel` | the shared Duel game of the release | the elected `duel` game | the starter game's tags (`duel` for stock) |
| `arena` | the Arena survival map | the elected `arena` game | `arena` for stock |
| `rpg` | the RPG campaign | the elected `rpg` game | `rpg` for stock |
| `social` | the Just Chatting lounge | the elected `social` game | `social` for stock |
| `creative` | the blank canvas | the elected `creative` game | `creative` for stock |
| `team`, `survival` | none; the starter appears once a season elects one | the elected game | the elected game's tags |
| `blank` | the engine itself (below), never elected | — | none |

### The blank canvas is the engine

There is no authored "blank" content apart from the engine: the canvas is flat
ground, shared movement and mouse look, and every improvement to the engine is a
new canvas. So the canvas is registered as an **engine version**: the release
worker builds the canvas bundle once per release and registers it when the bundle
differs from the last one (the base id is derived from the tree and package
hashes, so an unchanged engine registers nothing new). The registration records
the release sha (`custom_blank_bases.build_sha`, rows marked `mode = 'engine'`),
and players see it as "Engine 2026-10-26 · a1b2c3d". The newest engine version is
the canvas new games begin from; every version stays in the base picker and in the
lobby's base filter beside the starters, and games built on an older version stay
pinned to it until their creator moves them. Rows an earlier release registered
per shape ("Duel blank canvas") remain readable and keep their names.

Choosing a starter copies its content into the new game and pre-fills the elected
game's tags (or the one tag for stock content); the creator can change the tags in
the same dialog or later, with no rebuild, and can change the base content
independently through the base picker as today. A frozen season of a starter stays
selectable (`season: YYYY-MM`), and a game keeps the base it was built on whatever
later seasons elect.
