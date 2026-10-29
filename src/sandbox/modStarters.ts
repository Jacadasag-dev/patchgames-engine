import type {FeatureManifest} from '../shared/featureManifest.ts';
import {sharedCreatureCatalog} from './creatureAnimationLibrary.ts';
import {creatureActorSource, humanoidActorSource} from './modActorSources.ts';

/** Authoring-time source templates, not a game-runtime import or evaluated player code. */
export type ModStarterTemplate = 'gravity' | 'player-appearance' | 'creatures';
export interface ModStarterOptions {
  /** Defaults to humanoid for player appearances and creature for companions. */
  actor?: 'humanoid' | 'creature';
  /** Exact compatible bank, discoverable through sharedCreatureCatalog. */
  bankId?: string;
}
export interface ModStarter {
  template: ModStarterTemplate;
  feature: FeatureManifest;
  /** Complete files relative to src/game/features/<feature.id>/; feature.json is supplied by upsert_feature. */
  files: Record<string, string>;
  requiredCapabilities: string[];
  guidance: string[];
}

const appearanceLogic = `import {defineFeature} from '../../../sandbox/features.ts';
export const config = {
  color: {type: 'string', default: '#8a94a6', values: ['#8a94a6', '#7c98ad', '#b09d83']},
  scale: {type: 'number', default: 1, min: 0.35, max: 2},
} as const;
export default defineFeature({apiVersion: 1, config, requires: ['player.appearance.v1'],
  playerModels: [{id: 'default', label: MODEL_LABEL, description: 'A custom character model.'}],
});
`;

const appearanceView = `import type {CreateFeatureView} from '../../../shared/gameFeatures.ts';
import type {config} from './logic.ts';
import {createActor} from './model.ts';

const createView: CreateFeatureView<{}, {}, typeof config> = ({host, config, id}) => {
  const actors = new Map<string, ReturnType<typeof createActor>>();
  const modelId = id('default');
  function remove(playerId: string) {
    host.setPlayerAppearance(playerId, null, 'default'); actors.get(playerId)?.dispose(); actors.delete(playerId);
  }
  return {
    update(frame) {
      // Downed actors still wear their selected model while waiting for a revive.
      const selected = (player: typeof frame.players[number]) => player.active !== false
        && (player.hp > 0 || player.presentation?.posture === 'downed') && (!player.modelId || player.modelId === modelId);
      const visible = new Set(frame.players.filter(selected).map(player => player.id));
      for (const id of actors.keys()) if (!visible.has(id)) remove(id);
      for (const player of frame.players) {
        if (!selected(player)) continue;
        let actor = actors.get(player.id);
        if (!actor) {
          actor = createActor(config.color); actor.root.scale.setScalar(config.scale);
          actors.set(player.id, actor); host.setPlayerAppearance(player.id, actor.root, 'default');
        }
        // The shared host owns the player's position and yaw; do not copy private season fields.
        actor.update(player.presentation ?? {id: player.id, timeMs: frame.now});
      }
    },
    inspection() { return {actorCount: actors.size, actors: [...actors].slice(0, 4).map(([id, actor]) => ({id, ...actor.inspection()}))}; },
    dispose() { for (const id of [...actors.keys()]) remove(id); },
  };
};
export default createView;
`;

const creaturesLogic = `import {defineFeature} from '../../../sandbox/features.ts';
export const config = {
  count: {type: 'number', default: 4, min: 1, max: 12, integer: true},
  speed: {type: 'number', default: 1.8, min: 0.1, max: 6},
  radius: {type: 'number', default: 1.2, min: 0.5, max: 4},
  contactDamage: {type: 'number', default: 0, min: 0, max: 20},
  color: {type: 'string', default: '#8a94a6', values: ['#8a94a6', '#7c98ad', '#b09d83']},
} as const;
export const shapes = {world: {creatures: [{x: 'number', y: 'number', z: 'number', facing: 'number', phase: 'number', active: 'boolean'}]}} as const;
export default defineFeature({apiVersion: 1, config, shapes, requires: ['player.position.v1'],
  hooks: {
    setup(ctx) {
      ctx.world.creatures = Array.from({length: ctx.config.count}, (_, index) => {
        const player = ctx.game.players[index % ctx.game.players.length];
        const phase = ctx.random('creature-' + index) * Math.PI * 2;
        const x = Number(player.state.x) + Math.sin(phase) * ctx.config.radius;
        const z = Number(player.state.z) + Math.cos(phase) * ctx.config.radius, support = ctx.terrain?.sample(x, z);
        return {x, y: support?.inside ? support.height : Number(player.state.y), z, facing: phase, phase, active: true};
      });
    },
    step(ctx) {
      const living = ctx.game.players.filter(player => player.hp > 0);
      ctx.world.creatures.forEach((creature, index) => {
        creature.active = living.length > 0;
        if (!creature.active) return;
        const target = living[index % living.length];
        const angle = creature.phase + ctx.elapsedMs / 1000 * ctx.config.speed / ctx.config.radius;
        const dx = Number(target.state.x) + Math.sin(angle) * ctx.config.radius - creature.x;
        const dz = Number(target.state.z) + Math.cos(angle) * ctx.config.radius - creature.z;
        const distance = Math.sqrt(dx * dx + dz * dz), travel = Math.min(distance, ctx.config.speed * ctx.dtMs / 1000);
        if (distance > 0.0001) {
          creature.x += dx / distance * travel; creature.z += dz / distance * travel;
          creature.facing = Math.atan2(dx, dz);
        }
        // Use the same accepted heightfield as physics and rendering. This is ground
        // support, not navigation around obstacles or support on arbitrary bridges.
        const support = ctx.terrain?.sample(creature.x, creature.z);
        creature.y = support?.inside ? support.height : Number(target.state.y);
      });
    },
  },
  entities(ctx) {
    return {damage: ctx.config.contactDamage === 0 ? [] : ctx.world.creatures.flatMap((creature, index) => creature.active ? [{
      id: 'creature-' + index, label: 'creature contact', owner: null, kind: 'zone' as const, shape: 'sphere' as const,
      at: {x: creature.x, y: creature.y + 0.25, z: creature.z}, radius: 0.35, damage: ctx.config.contactDamage,
    }] : [])};
  },
});
`;

const creaturesView = `import type {CreateFeatureView} from '../../../shared/gameFeatures.ts';
import type {config, shapes} from './logic.ts';
import {createActor} from './model.ts';
const createView: CreateFeatureView<typeof shapes.world, {}, typeof config> = ({host, config}) => {
  const actors: ReturnType<typeof createActor>[] = [];
  const previous = new Map<number, {x: number; y: number; z: number; at: number}>();
  function remove() {
    const index = actors.length - 1, actor = actors.pop();
    previous.delete(index);
    if (actor) { host.setInspectionTarget?.('creature-' + index, null); host.remove(actor.root); actor.dispose(); }
  }
  return {
    update(frame) {
      const creatures = frame.world?.creatures ?? [];
      while (actors.length > creatures.length) remove();
      creatures.forEach((creature, index) => {
        let actor = actors[index];
        if (!actor) {
          actor = createActor(config.color); actor.root.scale.setScalar(0.65); actors.push(actor); host.add(actor.root);
          host.setInspectionTarget?.('creature-' + index, actor.root, 'Companion ' + (index + 1));
        }
        actor.root.visible = creature.active;
        actor.root.position.set(creature.x, creature.y, creature.z); actor.root.rotation.y = creature.facing;
        const old = previous.get(index), seconds = old ? (frame.now - old.at) / 1000 : 0;
        const velocity = old && seconds > 0 && seconds <= 1 ? {x: (creature.x - old.x) / seconds,
          y: (creature.y - old.y) / seconds, z: (creature.z - old.z) / seconds} : {x: 0, y: 0, z: 0};
        actor.update({id: 'creature-' + index, timeMs: frame.now, position: creature, velocity,
          facing: {x: Math.sin(creature.facing), y: 0, z: Math.cos(creature.facing)},
          supports: frame.terrain?.actorSupports({ground: {x: creature.x, z: creature.z}}, frame.now)});
        previous.set(index, {...creature, at: frame.now});
      });
    },
    inspection() { return {actorCount: actors.length, actors: actors.slice(0, 4).map((actor, index) => ({id: 'creature-' + index, ...actor.inspection()}))}; },
    dispose() { while (actors.length) remove(); },
  };
};
export default createView;
`;

/** Returns complete editable feature sources. It never imports or evaluates authored game code. */
export function createModStarter(template: ModStarterTemplate, id: string, name?: string, options: ModStarterOptions = {}): ModStarter {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error('Use a valid stable feature ID.');
  const names = {gravity: 'Low gravity', 'player-appearance': 'Player appearance', creatures: 'Creatures'};
  if (!Object.hasOwn(names, template)) throw new Error('Unknown mod starter.');
  const actor = options.actor ?? (template === 'player-appearance' ? 'humanoid' : 'creature');
  if (actor !== 'humanoid' && actor !== 'creature') throw new Error('Unknown actor starter.');
  if (template === 'gravity' && (options.actor || options.bankId)) throw new Error('Gravity has no actor model.');
  if (actor === 'humanoid' && options.bankId) throw new Error('bankId requires a creature actor.');
  const bankId = options.bankId ?? 'creature-fox-02';
  if (actor === 'creature' && template !== 'gravity' && !sharedCreatureCatalog().some(entry => entry.id === bankId))
    throw new Error('Unknown creature bank. Discover exact IDs with sharedCreatureCatalog.');
  const title = name?.trim() ?? names[template];
  if (!title || title.length > 100 || /[\p{Cc}\p{Cf}]/u.test(title)) throw new Error('Use a name of 1–100 visible characters.');
  const requiredCapabilities = template === 'gravity' ? ['player.vertical-motion.v1']
    : template === 'player-appearance' ? ['player.appearance.v1'] : ['player.position.v1'];
  const files: Record<string, string> = template === 'gravity' ? {'logic.ts': `import {defineFeature} from '../../../sandbox/features.ts';
export default defineFeature({apiVersion: 1,
  requires: ['player.vertical-motion.v1'],
  config: {factor: {type: 'number', default: 0.35, min: 0.05, max: 4}},
  modifiers: [{target: 'tuning.gravity', operation: 'multiply', value: ({config}) => config.factor}],
});
`} : {'logic.ts': template === 'player-appearance' ? appearanceLogic.replace('MODEL_LABEL', JSON.stringify(title)) : creaturesLogic,
    'view.ts': template === 'player-appearance' ? appearanceView : creaturesView,
    'model.ts': actor === 'humanoid' ? humanoidActorSource : creatureActorSource(bankId)};
  const config: NonNullable<FeatureManifest['config']> = template === 'gravity' ? {factor: 0.35} : template === 'player-appearance'
    ? {color: '#8a94a6', scale: 1} : {count: 4, speed: 1.8, radius: 1.2, contactDamage: 0, color: '#8a94a6'};
  return {template, feature: {api: 1, id, name: title, requires: [], config}, files, requiredCapabilities,
    guidance: [
      'Keep this feature ID for edits. Independent new mods need distinct IDs. Save the manifest and every returned file together with upsert_feature, or write the complete feature directory.',
      'The builder discovers native features automatically. Package dependencies use manifest.requires feature IDs; logic.requires lists shared gameplay capabilities. Do not import or register against season implementation files.',
      'These sources target shared contracts in Duel, Arena, RPG and Just Chatting. Build and exercise the unchanged package on the actual target bases, including solo sessions, 5 RPG players and 32 Arena/social slots, before claiming compatibility. Older bases can require a foundation update.',
      ...(template === 'creatures' ? ['Companions register stable local inspection targets automatically. Use a returned ID from capture.focusDiagnostics.data.targets as focus.target to inspect one creature with automatic framing/following. Registrations are namespaced by the feature host and released with removed creatures; older bases can omit this optional capability.'] : []),
      ...(template === 'gravity' ? [] : [actor === 'humanoid'
        ? 'model.ts is a complete 25-joint humanoid with shared motion-matched locomotion, editable attack/skill clips and seated/downed/revive/blocking poses. Edit buildBody for the visual design and clips for custom actions. createActor accepts custom buildBody, clips, locomotion, layers, adaptPose and afterApply hooks. Grounded library coverage is diagnosed honestly; author airborne motion for a jumping design.'
        : 'model.ts binds a real CC0 body to its exact creature bank and supplies motion matching, semantic action clips, lifecycle and diagnostics. Change bankId with another catalog ID or replace buildBody with compatible custom geometry. In-place travel references are authored, not measured; sparse banks lack recorded turns/starts/stops and contact labels. Tune motion references to movement. Unsupported actions/postures appear in inspection warnings.']),
      ...(template === 'gravity' ? [] : ['Player appearances consume shared presentation signals; companions derive travel from frame positions. The host owns authoritative roots, physics and hit bodies. Preserve stable action IDs and simulation timestamps. afterApply is the extension point for support/foot-placement constraints. Every actor is disposed on removal; each feature exposes bounded animation evidence through inspection(). Inspect movement, actions and lifecycle in the real target bases.']),
      template === 'gravity' ? 'factor multiplies existing downward acceleration; it does not create a second physics solver or change the input bindings. Test while a player is airborne.'
        : template === 'player-appearance' ? 'playerModels registers this mod in the character switcher. Keep local IDs stable; id(localId) is the catalog ID. Selected downed characters retain their model through revival; departure, elimination and model changes release resources. Geometry, style and supported actions are yours to edit.'
          : 'The default companions use a minimal follow behavior. Edit logic.ts for requested behavior. contactDamage defaults to zero; positive values create core-resolved contact damage per second. Independent health, terrain navigation and inventory are extension points.',
    ]};
}
