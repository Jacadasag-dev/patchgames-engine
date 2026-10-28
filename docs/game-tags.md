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

A game's developer, a human in the editor or an AI through the connector, says
how many players the game is for and how many teams it has. The declaration is
a JSON file, `src/game/roster.json`, with its limits and descriptions in
`src/game/roster.schema.json` beside it, so the editor's existing JSON form
edits it (no form of its own), the connector's file tools edit it like any
other file, and the build reads it into the game package the lobby loads:

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

**Conflicts** are reported, never silently resolved: a game declaring teams
without the `team` tag runs without team rules and the lobby shows one group; a
`team`-tagged game declaring `teams: 0` runs with two teams by parity. Both
appear as warnings in `get_game.modeAuthoring.roster.warnings` and in the
editor's Game tags dialog, so the creator adds or removes the tag. Players are
dealt to teams by seat parity as before (`seat % teams`), so team indices are
stable while seats change.

Alternatives considered: the declaration setting the `team` tag by itself
(rejected: tags are the creator's and content never changes them) and the host
overriding a declaration (rejected: the declaration is the game's intent, and a
game that wants variation declares a range).

**Where it shows.** The package carries the declaration (`GamePackage.roster`),
so `describe_game` reports it on a built draft and `get_game` reads the draft's
file directly, built or not, with the effective seats, limits and teams and any
conflict or file error under `modeAuthoring.roster`; the authoring guide's
`roster` topic shows the file, the game tags handbook the one-line form; the
editor's Game tags dialog shows the declared roster, the effective seats and any
conflict, and points at the file's Form mode. Every starter and the engine canvas
ship an empty `roster.json` with the schema, so the form has fields to add
(players as a count or a range, teams, team size) and nothing is declared until
the developer says so.

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
starter already speaks them; players and connectors never need them again.

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
  arena; rejected because a tag that does nothing misleads players and connectors.
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

## Seasons: tag categories elect starters

The season election keeps its machinery (plays, publications, the frozen snapshot,
the fallback) and changes two things: it keys on **tag categories** and it replaces
**starters**, never a game's base.

**What a category is.** Options for a game with up to three tags:

1. **Each of its tags (chosen).** A game tagged `arena`, `team`, `survival` is a
   candidate in three categories and may win any of them, so a popular team arena
   can become both the Arena starter and the Team starter. Membership comes from
   the tags recorded with each play, so retagging mid-season moves only the plays
   made afterwards, and the elected revision must still carry the tag. Cost: one
   candidates query per tag (seven) instead of per mode (four), and a `LIKE` on the
   recorded tags. Nothing new is stored on a play.
2. **Its archetype only.** What the per-mode election did. Rejected: modifier
   starters could never be elected, and the Creative canvas would stay empty for
   ever while creative games are the games people actually make.
3. **Its exact tag set.** Rejected as before: fragmentation, and no stock starter
   for most combinations.

**How popularity is counted.** Per category, with the existing score: unique
players × 10 plus capped repeat plays, ties by unique players, then first play.
A play counts once in every category the game's tags name; there is no
cross-category normalisation, so a game's score is the same number in each of its
categories and only the competition differs.

**Eligibility** is unchanged: a published revision of a game that is not hidden,
deleted, archived or a lobby copy, whose mods are all still available, published
before the cutoff, and whose content supports the shape the starter's tags select.
Membership comes from the plays, so a game retagged after people played it under a
tag still competes there; the starter it becomes pre-fills the category's tag plus
whatever of the game's own tags fits beside it.

**Outcome.** At season end the winner's exact published content is registered as
the category's starter for the new season (a base snapshot plus the game's name,
tags and revision). Every starter under that category is replaced: the category
has one starter, so new games, the lobby's starter tile and mod workspaces of that
tag all begin from the winner. When no game qualifies, the previous season's
starter carries forward (the stock content if nothing was ever elected). Categories
without stock content (`team`, `survival`) simply have no starter until a season
elects one. The `duel` category keeps its extra step: the winner is also promoted
into the shared Duel game of the release, as before, because the matchmaking queue
plays it.

**Existing games are unaffected.** A game's `base_id` never moves with an election;
the new starter appears in the base picker as the recommended choice and a creator
moves to it deliberately. Lobbies pick games, not bases, so a lobby that has a game
chosen keeps it; a lobby that has not chosen one opens on the current Duel starter.
Free play (no tags) earns no participation and is in no category.

Participation rules follow the derived rules: open sessions (rpg, social, creative,
free play) earn it after a minute of connected play; closed rounds at a completed
round. Team and survival change neither.

## The lobby picks a game

The lobby has **no mode selector and no base selector**. The host picks a game;
the game brings its base and its tags, and the session's shape and seats follow
the tags.

- **The game picker** lists the available starters first (one tile per starter)
  and then published community games, with the browser's search and sort. A **base
  filter** narrows the list to the games built on one base: the engine versions,
  the current starters and the frozen season starters, read from the base registry
  a game revision already records (`custom_revisions.base_id`). "All bases" is the
  default.
- **Mods wait for a game.** The shared panel shows only the Game section until a
  game is chosen (a starter tile counts); the Mods section then appears beside it.
  When the chosen game changes, every selected mod that does not support the new
  game's shape is **removed** and the setup message names them and why ("Removed
  mods that do not support Just Chatting: Temple, Lanterns."). The build's own
  resolution still omits mods that conflict with the content and reports them as
  today. Compatibility is the mods' declared shape support (`supported_modes`),
  which is what mode compatibility always was; no new notion is introduced.
- **Seats** are a lobby setting beside the game: the host picks 1–32 (never below
  the tags' minimum). A new game resets the seats to the game's `seats`; a seated
  player beyond the new count moves to the spectators.
- **Ready starts the round.** There is no Apply setup button. The selected game's
  tags and declared roster configure the lobby immediately. When all seated players
  are ready, the lobby counts down, then builds and prepares the game while keeping
  the lobby and voice connected. The arena appears once preparation finishes, with
  its normal countdown before play. Unreadying cancels the start; a failed build
  leaves the pending setup available to retry.
- **Player tiles are dynamic.** The grid shows the seated players and exactly one
  empty tile, whatever the seat count, and no empty tile once the lobby is full.
  With the `team` tag each team is its own group with its own single empty tile
  until that team is full; a team's capacity is its share of the seats by parity
  (the first teams get one more when the count does not divide). A two-seat round
  keeps the face-off layout. The host's member menu moves a player to the
  spectators, to a seat, or to a team, never to a numbered slot.
- **Up to 16 teams.** Teams are named and coloured from a fixed scheme of 16
  (Blue, Orange, Green, Red, Purple, Gold, Teal, Pink, Lime, Crimson, Sky, Amber,
  Violet, Mint, Coral, Slate), each group and tile carrying its colour. Layout
  options for sixteen groups and up to 32 players:
  1. **A wrapping grid of team columns (chosen).** Each team is a column of its
     tiles; columns wrap into rows at a 150 px minimum, so a desktop width shows
     five or six teams per row and sixteen teams in three rows. With more than
     four teams the tiles use the compact style (smaller avatar and name). The
     grid scrolls inside the panel as the arena roster does. Cost: with many teams
     the tiles are small and the panel needs scrolling; nothing is hidden.
  2. **A wrapped list** (teams as inline rows). Rejected: a team's open spot
     drifts away from its players and rows of different lengths read badly.
  3. **A collapsing layout** (full teams collapse to a count). Rejected: it hides
     who is seated, which is what the lobby is for.
- **The scrollbar sits on the panel's edge.** The seat grid is the scrolling
  element; it bleeds into the panel's padding with the padding moved inside the
  scroller, so the scrollbar is flush with the panel's right border and the tiles
  keep their inset.
- **What the lobby opens with.** Options:
  1. **Nothing runs until a game is chosen (chosen).** A new private lobby (the
     menu's Host game, a Discord party) opens without a game: the panel shows the
     Game section alone, the start bar says "Choose a game to play", ready and
     start are refused by the server until a game is chosen, and the match room is
     built after everyone readies up and the lobby countdown finishes. Friends can still take seats and talk.
     A lobby opened for a specific game or starter (a Play button on a game, a
     request that names tags) still opens on it. Cost: one extra click for a party
     that wants the Duel starter; the lobby room itself carries the engine's
     default schema until then.
  2. **The current Duel starter runs until a game is chosen.** What this branch
     did first; replaced at the user's direction, because a lobby should never
     pick Duel on its own.
  3. **The host's last played game.** Rejected for now: needs a per-account
     timestamped history (the adoption table records who used a game, not when),
     and the game may have been unpublished since. A "Recent" filter in the picker
     is the natural later form.
- **Changing tags in the lobby** is gone with the mode selector: the game's tags
  are the game's. To run the Duel starter 2 v 2, a creator makes a game from the
  Duel starter with the `team` tag and publishes it; the lobby then picks it.

## Migration

Persisted data today: `custom_games.mode`, `custom_revisions.mode` (and the `flags`
columns this branch added), `custom_bases.mode`, `custom_change_packs.preview_mode`
and `supported_modes`, `season_game_plays.mode`, the per-mode base and selection
tables, room join options and the connector's `mode` fields.

- `season_mode_game_selections.mode` and `custom_season_mode_bases.mode` become the
  **category key**: new rows store the tag id, and legacy rows keyed by a shape id
  (`battle-royale`, `rpg`, `just-chatting`) are read as that shape's archetype tag.
  `custom_bases.mode` keeps meaning the content's shape. The frozen snapshot gains
  the winner's `tags` and `category`. Stock starters stay in `custom_mode_bases`
  (per shape) and `custom_blank_bases`; `custom_season_bases` and the Duel release
  pointer are unchanged.
- `custom_blank_bases.build_sha` records the release that registered a canvas; engine
  versions are the rows with `mode = 'engine'` (their `custom_bases.mode` is the
  free-play shape, since the canvas supports every shape), newest first.
- `custom_games.tags` and `custom_revisions.tags` (`TEXT NOT NULL DEFAULT '[]'`)
  become the canonical description. A one-time migration fills them from
  `mode` and `flags` (`tagsFromLegacy`), recorded in `custom_pack_migrations` so it
  runs once. The `mode` columns stay as a **derived shape index**, rewritten on
  every save from the tags, so discovery filters, builds and elections keep their
  SQL; the `flags` columns are rewritten the same way and no longer read.
- `custom_bases.mode` keeps its meaning: the legacy shape the base's content
  defaults to. Starter registration is unchanged underneath (the Duel release
  pointer, `custom_mode_bases`, `custom_season_mode_bases`, `custom_blank_bases`).
- `season_game_plays.tags` and `season_game_pending_plays.tags` record the tags;
  `mode` on those tables stays the archetype key the election reads.
- Mods keep `supported_modes` as content-shape compatibility: a mod declares which
  shapes it runs under, which is what mode compatibility always meant.
- Existing games behave as before: `gameRules(tagsFromLegacy(mode))` equals the
  legacy rules for every mode, which a test asserts, and a migrated game's derived
  `mode` equals its old one.

### Connector compatibility

`create_game` takes `tags` (preferred) and `starter` (any tag with a registered
starter, or `blank`); `mode`, `flags` and `base` keep working as aliases (`mode`
and `flags` become tags, `base:"season"` with a mode selects that archetype's
starter, `base:"blank"` the blank one).
Responses carry `tags` and a derived `mode`. `get_game.modeAuthoring` keeps its
name and fields and gains `tags`, `archetype` and `starter`-independent effective
rules (`maxPlayers` is always 32; `seats` is the roster a lobby opens with).
`open_mod`, `create_mod_workspace`, `set_mod_modes`, `search_mods` and
`verify_feature_modes` keep their shape-based `mode` arguments: they concern
content compatibility, not a game's rules. The room's join options take `tags`
with `mode` and `flags` as aliases; for a lobby they name the starter it opens on.
The lobby messages are `lobbyGame {generation, revisionId | starter}`,
`lobbyPacks {generation, layers}`, `lobbySeats {count}` and `lobbyApply`; the
`lobbyGame` and `lobbyMode` messages are gone with the base and mode selectors.

## What a tag does not change

Content, mods, the build, the package hash or `supportedModes`. Changing tags in
a lobby never rebuilds anything; the room is recreated with the new rules, as a
mode change was.

## Deliberately left out

- Team counts other than two, team balancing, team switching mid-round, team chat
  or voice. Ranked play with any tag but `duel`. Bots and training under modifiers.
- Mod compatibility per tag and mod previews under modifiers.
- Elections for free play; per-combination elections; electing the blank canvas.
- Renaming the legacy shape ids inside the content contract and the shape tables.
- Widening the content verification probes and inspection scenarios beyond the
  legacy shape ranges (a 32-player duel is allowed by the host but not probed).
- A "last played" lobby default and a Recent filter in the game picker.
- A Discord party asking for a starter when it opens (the activity route passes no
  tags, so a party waits for a game like any other lobby).
- Per-team sizes that differ between teams, team names chosen by the game, and
  more than 16 teams. Cross-field schema rules (teams × teamSize within the
  players): the contract checks them and the form shows its message.
- Registering an engine version from host-only engine changes: a version is
  registered when the canvas bundle changes, which host-side code does not alter.
- A hunger indicator. Candidate tags for a later set: `respawn`, `hardcore`,
  `sudden-death`, `chat` (host text chat without the social shape).
