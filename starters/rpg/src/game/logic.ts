import type { DamageEntity, GameEvent, GameLogic, GamePlayer, MatchContext, PlayerBody, PlayerList } from '../shared/gameApi.ts';
import { GAME_MODE_IDS } from '../shared/gameModes.ts';
import { applyCharacterMovement, moveCharacters } from '../sandbox/characters.ts';
import { preparePhysics } from '../sandbox/physics.ts';
import { CAMPAIGN, createEnemies } from './campaign.ts';
import { CLASSES, classIndex, classInfo } from './classes.ts';
import { shapes, type Enemy, type FightInput, type PlayerState, type WorldState } from './shapes.ts';
import type { GameTuning } from './tuning.ts';
import { sharedTerrain } from './terrainWorld.ts';
import { rpgInspectionSetups } from './inspectionSetups.ts';

type Context = MatchContext<WorldState, PlayerState, GameTuning>;

function setupPlayer(ctx: Context, player: GamePlayer<PlayerState>): void {
  const allies = ctx.players.filter(other => other !== player && other.active !== false && other.hp > 0);
  // Late arrivals catch up to the living party without resetting the encounter.
  const leader = ctx.world.elapsedMs > 0 ? allies[0]?.state : undefined;
  // Portable modes can use 32 seats: keep every row inside the same map.
  const columns = ctx.players.length > 5 ? 6 : 5, startZ = ctx.players.length > 5 ? 11 : CAMPAIGN.start.z;
  const x = leader ? Math.max(-13, Math.min(13, leader.x + (player.index % 2 ? 1.5 : -1.5))) : ((player.index % columns) - (columns - 1) / 2) * 1.8;
  const z = leader ? Math.max(CAMPAIGN.north + 2, Math.min(CAMPAIGN.south - 2, leader.z + 1.5)) : startZ + Math.floor(player.index / columns) * 1.8;
  player.hp = player.maxHp = ctx.tuning.maxHp;
  Object.assign(player.state, { physicsId: player.index, x, y: 0, z, facing: Math.PI, velocityX: 0, velocityY: 0, velocityZ: 0, intentX: 0, intentZ: 0, grounded: 1,
    classId: classIndex(player.classId, player.index), downed: false, reviving: false, attackMs: 0, skillMs: 0, skillCooldownMs: 0, targetX: x, targetZ: z - 2,
    dashX: 0, dashZ: -1, kills: 0, cooldownMs: 0, attackId: 0, skillId: 0 });
  const terrain = sharedTerrain.read(ctx.tuning);
  if (terrain.contributionCount && !terrain.clearance(player.state, ctx.tuning.fighterRadius, ctx.tuning.fighterHeight))
    Object.assign(player.state, terrain.spawns({ count: 1, radius: ctx.tuning.fighterRadius, height: ctx.tuning.fighterHeight,
      maxSlopeDegrees: ctx.tuning.maxSlopeDegrees, preferred: [{ x, z }] })[0]);
}

function applyMovement(state: PlayerState, input: FightInput | undefined, tuning: GameTuning): void {
  const dash = state.classId === 4 && state.skillMs > 0;
  applyCharacterMovement(state, dash ? { moveX: state.dashX, moveZ: state.dashZ } : input,
    tuning.moveSpeed * classInfo(state.classId).speed * (dash ? 2.8 : 1));
  // Preserve desired velocity before collision response changes actual motion.
  state.intentX = state.velocityX; state.intentZ = state.velocityZ;
  if (!dash && input && Math.hypot(input.moveX, input.moveZ) > 0.001) state.facing = Math.atan2(input.moveX, input.moveZ);
}

export function movePlayer(state: PlayerState, input: FightInput | undefined, dt: number, tuning: GameTuning, opponents: readonly PlayerState[] = []): void {
  if (state.downed) { state.intentX = state.intentZ = 0; return; }
  applyMovement(state, input, tuning);
  moveCharacters([state, ...opponents.map(other => ({ ...other }))], dt, tuning, sharedTerrain.read(tuning).scene);
}

const distance = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

function hurtEnemy(enemy: Enemy, damage: number, player: GamePlayer<PlayerState>, world: WorldState, events: GameEvent[]): void {
  if (enemy.hp <= 0) return;
  enemy.hp = Math.max(0, enemy.hp - damage);
  enemy.hitMs = 170;
  if (enemy.hp === 0) {
    enemy.windupMs = enemy.strikeMs = 0;
    world.kills++;
    player.state.kills++;
    events.push({ type: enemy.kind ? 'boss-defeated' : 'enemy-defeated', player: player.index, enemy: enemy.id });
  }
}

/** Content owns NPC combat. Player health is exclusively validated by the core. */
function attackEnemies(player: GamePlayer<PlayerState>, world: WorldState, skill: boolean, events: GameEvent[]): void {
  const state = player.state, role = classInfo(state.classId);
  const available = world.enemies.filter(enemy => enemy.hp > 0 && enemy.group <= world.stage);
  const nearest = available.filter(enemy => distance(state, enemy) <= role.range).sort((a, b) => distance(state, a) - distance(state, b) || a.id - b.id)[0];
  const power = 1 + Math.floor(world.kills / 2) * 0.08;
  if (skill) {
    if (state.classId === 1 || state.classId === 2 || state.classId === 4) {
      const radius = state.classId === 1 ? 9 : state.classId === 2 ? 5.5 : 3;
      for (const enemy of available) if (distance(state, enemy) <= radius) hurtEnemy(enemy, (state.classId === 2 ? 48 : 34) * power, player, world, events);
    }
    return;
  }
  if (!nearest) return;
  state.facing = Math.atan2(nearest.x - state.x, nearest.z - state.z);
  state.targetX = nearest.x; state.targetZ = nearest.z;
  const targets = state.classId === 0 ? available.filter(enemy => distance(state, enemy) <= role.range)
    : state.classId === 2 ? available.filter(enemy => distance(nearest, enemy) <= 1.8) : [nearest];
  for (const enemy of targets) hurtEnemy(enemy, role.damage * power, player, world, events);
}

const game: GameLogic<WorldState, PlayerState, FightInput, GameTuning> = {
  mode: 'rpg', supportedModes: GAME_MODE_IDS, shapes,
  cooperative: { reviveInput: 'revive' },
  playerClasses: CLASSES.map(role => ({ id: role.id, label: role.name, description: `${role.role} · ${role.attack} + ${role.skill}` })),
  featureCapabilities: ['player.position.v1', 'player.vertical-motion.v1', 'player.appearance.v1', 'world.terrain.v1'],
  terrainWorld: sharedTerrain,
  inspectionSetups: rpgInspectionSetups,
  setupPlayer,
  setupMatch(ctx) {
    Object.assign(ctx.world, { elapsedMs: 0, stage: 0, kills: 0, partySize: ctx.players.length,
      enemies: ctx.mode === 'rpg' ? createEnemies(ctx.tuning, ctx.players.length) : [] });
    ctx.world.terrainRevision = sharedTerrain.read(ctx.tuning).revision;
    preparePhysics(sharedTerrain.read(ctx.tuning).scene);
    for (const player of ctx.players) setupPlayer(ctx, player);
  },
  step({ world, players, inputs, tuning, dtMs, elapsedMs, mode }) {
    const events: GameEvent[] = [], dt = dtMs / 1000;
    world.elapsedMs = elapsedMs;
    const living = players.filter(player => player.active !== false && player.hp > 0);
    for (const player of players) {
      const state = player.state;
      state.downed = player.hp <= 0;
      state.reviving = player.active !== false && !state.downed && mode === 'rpg' && !!inputs[player.index]?.revive;
      state.attackMs = Math.max(0, state.attackMs - dtMs);
      state.skillMs = Math.max(0, state.skillMs - dtMs);
      state.skillCooldownMs = Math.max(0, state.skillCooldownMs - dtMs);
      state.cooldownMs = Math.max(0, state.cooldownMs - dtMs);
      if (player.active === false || state.downed) { state.attackMs = state.skillMs = state.intentX = state.intentZ = 0; continue; }
      const input = inputs[player.index];
      applyMovement(state, input, tuning);
      if (mode === 'just-chatting' || input?.revive) continue;
      if (input?.skill && state.skillCooldownMs <= 0) {
        state.skillId++;
        state.skillMs = state.classId === 0 ? 2500 : state.classId === 4 ? 280 : 600;
        const dashLength = Math.hypot(input.moveX, input.moveZ);
        state.dashX = dashLength > 0.001 ? input.moveX / dashLength : Math.sin(state.facing);
        state.dashZ = dashLength > 0.001 ? input.moveZ / dashLength : Math.cos(state.facing);
        state.skillCooldownMs = tuning.skillCooldownMs;
        if (mode === 'rpg') attackEnemies(player, world, true, events);
        events.push({ type: 'class-skill', player: player.index, classId: state.classId });
      }
      if (input?.attack && state.cooldownMs <= 0) {
        state.attackId++;
        state.attackMs = 180;
        state.cooldownMs = classInfo(state.classId).cooldown;
        state.targetX = state.x + Math.sin(state.facing) * classInfo(state.classId).range;
        state.targetZ = state.z + Math.cos(state.facing) * classInfo(state.classId).range;
        if (mode === 'rpg') attackEnemies(player, world, false, events);
        events.push({ type: 'attack', player: player.index });
      }
    }
    moveCharacters(living.map(player => player.state), dt, tuning, sharedTerrain.read(tuning).scene);
    if (mode !== 'rpg') return events;
    if (world.stage === 0 && living.some(player => player.state.z < 7)) world.stage = 1;
    while (world.stage > 0 && world.stage < 4 && !world.enemies.some(enemy => enemy.group === world.stage && enemy.hp > 0)) {
      world.stage++;
      events.push({ type: 'checkpoint-cleared', checkpoint: world.stage - 1 });
    }
    for (const enemy of world.enemies) {
      enemy.hitMs = Math.max(0, enemy.hitMs - dtMs);
      if (enemy.hp <= 0 || enemy.group > world.stage) continue;
      const target = living.reduce<GamePlayer<PlayerState> | undefined>((nearest, player) => !nearest || distance(enemy, player.state) < distance(enemy, nearest.state) ? player : nearest, undefined);
      if (!target) continue;
      enemy.strikeMs = Math.max(0, enemy.strikeMs - dtMs);
      enemy.cooldownMs = Math.max(0, enemy.cooldownMs - dtMs);
      if (enemy.windupMs > 0) {
        enemy.windupMs = Math.max(0, enemy.windupMs - dtMs);
        if (enemy.windupMs === 0) { enemy.attackId++; enemy.strikeMs = 160; enemy.cooldownMs = enemy.kind ? 1900 : 1100; }
        continue;
      }
      const range = enemy.kind ? 3.5 : 1.7, gap = distance(enemy, target.state);
      if (gap > (enemy.kind ? 18 : 13)) continue;
      enemy.facing = Math.atan2(target.state.x - enemy.x, target.state.z - enemy.z);
      if (gap > range * 0.85 && enemy.strikeMs <= 0) {
        const travel = Math.min(gap - range * 0.8, tuning.enemySpeed * (enemy.kind ? 0.7 : 1) * dt);
        const next = { x: enemy.x + Math.sin(enemy.facing) * travel, y: 0, z: enemy.z + Math.cos(enemy.facing) * travel };
        if (sharedTerrain.read(tuning).clearance(next, enemy.kind ? .9 : .4, enemy.kind ? 3 : 1.8)) { enemy.x = next.x; enemy.z = next.z; }
      } else if (enemy.cooldownMs <= 0) {
        enemy.windupMs = enemy.kind ? 1100 : 650;
        enemy.aimX = enemy.x; enemy.aimZ = enemy.z;
      }
    }
    return events;
  },
  objectiveComplete({ world, players }) {
    return world.stage === 4 && world.enemies.length > 0 && world.enemies.every(enemy => enemy.hp <= 0)
      && players.filter(player => player.active !== false).every(player => distance(player.state, CAMPAIGN.destination) <= CAMPAIGN.destination.radius);
  },
  entities({ world, players, tuning, mode }) {
    const bodies = players.map(player => ({ at: { x: player.state.x, y: player.state.y, z: player.state.z }, radius: tuning.fighterRadius, height: tuning.fighterHeight,
      guard: player.state.skillMs > 0 && (player.state.classId === 0 || player.state.classId === 4) ? 0.2 : classInfo(player.state.classId).guard })) as PlayerList<PlayerBody>;
    const damage: DamageEntity[] = [];
    if (mode === 'rpg') {
      for (const enemy of world.enemies) if (enemy.hp > 0 && enemy.strikeMs > 0) damage.push({
        id: `enemy-${enemy.id}-${enemy.attackId}`, label: enemy.kind ? 'gatekeeper-slam' : 'enemy-swipe', owner: null, kind: 'strike',
        damage: enemy.kind ? tuning.bossDamage : tuning.enemyDamage, shape: 'sphere', at: { x: enemy.aimX, y: 0.8, z: enemy.aimZ }, radius: enemy.kind ? 3.5 : 1.7,
      });
    } else if (mode !== 'just-chatting') {
      for (const player of players) {
        if (player.hp <= 0 || player.active === false || player.state.attackMs <= 0) continue;
        const state = player.state, role = classInfo(state.classId);
        const other = players.filter(target => target.index !== player.index && target.active !== false && target.hp > 0 && distance(state, target.state) <= role.range)
          .sort((a, b) => distance(state, a.state) - distance(state, b.state) || a.index - b.index)[0];
        if (other) damage.push({ id: `player-${player.index}-${state.attackId}`, label: role.attack.toLowerCase(), owner: player.index, target: other.index,
          kind: 'strike', damage: role.damage, shape: 'sphere', at: { x: other.state.x, y: other.state.y + 0.8, z: other.state.z }, radius: 0.2 });
      }
    }
    const healing = mode === 'rpg' ? players.filter(player => player.active !== false && player.hp > 0 && player.state.classId === 3 && player.state.skillMs > 0)
      .map(player => ({ id: `healing-${player.index}-${player.state.skillId}`, label: 'healing-light', owner: player.index, amount: tuning.healAmount,
        at: { x: player.state.x, y: player.state.y + 0.8, z: player.state.z }, radius: tuning.healRadius })) : [];
    return { bodies, damage, healing };
  },
  describePlayer: player => `${classInfo(player.state.classId).name} · ${player.hp <= 0 ? 'DOWNED' : 'Adventuring'}`,
  controls: {
    inspection: { forward: { moveZ: -1 }, right: { moveX: 1 }, attack: { attack: true } },
    bindings: [
      { name: 'moveX', label: 'Move sideways', kind: 'axis', role: 'move-x', keys: ['a', 'd'], description: 'Strafe left and right.' },
      { name: 'moveZ', label: 'Move forward', kind: 'axis', role: 'move-y', keys: ['s', 'w'], description: 'Walk forward and back.' },
      { name: 'attack', label: 'Attack', kind: 'held', keys: [' ', 'j'], mouse: 0, description: 'Your class’s basic attack toward the camera direction.' },
      { name: 'skill', label: 'Class skill', kind: 'tap', keys: ['q', 'k'], mouse: 2, description: 'Use your class skill; it has a cooldown.' },
      { name: 'revive', label: 'Revive ally', kind: 'held', keys: ['e'], description: 'Hold near a downed teammate for three seconds to revive them.' },
    ],
    writeInput(input, buttons, frame) {
      const me = frame.players.find(player => player.isLocal);
      if (!me || me.hp <= 0) return;
      input.moveX = buttons.value('moveX'); input.moveZ = -buttons.value('moveZ');
      input.attack = frame.mode !== 'just-chatting' && buttons.held('attack');
      input.skill = frame.mode !== 'just-chatting' && buttons.tapped('skill');
      input.revive = frame.mode === 'rpg' && buttons.held('revive');
    },
  },
  prediction: { fields: ['x', 'y', 'z', 'facing', 'velocityX', 'velocityY', 'velocityZ', 'grounded', 'intentX', 'intentZ'], snapFields: ['x', 'y', 'z'],
    step(state, input, dt, { tuning, opponents, opponent }) { movePlayer(state, input, dt, tuning, opponents ?? (opponent ? [opponent] : [])); } },
  smoothFields: ['x', 'y', 'z'],
  hudLines(frame) {
    const me = frame.players.find(player => player.isLocal), world = frame.world;
    if (frame.mode !== 'rpg') return [frame.mode === 'just-chatting' ? 'A quiet trail to explore together' : 'The trail · Shared classes and movement'];
    const objective = !world || world.stage === 0 ? 'Leave camp and follow the lanterns north'
      : world.stage === 4 ? 'Gather everyone at the glowing gate to finish'
      : world.stage === 3 ? 'Defeat the gatekeeper · Dodge the red slam circle'
      : `Clear ${world.stage === 1 ? 'Whispering trail' : 'Old crossing'} · ${world.enemies.filter(enemy => enemy.group === world.stage && enemy.hp > 0).length} enemies remain`;
    const role = classInfo(me?.state.classId ?? 0);
    return [objective, me?.hp === 0 ? 'DOWNED · A teammate must hold Revive nearby' : `${role.name} · ${role.skill}${me?.state.skillCooldownMs ? ` (${Math.ceil(me.state.skillCooldownMs / 1000)}s)` : ' ready'}`,
      'Stay together · Everyone must survive to complete the campaign'];
  },
};

export default game;
