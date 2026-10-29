// Generated with createModStarter(player-appearance, actor=humanoid); editable source.
import {BoxGeometry, Group, Mesh, MeshStandardMaterial} from 'three';
import {ActorAnimationController, type ActorAnimationOptions} from '../sandbox/actorAnimation.ts';
import {ActorHeading, HumanoidLocomotionDriver} from '../sandbox/actorLocomotion.ts';
import {createHumanoidSkeleton} from '../sandbox/animationView.ts';
import {defineAnimationClip, quaternionFromEuler, type ActorPresentationSignals, type AnimationPose} from '../sandbox/animation.ts';

const rotate = (x = 0, y = 0, z = 0) => ({rotation: quaternionFromEuler({x, y, z})});
// Editable rest-relative actions. Reuse these names or add your own semantic clips.
export const clips = {
  attack: defineAnimationClip({durationMs: 550, sample: ({phase}) => ({
    'right-shoulder': rotate(-Math.sin(phase * Math.PI) * 1.6), 'right-elbow': rotate(-.3),
  })}),
  skill: defineAnimationClip({durationMs: 700, sample: ({phase}) => ({
    'left-shoulder': rotate(-Math.sin(phase * Math.PI) * 1.7), 'right-shoulder': rotate(-Math.sin(phase * Math.PI) * 1.7),
  })}),
  posture: defineAnimationClip({durationMs: 1000, loop: true, sample: ({signals}): AnimationPose => {
    if (signals?.posture === 'sitting') return {
      hips: {position: {x: 0, y: -.82, z: 0}},
      'left-hip': rotate(-Math.PI / 2), 'right-hip': rotate(-Math.PI / 2),
      'left-knee': rotate(Math.PI / 2), 'right-knee': rotate(Math.PI / 2),
      'left-shoulder': rotate(-.45), 'right-shoulder': rotate(-.45),
      'spine-1': rotate(0, Number(signals.parameters?.torsoLookYaw ?? 0)),
    };
    if (signals?.posture === 'downed' || signals?.posture === 'dead') return {
      hips: {position: {x: 0, y: -.74, z: 0}, ...rotate(0, 0, Math.PI / 2)},
    };
    if (signals?.posture === 'reviving') return {
      hips: {position: {x: 0, y: -.34, z: 0}}, 'left-hip': rotate(-1.1), 'right-hip': rotate(-.6),
      'left-knee': rotate(1.6), 'right-knee': rotate(1.8), 'spine-1': rotate(.4),
    };
    if (signals?.posture === 'blocking') return {'left-shoulder': rotate(-1), 'left-elbow': rotate(-1.2)};
    return {};
  }}),
};

// This is the editable visual design, separate from rig and locomotion. Attach custom
// meshes/skinned geometry to any of the 25 joints; keep +Y up, +Z forward, feet at y=0.
export function buildBody(actor: ReturnType<typeof createHumanoidSkeleton>, color: string) {
  const geometry = new BoxGeometry(1, 1, 1);
  const shell = new MeshStandardMaterial({color, roughness: .75});
  const dark = new MeshStandardMaterial({color: '#303846', roughness: .85});
  function box(joint: string, size: [number, number, number], at: [number, number, number], material = shell) {
    const mesh = new Mesh(geometry, material); mesh.scale.set(...size); mesh.position.set(...at);
    mesh.castShadow = mesh.receiveShadow = true; actor.joints[joint].add(mesh);
  }
  box('hips', [.4, .2, .28], [0, 0, 0], dark);
  for (const joint of ['spine-1', 'spine-2', 'spine-3', 'spine-4', 'chest']) box(joint, [.46, .12, .28], [0, .035, 0]);
  box('head', [.34, .32, .32], [0, .08, 0]);
  box('head', [.24, .07, .025], [0, .09, .17], dark);
  for (const side of ['left', 'right']) {
    box(side + '-shoulder', [.16, .3, .18], [0, -.15, 0]);
    box(side + '-elbow', [.14, .28, .16], [0, -.14, 0], dark);
    box(side + '-hand', [.16, .15, .16], [0, -.04, 0]);
    box(side + '-hip', [.19, .39, .21], [0, -.195, 0], dark);
    box(side + '-knee', [.17, .38, .19], [0, -.19, 0]);
    box(side + '-foot', [.19, .12, .27], [0, -.07, .055], dark);
    box(side + '-toe', [.19, .08, .12], [0, -.04, .04], dark);
  }
  return () => { geometry.dispose(); shell.dispose(); dark.dispose(); };
}

type ActorOptions = Pick<ActorAnimationOptions, 'clips' | 'locomotion' | 'layers' | 'adaptPose' | 'afterApply' | 'onReset' | 'equipmentMotion' | 'equipmentLoads'> & {
  buildBody?: typeof buildBody;
  /** Visual turn response in 1/seconds; 20 matches RPG, 0 opts into instant turns. */
  turnResponse?: number;
};
/** One actor/controller per player, one shared immutable motion database. */
export function createActor(color: string, options: ActorOptions = {}) {
  const actor = createHumanoidSkeleton(), root = new Group(), presentation = new Group();
  presentation.name = 'actor-presentation'; root.add(presentation); presentation.add(actor.root);
  const heading = new ActorHeading({response: options.turnResponse});
  let direction: ReturnType<ActorHeading['sample']> | undefined;
  const disposeBody = (options.buildBody ?? buildBody)(actor, color);
  const locomotion = new HumanoidLocomotionDriver(), availableClips = {...clips, ...options.clips};
  const stationary = (posture?: string) => ['sitting', 'downed', 'dead', 'reviving'].includes(posture ?? '');
  const animation = new ActorAnimationController({...options, rig: actor.animationRig, clips: availableClips,
    locomotion: options.locomotion ?? {
      reset: () => locomotion.reset(),
      sample: context => stationary(context.signals.posture)
        ? {pose: {}, diagnostics: {source: 'authored:posture', state: context.signals.posture}} : locomotion.sample(context),
    },
    layers: context => {
      const {signals} = context;
      const layers: {clip: string; timeMs?: number}[] = [{clip: 'posture'}];
      // Continuous observations are a fallback only; authoritative action IDs take priority.
      if (signals.parameters?.attacking && !signals.actions?.some(action => action.clip === 'attack')) {
        const duration = Number(signals.parameters.attackDurationMs ?? 0), remaining = Number(signals.parameters.attackRemainingMs ?? 0);
        layers.push({clip: 'attack', timeMs: duration > 0
          ? Math.max(0, Math.min(1, 1 - remaining / duration)) * availableClips.attack.durationMs : signals.timeMs % availableClips.attack.durationMs});
      }
      return [...layers, ...options.layers?.(context) ?? []];
    },
  });
  let last: ReturnType<ActorAnimationController['sample']> | undefined, previousPosture: string | undefined;
  let unsupported: string[] = [], disposed = false;
  return {root, animation, joints: actor.joints,
    update(signals: Readonly<ActorPresentationSignals>) {
      if (disposed) return;
      root.userData.inspectionActorId = signals.id;
      const changed = previousPosture !== undefined && previousPosture !== signals.posture;
      previousPosture = signals.posture;
      // The host positions root and applies raw gameplay facing. Counter-rotate
      // only the body; matching and foot support use that same visual heading.
      direction = heading.sample(signals, changed);
      presentation.rotation.y = direction.offsetYaw;
      unsupported = [...new Set((signals.actions ?? []).filter(action => !Object.hasOwn(availableClips, action.clip)).map(action => action.clip))];
      last = animation.sample({signals: {...signals, facing: direction.forward}, reset: changed,
        actions: signals.actions?.filter(action => Object.hasOwn(availableClips, action.clip)) ?? []});
    },
    inspection() { return {rigId: 'humanoid-v1', joints: Object.keys(actor.joints).length, posture: previousPosture ?? 'standing',
      heading: direction ? {yaw: direction.yaw, targetYaw: direction.targetYaw, offsetYaw: direction.offsetYaw} : null,
      locomotion: last?.diagnostics.locomotion ?? null, rig: last?.diagnostics.rig ?? null,
      equipmentMotion: last?.diagnostics.equipmentMotion ?? null,
      actions: last?.diagnostics.animation.actions ?? [], warnings: [...last?.diagnostics.warnings ?? [],
        ...unsupported.map(name => 'No authored clip for action ' + name)]}; },
    dispose() { if (disposed) return; disposed = true; animation.reset(); root.removeFromParent(); actor.skeleton.dispose(); disposeBody(); },
  };
}
