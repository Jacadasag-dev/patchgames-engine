import * as THREE from 'three';
import { ActorAnimationController } from '../sandbox/actorAnimation.ts';
import { HumanoidLocomotionDriver } from '../sandbox/actorLocomotion.ts';
import { createHumanoidSkeleton, ThreeAnimationRig } from '../sandbox/animationView.ts';
import { defineAnimationClip, quaternionFromEuler, type ActorPresentationSignals, type AnimationPose } from '../sandbox/animation.ts';
import type { ViewFrame } from '../shared/gameApi.ts';
import { MODEL_PALETTES } from './models.ts';
import { SEATING, seats } from './layout.ts';
import type { PlayerState, WorldState } from './shapes.ts';
import type { GameTuning } from './tuning.ts';
import { sharedTerrain } from './terrainWorld.ts';

const SCALE = .85;
const rotate = (x = 0, y = 0, z = 0) => ({ rotation: quaternionFromEuler({ x, y, z }) });
const emoteNames = ['wave', 'dance', 'cheer', 'laugh', 'clap', 'pose'];
export const loungeClips = {
  posture: defineAnimationClip({ durationMs: 1000, loop: true, sample: ({ signals }): AnimationPose => {
    if (signals?.posture === 'sitting') return {
      hips: { position: { x: 0, y: SEATING.hipHeight / SCALE - .95, z: 0 } },
      'left-hip': rotate(-Math.PI / 2), 'right-hip': rotate(-Math.PI / 2),
      'left-knee': rotate(Math.PI / 2), 'right-knee': rotate(Math.PI / 2),
      'left-shoulder': rotate(-.5), 'right-shoulder': rotate(-.5),
      'spine-1': rotate(0, Math.max(-1.15, Math.min(1.15, Number(signals.parameters?.torsoLookYaw ?? 0)))),
      head: rotate(-Number(signals.parameters?.aimPitch ?? 0) * .25),
    };
    if (signals?.grounded === false) return {
      'left-hip': rotate(-.18), 'right-hip': rotate(.18), 'left-knee': rotate(.35), 'right-knee': rotate(.2),
      'left-shoulder': rotate(0, 0, -.22), 'right-shoulder': rotate(0, 0, .22),
    };
    return { head: rotate(-Number(signals?.parameters?.aimPitch ?? 0) * .25) };
  } }),
  wave: defineAnimationClip({ durationMs: 1100, loop: true, sample: ({ phase }) => ({
    'right-shoulder': rotate(-.3, 0, 2.45), 'right-elbow': rotate(-.5, 0, -.25 + Math.sin(phase * Math.PI * 2) * .35),
    'right-hand': rotate(0, Math.sin(phase * Math.PI * 2) * .25),
  }) }),
  dance: defineAnimationClip({ durationMs: 1000, loop: true, sample: ({ phase, signals }): AnimationPose => {
    const sway = Math.sin(phase * Math.PI * 2), seated = signals?.posture === 'sitting';
    return { 'spine-1': rotate(0, sway * .18, sway * .1),
      'left-shoulder': rotate(-.5 + sway * .4, 0, -.55), 'right-shoulder': rotate(-.5 - sway * .4, 0, .55),
      'left-elbow': rotate(-.7), 'right-elbow': rotate(-.7),
      ...(!seated ? { 'left-hip': rotate(sway * .13), 'right-hip': rotate(-sway * .13),
        'left-knee': rotate(Math.max(0, sway) * .2), 'right-knee': rotate(Math.max(0, -sway) * .2) } : {}),
    };
  } }),
  cheer: defineAnimationClip({ durationMs: 1000, loop: true, sample: ({ phase }) => ({
    'left-shoulder': rotate(-2.8 + Math.sin(phase * Math.PI * 2) * .15, 0, -.2),
    'right-shoulder': rotate(-2.8 + Math.sin(phase * Math.PI * 2) * .15, 0, .2),
    'left-elbow': rotate(-.25), 'right-elbow': rotate(-.25), head: rotate(-.15),
  }) }),
  laugh: defineAnimationClip({ durationMs: 700, loop: true, sample: ({ phase }) => ({
    'spine-2': rotate(.12 + Math.sin(phase * Math.PI * 4) * .035), head: rotate(-.13),
    'left-shoulder': rotate(-.65, 0, -.25), 'right-shoulder': rotate(-.55, 0, .25),
    'left-elbow': rotate(-1.1), 'right-elbow': rotate(-1.1),
  }) }),
  clap: defineAnimationClip({ durationMs: 650, loop: true, sample: ({ phase }) => ({
    'left-shoulder': rotate(-1.15, 0, -.35 + Math.sin(phase * Math.PI * 2) * .18),
    'right-shoulder': rotate(-1.15, 0, .35 - Math.sin(phase * Math.PI * 2) * .18),
    'left-elbow': rotate(-.7, .8), 'right-elbow': rotate(-.7, -.8),
  }) }),
  pose: defineAnimationClip({ durationMs: 1500, loop: true, sample: () => ({
    'spine-2': rotate(0, .22), head: rotate(0, -.22, -.12),
    'left-shoulder': rotate(0, 0, -.5), 'left-elbow': rotate(-1.2, 0, .35),
    'right-shoulder': rotate(-.3, 0, .2), 'right-elbow': rotate(-.35),
  }) }),
};

/** Shared motion matching owns gait. Explicit posture/emote layers stay editable. */
export function createLoungeAnimation(rig: ThreeAnimationRig) {
  const locomotion = new HumanoidLocomotionDriver();
  return new ActorAnimationController({ rig, clips: loungeClips,
    locomotion: { reset: () => locomotion.reset(), sample: ctx => ctx.signals.posture === 'sitting' || ctx.signals.grounded === false
      ? { pose: {}, diagnostics: { source: 'authored:lounge-posture', state: ctx.signals.posture === 'sitting' ? 'sitting' : 'airborne' } }
      : locomotion.sample(ctx) },
    layers: ({ signals }) => [{ clip: 'posture' }, ...(Number(signals.parameters?.emoteId ?? 0) > 0
      ? [{ clip: emoteNames[Number(signals.parameters!.emoteId) - 1], timeMs: Number(signals.parameters?.emoteTimeMs ?? 0) }] : [])],
  });
}

export function loungeActorSignals(frame: ViewFrame<WorldState, PlayerState, GameTuning>): Readonly<Record<string, ActorPresentationSignals>> {
  const terrain = sharedTerrain.read(frame.tuning);
  return Object.fromEntries(frame.players.map(player => {
    const s = player.state, sitting = s.seatIndex >= 0, facing = sitting ? seats[s.seatIndex]?.facing ?? s.facing : s.facing;
    return [player.id, { id: player.id, timeMs: frame.now, epoch: `${frame.phase}:${s.physicsId}:${terrain.revision}`,
      position: { x: s.x, y: s.y, z: s.z }, velocity: { x: s.velocityX, y: s.velocityY, z: s.velocityZ },
      facing: { x: Math.sin(facing), y: 0, z: Math.cos(facing) }, up: { x: 0, y: 1, z: 0 },
      grounded: sitting || s.grounded > 0, posture: sitting ? 'sitting' : 'standing',
      supports: !sitting && s.grounded > 0 ? terrain.actorSupports({ ground: s }, frame.now) : undefined,
      parameters: { torsoLookYaw: Math.atan2(Math.sin(s.facing - facing), Math.cos(s.facing - facing)), aimPitch: s.aimPitch ?? 0,
        active: player.active !== false && player.hp > 0, emoteId: s.emoteId || 0,
        emoteTimeMs: Math.max(0, (frame.world?.elapsedMs ?? 0) - (s.emoteStartedMs || 0)) },
    } satisfies ActorPresentationSignals];
  }));
}

export function createLoungeActor(modelId = 'builtin:male') {
  const actor = createHumanoidSkeleton({ scale: SCALE }), root = new THREE.Group();
  root.add(actor.root);
  const colors = MODEL_PALETTES[modelId] ?? MODEL_PALETTES['builtin:male'];
  const materials = Object.fromEntries(Object.entries({ shirt: colors.shirt, pants: colors.pants, skin: colors.skin,
    hair: colors.hair, white: 0xf1e8d8, brass: 0xcba87e, eyes: 0x171c26 }).map(([key, color]) =>
      [key, new THREE.MeshStandardMaterial({ color, roughness: key === 'brass' ? .35 : .75, metalness: key === 'brass' ? .6 : 0 })]));
  const cube = new THREE.BoxGeometry(1, 1, 1), sphere = new THREE.SphereGeometry(1, 12, 8);
  const add = (joint: string, size: [number, number, number], at: [number, number, number], material: string, rounded = false) => {
    const mesh = new THREE.Mesh(rounded ? sphere : cube, materials[material]);
    mesh.scale.set(...size.map(v => v * SCALE) as [number, number, number]);
    mesh.position.set(...at.map(v => v * SCALE) as [number, number, number]); mesh.castShadow = mesh.receiveShadow = true;
    actor.joints[joint].add(mesh); return mesh;
  };
  add('hips', [.43, .21, .29], [0, -.015, 0], 'pants');
  for (const joint of ['spine-1', 'spine-2', 'spine-3', 'spine-4', 'chest']) {
    add(joint, [.47, .112, .3], [0, .03, 0], 'shirt');
    add(joint, [.018, .112, .012], [0, .03, .16], 'brass');
  }
  add('chest', [.12, .08, .018], [.13, .05, .163], 'brass');
  add('neck-1', [.13, .2, .12], [0, .02, 0], 'skin');
  add('head', [.19, .22, .175], [0, .055, 0], 'skin', true);
  add('head', [.196, .1, .184], [0, .205, -.02], 'hair', true);
  if (colors.longHair) add('head', [.2, .25, .065], [0, -.035, -.155], 'hair', true);
  for (const side of [-1, 1]) {
    add('head', [.02, .028, .014], [side * .072, .082, .165], 'eyes');
    add('head', [.042, .057, .03], [side * .185, .035, 0], 'skin', true);
  }
  add('head', [.075, .012, .009], [0, -.025, .169], 'hair');
  for (const side of ['left', 'right']) {
    add(`${side}-clavicle`, [.26, .15, .28], [side === 'left' ? -.10 : .10, -.025, 0], 'shirt');
    add(`${side}-shoulder`, [.18, .3, .22], [0, -.14, 0], 'shirt');
    add(`${side}-elbow`, [.15, .26, .18], [0, -.13, 0], colors.longHair ? 'shirt' : 'skin');
    add(`${side}-hand`, [.09, .11, .085], [0, -.04, 0], 'skin', true);
    add(`${side}-hip`, [.22, .4, .23], [0, -.19, 0], 'pants');
    add(`${side}-knee`, [.19, .36, .21], [0, -.18, 0], 'pants');
    add(`${side}-foot`, [.225, .12, .32], [0, -.065, .065], 'white');
    add(`${side}-foot`, [.23, .025, .325], [0, -.125, .065], 'brass');
  }
  const animation = createLoungeAnimation(actor.animationRig);
  let last: ReturnType<ActorAnimationController['sample']> | undefined, posture: string | undefined, disposed = false;
  return { root, joints: actor.joints, animation,
    update(signals: Readonly<ActorPresentationSignals>) {
      root.userData.inspectionActorId = signals.id;
      last = animation.sample({ signals, reset: posture !== signals.posture }); posture = signals.posture;
    },
    inspection() { return { rigId: 'humanoid-v1', joints: Object.keys(actor.joints).length,
      posture, locomotion: last?.diagnostics.locomotion, warnings: last?.diagnostics.warnings ?? [], animation: last?.diagnostics.animation }; },
    dispose() { if (disposed) return; disposed = true; animation.reset(); root.removeFromParent(); actor.skeleton.dispose();
      cube.dispose(); sphere.dispose(); Object.values(materials).forEach(material => material.dispose()); },
  };
}
