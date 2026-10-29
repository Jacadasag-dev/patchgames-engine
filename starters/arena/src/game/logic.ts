import type { DamageEntity, GameEvent, GameLogic, GamePlayer, HealingEntity, MatchContext, PlayerBody } from '../shared/gameApi.ts';
import { GAME_MODE_IDS, isSessionMode, modeRules } from '../shared/gameModes.ts';
import { isInsideSafeZone, ringSpawns, safeZoneAt } from '../sandbox/battleRoyale.ts';
import { shapes, type FightInput, type PlayerState, type WorldState } from './shapes.ts';
import type { GameTuning } from './tuning.ts';
import { applyCharacterMovement, moveCharacters } from '../sandbox/characters.ts';
import { preparePhysics, raycastPhysicsBatch, type PhysicsScene } from '../sandbox/physics.ts';
import { DEFAULT_MODE } from './mode.ts';
import { sharedTerrain } from './terrainWorld.ts';
import { arenaLayout } from './layout.ts';
import { aimDirection, eyePosition, advanceArrows, aimedChest } from './combat.ts';
import { armorCount, chestLoot, takeLoot } from './loot.ts';
import { lootPanelHit } from './lootUi.ts';
import { arenaInspectionSetups } from './inspectionSetups.ts';
import { applyArenaLook, ARENA_POINTER_LOOK } from './look.ts';
export { aimedChest } from './combat.ts';

function arenaPhysics(tuning: GameTuning): PhysicsScene {
  return sharedTerrain.read(tuning).scene;
}
let spawnKey = '', cachedSpawns: { x: number; y: number; z: number }[] = [];
const supplyRevisions = new WeakMap<WorldState, string>();

function applyMovement(state: PlayerState, input: FightInput | undefined, tuning: GameTuning): void {
  if (state.chestId) {
    if (Number.isFinite(input?.menuX)) state.chestCursorX = input!.menuX;
    if (Number.isFinite(input?.menuY)) state.chestCursorY = input!.menuY;
  } else applyArenaLook(state, input);
  const side = input?.moveX || 0, ahead = -(input?.moveZ || 0);
  applyCharacterMovement(state, { moveX: Math.sin(state.facing) * ahead - Math.cos(state.facing) * side,
    moveZ: Math.cos(state.facing) * ahead + Math.sin(state.facing) * side }, tuning.moveSpeed);
  if (input?.jump && state.grounded) { state.velocityY = tuning.jumpSpeed; state.grounded = 0; }
}
/** Prediction and authority use the same coordinated character foundation. */
export function movePlayer(state: PlayerState, input: FightInput | undefined, dtMs: number, tuning: GameTuning, opponents: readonly PlayerState[] = []): void {
  if (state.eliminated) return;
  applyMovement(state, input, tuning);
  moveCharacters([state, ...predictionOpponents(state, opponents, dtMs, tuning).map(player => ({ ...player }))], dtMs / 1000, tuning, arenaPhysics(tuning));
}

/** Prediction returns only this fighter. Keep the local collision neighborhood
 * and any touching chain, without simulating unrelated actors over unloaded
 * terrain. Authority still advances every participant in its separate batch. */
export function predictionOpponents(state: PlayerState, opponents: readonly PlayerState[], dtMs: number, tuning: GameTuning): readonly PlayerState[] {
  const dt = Math.min(Math.max(dtMs / 1000, 0), .25);
  const actors = [state, ...opponents];
  if (!Number.isFinite(dt) || actors.some(player => ![player.x, player.z, player.velocityX, player.velocityY, player.velocityZ].every(Number.isFinite))) return opponents;
  // Include vertical speed too: a slope can redirect falling motion sideways.
  const travel = actors.map(player => (Math.hypot(player.velocityX, player.velocityY, player.velocityZ) + Math.abs(tuning.gravity) * dt) * dt);
  const reach = (a: number, b: number) => 2 * tuning.fighterRadius + travel[a] + travel[b] + .1;
  const distance = (a: number, b: number) => Math.hypot(actors[a].x - actors[b].x, actors[a].z - actors[b].z);
  const included = new Set([0]);
  for (let index = 1; index < actors.length; index++) if (distance(0, index) <= Math.max(8, reach(0, index))) included.add(index);
  // A contact chain can transmit a push to a nearby actor; preserve the whole
  // component, including actors outside the initial eight-metre neighborhood.
  for (const a of included) for (let b = 1; b < actors.length; b++) if (!included.has(b) && distance(a, b) <= reach(a, b)) included.add(b);
  return opponents.filter((_, index) => included.has(index + 1));
}

/** Respawning changes only transient movement/combat state, preserving mod progression. */
function respawnPlayer({ players, tuning, mode }: MatchContext<WorldState, PlayerState, GameTuning>, player: GamePlayer<PlayerState>): void {
  // Reserve stable session positions so repeated late arrivals never bunch up as the roster grows.
  const count = isSessionMode(mode) ? modeRules(mode).maxPlayers : players.length;
  const terrain = sharedTerrain.read(tuning);
  const starts = ringSpawns(count, Math.min(tuning.spawnRadius, tuning.arenaRadius - tuning.fighterRadius));
  const key = JSON.stringify([terrain.revision, count, tuning.spawnRadius, tuning.fighterRadius, tuning.fighterHeight, tuning.maxSlopeDegrees]);
  if (key !== spawnKey) { cachedSpawns = terrain.spawns({ count, radius: tuning.fighterRadius, height: tuning.fighterHeight,
    maxSlopeDegrees: tuning.maxSlopeDegrees, preferred: starts }); spawnKey = key; }
  const spawn = cachedSpawns[player.index];
  Object.assign(player.state, spawn, { velocityX: 0, velocityY: 0, velocityZ: 0, grounded: 1,
    facing: Math.atan2(-spawn.x, -spawn.z), aimPitch: 0, eliminated: false, attackMs: 0, bowDrawMs: 0, bowShotDrawMs: 0, attackHeld: false, drawBlocked: false,
    cooldownMs: 0, bandageMs: 0, healPulse: false, chestId: '', chestCursorX: .5, chestCursorY: .5 });
}

function setupPlayer(ctx: MatchContext<WorldState, PlayerState, GameTuning>, player: GamePlayer<PlayerState>): void {
  player.hp = player.maxHp = ctx.tuning.maxHp;
  Object.assign(player.state, { physicsId: player.index, weapon: false, equipped: 0, sword: false, bow: false, arrows: 0, bandages: 0, armorFace: false, armorChest: false, armorLegs: false, armorArms: false, attackId: 0, attackWeapon: 0, healId: 0, previousHp: player.hp, interactHeld: false });
  respawnPlayer(ctx, player);
}

/** Use the same accepted terrain queries as actors. A mod may obstruct a cache;
 * relocate within its clearing or omit it instead of creating unreachable loot. */
function setupSupplies(tuning: GameTuning, playerCount: number, random: MatchContext<WorldState, PlayerState, GameTuning>['random'], existing: WorldState['supplies'] = []): WorldState['supplies'] {
  const count = Math.max(1, Math.min(Math.floor(tuning.supplyCount), playerCount - 1));
  const layout = arenaLayout(tuning);
  const sites = [
    ...ringSpawns(count, tuning.supplyRadius).map((point, index) => ({ ...point, id: `center-${index}`, kind: 'center', buildingId: undefined as string | undefined })),
    ...layout.lootSites.filter(site => site.kind === 'cache').slice(0, Math.max(0, Math.floor(tuning.cacheCount))),
  ];
  const terrain = sharedTerrain.read(tuning), supplies: WorldState['supplies'] = [...existing];
  for (const site of sites) {
    // Loot is created when its terrain becomes resident. Claimed chests remain
    // in authoritative state, so leaving and revisiting never resets their loot.
    if (supplies.some(chest => chest.id === site.id) || !terrain.available(site.x, site.z, tuning.fighterRadius)) continue;
    try {
      const building = 'buildingId' in site ? layout.landmarks.find(item => item.id === site.buildingId) : undefined;
      const [point] = terrain.spawns({ count: 1, radius: tuning.fighterRadius, height: tuning.fighterHeight,
        maxSlopeDegrees: tuning.maxSlopeDegrees, preferred: [site],
        accept: point => Math.hypot(point.x - site.x, point.z - site.z) <= Math.max(3, tuning.arenaRadius / 24)
          && (!building || (Math.abs(point.x - building.x) <= 2.8 * layout.scale && Math.abs(point.z - building.z) <= 2.8 * layout.scale))
          && supplies.every(other => Math.hypot(point.x - other.x, point.z - other.z) > 1.2),
      });
      supplies.push({ id: site.id, kind: site.kind, ...point, claimedBy: -1, loot: chestLoot(() => random('chest:' + site.id)) });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('Terrain spawn capacity:')) throw error;
    }
  }
  return supplies;
}

/** World directions match WASD: north is negative Z. */
function bearing(x: number, z: number): string {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(Math.atan2(x, -z) / (Math.PI / 4) + 8) % 8];
}

function reachableChest(chest: WorldState['supplies'][number], state: PlayerState, tuning: GameTuning): boolean {
  const origin = eyePosition(state, tuning), dx = chest.x - origin.x, dy = chest.y + .55 - origin.y, dz = chest.z - origin.z;
  const distance = Math.hypot(dx, dy, dz);
  if (distance > tuning.pickupRadius + .25) return false;
  if (distance < .001) return true;
  const [wall] = raycastPhysicsBatch({ scene: arenaPhysics(tuning), rays: [{ origin, direction: { x: dx / distance, y: dy / distance, z: dz / distance }, distance }] });
  return !wall || wall.distance >= distance - .05;
}

const game: GameLogic<WorldState, PlayerState, FightInput, GameTuning> = {
  mode: DEFAULT_MODE,
  supportedModes: GAME_MODE_IDS,
  featureCapabilities: ['player.position.v1', 'player.vertical-motion.v1', 'player.appearance.v1', 'world.terrain.v1'],
  terrainWorld: sharedTerrain,
  shapes,
  inspectionSetups: arenaInspectionSetups,
  setupPlayer,
  respawnPlayer,
  setupMatch(ctx) {
    const { world, players, tuning, mode } = ctx;
    world.elapsedMs = 0;
    world.terrainRevision = sharedTerrain.read(tuning).revision;
    world.zoneRadius = tuning.arenaRadius;
    world.zoneClosed = false;
    world.arrows = [];
    preparePhysics(arenaPhysics(tuning));
    for (const player of players) setupPlayer(ctx, player);
    world.supplies = mode === 'battle-royale' ? setupSupplies(tuning, players.length, ctx.random) : [];
    supplyRevisions.set(world, sharedTerrain.read(tuning).loadedRevision);
  },
  step({ world, players, inputs, tuning, elapsedMs, dtMs, mode, hits, random }) {
    const events: GameEvent[] = [];
    const cancelledActions = new Set<number>();
    const zone = mode === 'battle-royale'
      ? safeZoneAt(elapsedMs, { initialRadius: tuning.arenaRadius, delayMs: tuning.zoneDelayMs, shrinkMs: tuning.zoneShrinkMs })
      : { radius: tuning.arenaRadius, closed: false };
    world.elapsedMs = elapsedMs;
    world.zoneRadius = zone.radius;
    world.zoneClosed = zone.closed;
    const terrainRevision = sharedTerrain.read(tuning).loadedRevision;
    if (mode === 'battle-royale' && supplyRevisions.get(world) !== terrainRevision) {
      world.supplies = setupSupplies(tuning, players.length, random, world.supplies);
      supplyRevisions.set(world, terrainRevision);
    }
    for (const player of players) {
      const state = player.state, input = inputs[player.index];
      state.eliminated = player.hp <= 0;
      state.attackMs = Math.max(0, state.attackMs - dtMs);
      state.cooldownMs = Math.max(0, state.cooldownMs - dtMs);
      state.healPulse = false;
      if (state.eliminated) { state.attackMs = 0; state.bowDrawMs = 0; state.attackHeld = false; state.drawBlocked = true; state.bandageMs = 0; state.chestId = ''; continue; }
      const wasMenuOpen = !!state.chestId;
      applyMovement(state, input, tuning);
      // Container ownership is authoritative; prediction only returns numeric
      // motion/cursor fields and never speculatively edits this string ID.
      if (input?.closeChest || input?.jump || Math.hypot(input?.moveX || 0, input?.moveZ || 0) > .001) state.chestId = '';
      if (!wasMenuOpen) {
        const previousWeapon = state.equipped;
        if (input?.sword && state.sword) state.equipped = 1;
        if (input?.bow && state.bow) state.equipped = 2;
        if (state.equipped !== previousWeapon) {
          state.attackMs = 0;
          cancelledActions.add(player.index);
        }
      }
      if (wasMenuOpen) cancelledActions.add(player.index);
      const hurt = player.hp < state.previousHp || hits.some(hit => hit.player === player.index && hit.damage > 0);
      const cancelHeal = mode === 'just-chatting' || !input?.bandage || !!state.chestId || wasMenuOpen || input.attack || input.jump
        || Math.hypot(input.moveX, input.moveZ) > .001 || !state.grounded || hurt || player.hp >= player.maxHp || state.bandages <= 0;
      state.bandageMs = cancelHeal ? 0 : state.bandageMs + dtMs;
      if (state.bandageMs >= tuning.bandageDurationMs) {
        state.bandageMs = 0; state.bandages--; state.healId++; state.healPulse = true;
        events.push({ type: 'bandage', player: player.index });
      }
      state.previousHp = player.hp;
    }
    moveCharacters(players.filter(player => player.hp > 0).map(player => player.state), dtMs / 1000, tuning, arenaPhysics(tuning));
    // Stable participant ordering settles simultaneous requests for the same item.
    // Opening is separate from taking: simply walking over loot never claims it.
    for (const player of [...players].sort((a, b) => a.index - b.index)) {
      if (player.hp <= 0) continue;
      const state = player.state, input = inputs[player.index];
      // The binding already emits taps; consecutive true steps can represent
      // two distinct clicks and must not be mistaken for a held button.
      const press = !!input?.interact;
      if (press) {
        if (state.chestId) state.chestId = '';
        else {
          const chest = aimedChest(world, state, tuning);
          if (chest && reachableChest(chest, state, tuning)) {
            state.chestId = chest.id; state.chestCursorX = .5; state.chestCursorY = .5;
            if (chest.claimedBy < 0) chest.claimedBy = player.index;
            events.push({ type: 'chest-open', player: player.index, chest: chest.id });
          }
        }
      }
      const chest = world.supplies.find(item => item.id === state.chestId);
      if (chest && !reachableChest(chest, state, tuning)) state.chestId = '';
      else if (chest && input?.take) {
        const taken = takeLoot(state, chest, Math.floor(input.take));
        if (taken) events.push({ type: 'loot', player: player.index, chest: chest.id, items: taken });
      }
      const held = !!input?.attack, pressed = held && !state.attackHeld, released = !held && state.attackHeld;
      state.attackHeld = held;
      if (mode === 'just-chatting' || state.chestId || input?.closeChest || input?.take || input?.interact
        || input?.bandage || state.bandageMs > 0 || cancelledActions.has(player.index)) {
        state.attackMs = 0;
        state.bowDrawMs = 0;
        // A held menu click or weapon change must never queue a later shot.
        // An already-released button is ready for a new press next tick.
        state.drawBlocked = held;
        continue;
      }
      if (!held) state.drawBlocked = false;
      if (state.equipped === 2) {
        if (state.bowDrawMs > 0) {
          if (held) { state.bowDrawMs = Math.min(tuning.bowDrawDurationMs, state.bowDrawMs + dtMs); continue; }
          const drawMs = state.bowDrawMs;
          state.bowDrawMs = 0;
          if (!released || drawMs < tuning.bowMinDrawMs || state.cooldownMs > 0 || state.arrows <= 0 || world.arrows.length >= 128) continue;
          // Keep this shot's actual charge after the live draw timer resets.
          // Presentation may first observe the release after a skipped packet.
          state.bowShotDrawMs = drawMs;
        } else {
          if (pressed && !state.drawBlocked && state.cooldownMs <= 0 && state.arrows > 0 && world.arrows.length < 128)
            state.bowDrawMs = Math.min(tuning.bowDrawDurationMs, dtMs);
          continue;
        }
      } else {
        state.bowDrawMs = 0;
        if (!held || state.cooldownMs > 0) continue;
      }
      state.attackId++;
      state.attackWeapon = state.equipped;
      state.attackMs = state.equipped === 2 ? tuning.bowReleaseMs : tuning.attackDurationMs;
      state.cooldownMs = state.equipped === 2 ? tuning.bowCooldownMs : tuning.attackCooldownMs;
      if (state.equipped === 2) {
        const eye = eyePosition(state, tuning), aim = aimDirection(state);
        state.arrows--;
        world.arrows.push({ id: `arrow-${player.index}-${state.attackId}`, owner: player.index,
          ...eye, fromX: eye.x, fromY: eye.y, fromZ: eye.z,
          vx: aim.x * tuning.bowSpeed, vy: aim.y * tuning.bowSpeed, vz: aim.z * tuning.bowSpeed, lifeMs: 4000, target: -1 });
      }
      events.push({ type: 'attack', player: player.index });
    }
    advanceArrows(world, players, tuning, arenaPhysics(tuning), dtMs);
    return events;
  },
  entities({ world, players, tuning, mode }) {
    const bodies = players.map(player => ({ at: { x: player.state.x, y: player.state.y, z: player.state.z },
      radius: tuning.fighterRadius, height: tuning.fighterHeight,
      guard: player.hp > 0 ? Math.max(.2, 1 - armorCount(player.state) * tuning.armorReduction) : 0 })) as [PlayerBody, PlayerBody, ...PlayerBody[]];
    const damage: DamageEntity[] = [], healing: HealingEntity[] = [];
    const zone = { x: 0, z: 0, radius: world.zoneRadius, closed: world.zoneClosed };
    const strikes: { entity: DamageEntity; origin: { x: number; y: number; z: number }; target: { x: number; y: number; z: number } }[] = [];
    for (const player of players) {
      if (player.hp <= 0) continue;
      const state = player.state;
      if (mode !== 'just-chatting' && state.healPulse) healing.push({ id: `bandage-${player.index}-${state.healId}`, label: 'bandage', owner: player.index, target: player.index,
        amount: tuning.bandageHeal, at: { x: state.x, y: state.y + tuning.fighterHeight * .5, z: state.z }, radius: .2, interruptOnDamage: true });
      const meleeProgress = 1 - state.attackMs / tuning.attackDurationMs;
      // Windup and recovery are presentation only. Contact belongs to the
      // middle of the exact same authored swing phase used by actor animation.
      if (mode !== 'just-chatting' && state.attackMs > 0 && state.attackWeapon !== 2 && meleeProgress >= .25 && meleeProgress < .65) {
        const sword = state.attackWeapon === 1, reach = sword ? tuning.weaponReach : tuning.attackReach, aim = aimDirection(state);
        const origin = { x: state.x, y: state.y + tuning.fighterHeight * .5, z: state.z };
        const at = { x: origin.x + aim.x * reach * .65, y: origin.y + aim.y * reach * .65, z: origin.z + aim.z * reach * .65 }, radius = reach * .35;
        let nearest: typeof strikes[number] | undefined, nearestDistance = Infinity;
        for (const victim of players) {
          if (victim.index === player.index || victim.hp <= 0) continue;
          const target = { x: victim.state.x, y: Math.max(victim.state.y + tuning.fighterRadius, Math.min(victim.state.y + tuning.fighterHeight - tuning.fighterRadius, at.y)), z: victim.state.z };
          if (Math.hypot(at.x - target.x, at.y - target.y, at.z - target.z) > radius + tuning.fighterRadius) continue;
          const distance = Math.hypot(origin.x - target.x, origin.y - target.y, origin.z - target.z);
          if (distance >= nearestDistance) continue;
          nearestDistance = distance;
          nearest = { origin, target, entity: { id: `attack-${player.index}-${state.attackId}`, label: sword ? 'sword' : 'punch',
            kind: 'strike', owner: player.index, target: victim.index, damage: sword ? tuning.weaponDamage : tuning.attackDamage,
            shape: 'sphere', at, radius } };
        }
        if (nearest) strikes.push(nearest);
      }
      if (mode === 'battle-royale' && !isInsideSafeZone(zone, state)) damage.push({ id: `boundary-${player.index}`, label: 'boundary',
        kind: 'zone', owner: null, target: player.index, damage: tuning.zoneDamagePerSecond,
        shape: 'sphere', at: { x: state.x, y: state.y + tuning.fighterHeight * .5, z: state.z }, radius: .01 });
    }
    // Check terrain and buildings before emitting any melee contact.
    for (let start = 0; start < strikes.length; start += 256) {
      const batch = strikes.slice(start, start + 256), rays = batch.map(({ origin, target }) => {
        const dx = target.x - origin.x, dy = target.y - origin.y, dz = target.z - origin.z, distance = Math.max(.001, Math.hypot(dx, dy, dz));
        return { origin, direction: { x: dx / distance, y: dy / distance, z: dz / distance }, distance };
      });
      const walls = raycastPhysicsBatch({ scene: arenaPhysics(tuning), rays });
      batch.forEach((strike, index) => { if (!walls[index] || walls[index]!.distance >= rays[index].distance - .05) damage.push(strike.entity); });
    }
    if (mode !== 'just-chatting') for (const arrow of world.arrows) if (arrow.target >= 0) damage.push({
      id: arrow.id, label: 'arrow', kind: 'strike', owner: arrow.owner, target: arrow.target, damage: tuning.bowDamage,
      shape: 'sphere', from: { x: arrow.fromX, y: arrow.fromY, z: arrow.fromZ }, at: { x: arrow.x, y: arrow.y, z: arrow.z }, radius: .06,
    });
    return { bodies, damage, healing };
  },
  describePlayer: player => player.hp <= 0 ? 'ELIMINATED' : player.state.equipped === 2 ? 'BOW' : player.state.equipped === 1 ? 'SWORD' : 'UNARMED',
  controls: {
    inspection: { forward: { moveZ: -1 }, right: { moveX: 1 }, attack: { attack: true }, jump: { jump: true } },
    pointer: { mode: 'lock' },
    bindings: [
      { name: 'moveX', label: 'Move sideways', kind: 'axis', role: 'move-x', keys: ['a', 'd'], description: 'Strafe left and right.' },
      { name: 'moveZ', label: 'Move forward', kind: 'axis', role: 'move-y', keys: ['s', 'w'], description: 'Run forward and back.' },
      { name: 'attack', label: 'Attack', kind: 'held', keys: ['j'], mouse: 0, description: 'Swing the sword. With the bow, hold to draw and release to shoot.' },
      { name: 'takeItem', label: 'Take selected loot', kind: 'tap', mouse: 0, description: 'Take the chest item under the cursor while a chest is open.' },
      { name: 'interact', label: 'Open / close chest', kind: 'tap', keys: ['e', 'q'], mouse: 2, description: 'Open the chest you are aiming at, or close the one you are browsing.' },
      { name: 'jump', label: 'Jump', kind: 'held', keys: [' '] },
      { name: 'bandage', label: 'Bandage', kind: 'held', keys: ['r'], description: 'Hold still to heal with a bandage.' },
      { name: 'takeAll', label: 'Take all loot', kind: 'tap', keys: ['f'], description: 'Take everything from the open chest.' },
      ...Array.from({ length: 8 }, (_, index) => ({ name: `loot${index + 1}`, label: index === 0 ? 'Sword / loot 1' : index === 1 ? 'Bow / loot 2' : `Loot ${index + 1}`, kind: 'tap' as const, keys: [String(index + 1)],
        description: index === 0 ? 'Equip the sword, or take chest slot 1.' : index === 1 ? 'Equip the bow, or take chest slot 2.' : `Take chest slot ${index + 1}.`, ...(index < 2 ? {} : { touch: 'hidden' as const }) })),
    ],
    writeInput(input, buttons, frame) {
      // Consume taps every frame, even outside their UI context. Otherwise a
      // combat click can remain queued and take an item when a chest opens later.
      const lootTaps = Array.from({ length: 8 }, (_, index) => buttons.tapped(`loot${index + 1}`));
      const takeAll = buttons.tapped('takeAll'), takeItem = buttons.tapped('takeItem'), interact = buttons.tapped('interact');
      const me = frame.players.find(player => player.isLocal);
      if (!me || me.hp <= 0) return;
      input.moveX = buttons.value('moveX'); input.moveZ = -buttons.value('moveZ');
      input.jump = buttons.held('jump'); input.interact = interact;
      // Preserve the physical press across menus so closing a chest cannot
      // turn a held loot click into a fresh bow draw. Authority blocks attacks.
      input.attack = frame.mode !== 'just-chatting' && buttons.held('attack');
      if (me.state.chestId) {
        const width = frame.view.width || 960, height = frame.view.height || 600;
        input.menuX = Math.max(0, Math.min(1, buttons.pointer.locked
          ? me.state.chestCursorX + buttons.pointer.deltaX / width : (buttons.pointer.x + 1) / 2));
        input.menuY = Math.max(0, Math.min(1, buttons.pointer.locked
          ? me.state.chestCursorY + buttons.pointer.deltaY / height : (1 - buttons.pointer.y) / 2));
        for (let slot = 1; slot <= 8; slot++) if (lootTaps[slot - 1]) input.take = slot;
        if (takeAll) input.take = 9;
        if (takeItem) { const hit = lootPanelHit(input.menuX, input.menuY, width, height); input.take = hit.take; input.closeChest ||= hit.close; }
      } else {
        input.lookX = buttons.pointer.deltaX; input.lookY = buttons.pointer.deltaY;
        input.bandage = buttons.held('bandage');
        input.sword = lootTaps[0]; input.bow = lootTaps[1];
      }
    },
  },
  prediction: { fields: ['x', 'y', 'z', 'facing', 'aimPitch', 'velocityX', 'velocityY', 'velocityZ', 'grounded', 'chestCursorX', 'chestCursorY'], snapFields: ['x', 'y', 'z'], pointerLook: ARENA_POINTER_LOOK,
    step(state, input, dt, { tuning, opponents, opponent }) { movePlayer(state, input, dt * 1000, tuning, opponents ?? (opponent ? [opponent] : [])); } },
  smoothFields: ['x', 'y', 'z'],
  hudLines(frame) {
    const me = frame.players.find(player => player.isLocal), world = frame.world;
    if (frame.mode === 'just-chatting') return ['Just Chatting · Move around and talk with friends', 'Open text chat to send a message'];
    if (frame.mode === 'rpg') return [me?.hp === 0 ? 'Respawning…' : 'RPG · Explore together', 'Session progress resets when a new session starts'];
    if (frame.mode === 'duel') return ['Duel rules · Defeat your opponent', 'Find a weapon and strike first'];
    const participants = frame.players.filter(player => player.active !== false), alive = participants.filter(player => player.hp > 0).length;
    if (!world) return ['One life · Last survivor wins', 'Open chests in buildings and along wilderness trails.'];
    const state = me?.state;
    const lines = [`${alive} / ${participants.length} alive · ${me?.hp === 0 ? 'Eliminated — spectating' : state?.equipped === 2 ? `Bow · ${state.arrows} arrows` : state?.equipped === 1 ? 'Sword equipped' : 'Unarmed — find a chest'}`,
      world.zoneClosed ? 'Boundary closed — no safe ground' : world.elapsedMs < frame.tuning.zoneDelayMs
        ? `Safe zone shrinks in ${Math.ceil((frame.tuning.zoneDelayMs - world.elapsedMs) / 1000)}s`
        : `Safe zone: ${Math.ceil(world.zoneRadius)}m · Stay inside the ring`];
    if (me && state && me.hp > 0) {
      lines.push(`Armor ${armorCount(state)} / 4 · Bandages ${state.bandages}${state.bandageMs > 0 ? ` · Healing ${Math.ceil((frame.tuning.bandageDurationMs - state.bandageMs) / 1000)}s — stay still` : state.bandages > 0 ? ' · Bandage to heal' : ''}`);
      if (state.chestId) lines.push('Chest open · Take a slot, take everything, or close it');
      else {
        const chest = aimedChest(world, state, frame.tuning);
        const outside = Math.hypot(state.x, state.z) - world.zoneRadius;
        if (chest) lines.push(`${chest.loot ? 'Chest ahead · Open it for loot' : 'Empty chest'}`);
        else if (outside > 0 && !world.zoneClosed) lines.push(`Return ${bearing(-state.x, -state.z)} · ${Math.ceil(outside)}m to safety`);
        else if (state.equipped === 2) lines.push(state.bowDrawMs > 0
          ? `Bow drawn ${Math.round(Math.min(1, state.bowDrawMs / frame.tuning.bowDrawDurationMs) * 100)}% · Release to shoot`
          : 'Bow ready · Hold to draw, release to shoot');
        else lines.push(state.sword ? 'Sword ready · Swing at nearby enemies' : 'Unarmed · Find a chest');
      }
    }
    return lines;
  },
};

export default game;
