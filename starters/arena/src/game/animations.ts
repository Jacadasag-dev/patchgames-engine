import { ActorAnimationController, type ActorAnimationContext } from '../sandbox/actorAnimation.ts';
import { quaternionFromEuler, type ActorPresentationSignals, type AnimationClip, type AnimationClipLayer, type AnimationPose } from '../sandbox/animation.ts';
import type { ThreeAnimationRig } from '../sandbox/animationView.ts';
import { HumanoidLocomotionDriver } from '../sandbox/actorLocomotion.ts';
import type { ViewFrame } from '../shared/gameApi.ts';
import type { PlayerState, WorldState } from './shapes.ts';
import type { GameTuning } from './tuning.ts';
import { sharedTerrain } from './terrainWorld.ts';

const rotate=(x=0,y=0,z=0)=>({rotation:quaternionFromEuler({x,y,z})});
/** Editable upper-body swing; gameplay owns its countdown and damage. */
export const ARENA_STRIKE: AnimationClip = {
  durationMs: 550,
  sample({ phase, signals }): AnimationPose {
    if (signals?.parameters?.equipped === 2 || signals?.parameters?.equipped === 1) return {};
    const strength=Math.sin(phase*Math.PI),wind=phase<.25?-2.3*phase/.25
      :phase<.65?-2.3+2.8*(phase-.25)/.4:.5*(1-(phase-.65)/.35);
    return {'right-shoulder':rotate(wind,-.3*strength,.12*strength),
      'right-elbow':rotate(-.65*strength),'right-hand':rotate(0,0,-.12*strength),
      'left-shoulder':rotate(-.3*strength,0,-.15*strength),'left-elbow':rotate(-.45*strength),
      'spine-2':rotate(.07*strength,.12*strength),chest:rotate(0,-.25*strength)};
  },
};

/** Open the sword arm slightly away from the body, retaining the matched gait's
 * swing. A relaxed wrist keeps the blade clear without pinning a world target. */
export const ARENA_SWORD_CARRY: AnimationClip = {
  durationMs: 1000, loop: true,
  sample: () => ({ 'right-shoulder': rotate(0, 0, .22), 'right-elbow': rotate(-.12), 'right-hand': rotate(.20, .65) }),
};

/** Bow aiming/release and bandaging are ordinary upper-body layers. Locomotion,
 * heading and terrain foot contacts continue underneath without bespoke rig code. */
export const ARENA_BOW_AIM: AnimationClip = {
  durationMs: 1000, loop: true,
  sample({ signals }) {
    const pitch = Math.max(-1.35, Math.min(1.35, Number(signals?.parameters?.aimPitch ?? 0)));
    // The socket solver places the real arms after blending. This layer only
    // provides torso posture; it cannot turn the weapon sideways independently.
    return { chest: rotate(-pitch, .65), 'neck-1': rotate(0, -.65) };
  },
};
export const ARENA_BANDAGE: AnimationClip = {
  durationMs: 900, loop: true,
  sample({ timeMs }) {
    const wrap = Math.sin(timeMs / 900 * Math.PI * 2);
    return { 'left-shoulder': rotate(-.8, -.2, -.25), 'left-elbow': rotate(-1.3),
      'right-shoulder': rotate(-.7 + wrap * .08, .3, .35), 'right-elbow': rotate(-1.55 + wrap * .16),
      'right-hand': rotate(wrap * .18, 0, wrap * .25), 'neck-1': rotate(.25), chest: rotate(.08) };
  },
};
export function createArenaEquipmentLayers() {
  let bowWeight = 0, healWeight = 0, swordWeight = 0;
  return ({ signals, deltaMs, reset }: Readonly<ActorAnimationContext>): AnimationClipLayer[] => {
    const active = signals.posture !== 'dead' && signals.posture !== 'downed' && signals.parameters?.active !== false;
    const healing = active && Number(signals.parameters?.bandageMs ?? 0) > 0;
    const bow = active && signals.parameters?.equipped === 2 && !healing;
    const sword = active && signals.parameters?.equipped === 1 && !healing;
    const blend = reset ? 1 : 1 - Math.exp(-deltaMs / 90);
    bowWeight += (Number(bow) - bowWeight) * blend; healWeight += (Number(healing) - healWeight) * blend;
    swordWeight += (Number(sword) - swordWeight) * blend;
    return [
      ...(bowWeight > .0001 ? [{ clip: 'bow-aim', weight: bowWeight }] : []),
      ...(swordWeight > .0001 ? [{ clip: 'sword-carry', weight: swordWeight, mode: 'additive' as const }] : []),
      ...(healWeight > .0001 ? [{ clip: 'bandage', weight: healWeight }] : []),
    ];
  };
}

export function arenaActorSignals(frame: ViewFrame<WorldState, PlayerState, GameTuning>): Readonly<Record<string, ActorPresentationSignals>> {
  const terrain = sharedTerrain.read(frame.tuning);
  return Object.fromEntries(frame.players.map(player => {
    const state = player.state, playing = frame.phase === 'fighting' && player.hp > 0 && player.active !== false;
    return [player.id, {
      id: player.id, timeMs: frame.now, epoch: `${frame.phase}:${state.physicsId}:${terrain.revision}`,
      position: { x: state.x, y: state.y, z: state.z },
      velocity: playing ? { x: state.velocityX, y: state.velocityY, z: state.velocityZ } : {x:0,y:0,z:0},
      facing: { x: Math.sin(state.facing), y: 0, z: Math.cos(state.facing) }, up: { x: 0, y: 1, z: 0 },
      grounded: state.grounded > 0, posture: player.hp > 0 ? 'standing' : 'dead',
      supports: state.grounded > 0 ? terrain.actorSupports({ ground: state }, frame.now) : undefined,
      parameters: { moveSpeed: frame.tuning.moveSpeed, weapon: state.weapon, equipped: state.equipped, aimPitch: state.aimPitch,
        armorFace: state.armorFace, armorChest: state.armorChest, armorLegs: state.armorLegs, armorArms: state.armorArms,
        bandageMs: playing ? state.bandageMs : 0, attacking: playing && state.attackMs > 0,
        attackId: state.attackId,
        bowDrawMs: playing ? state.bowDrawMs : 0, bowShotDrawMs: playing ? state.bowShotDrawMs : 0,
        arrows: state.arrows, attackWeapon: state.attackWeapon,
        bowDrawDurationMs: frame.tuning.bowDrawDurationMs, bowReleaseMs: frame.tuning.bowReleaseMs,
        attackRemainingMs: playing ? state.attackMs : 0,
        attackDurationMs: state.attackWeapon === 2 ? frame.tuning.bowReleaseMs : frame.tuning.attackDurationMs,
        active: player.active !== false && player.hp > 0 },
    } satisfies ActorPresentationSignals];
  }));
}

export function createArenaAnimation(rig: ThreeAnimationRig): ActorAnimationController {
  const equipmentLayers = createArenaEquipmentLayers();
  return new ActorAnimationController({ rig, clips: {strike: ARENA_STRIKE, 'bow-aim': ARENA_BOW_AIM, 'sword-carry': ARENA_SWORD_CARRY, bandage: ARENA_BANDAGE},locomotion:new HumanoidLocomotionDriver(),
    layers(context) {
      const { signals } = context;
      const remaining = Number(signals.parameters?.attackRemainingMs ?? 0);
      const duration = Math.max(1, Number(signals.parameters?.attackDurationMs ?? 120));
      // The synced attack countdown is authoritative; no client-created action
      // IDs, damage events, or extra attack duration are inferred by the view.
      return [...(remaining > 0 ? [{ clip: 'strike', phase: Math.max(0, Math.min(1, 1 - remaining / duration)) }] : []),
        ...equipmentLayers(context)];
    },
  });
}
