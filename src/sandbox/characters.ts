/** Shared character foundation: one coordinated Rapier batch for every mode. */
import { stepPhysics, type PhysicsBody, type PhysicsBodyResult, type PhysicsCompoundBody, type PhysicsScene } from './physics.ts';

export interface CharacterState {
  physicsId: number;
  x: number; y: number; z: number;
  velocityX: number; velocityY: number; velocityZ: number;
  grounded: number;
}
export interface CharacterTuning {
  fighterRadius: number; fighterHeight: number;
  gravity: number; maxSlopeDegrees: number;
}

/** World-space normalized input. Vertical velocity is retained for jumping/flight mods. */
export function applyCharacterMovement(state: CharacterState, input: { moveX: number; moveZ: number } | undefined, speed: number): void {
  const dx = Number.isFinite(input?.moveX) ? input!.moveX : 0;
  const dz = Number.isFinite(input?.moveZ) ? input!.moveZ : 0;
  const scale = Math.max(0, speed) / Math.max(1, Math.hypot(dx, dz));
  state.velocityX = dx * scale;
  state.velocityZ = dz * scale;
}

export function characterBody(state: CharacterState, tuning: CharacterTuning): PhysicsBody {
  return { shape: { kind: 'capsule', radius: tuning.fighterRadius, halfHeight: tuning.fighterHeight / 2 - tuning.fighterRadius },
    position: { x: state.x, y: state.y + tuning.fighterHeight / 2, z: state.z },
    velocity: { x: state.velocityX, y: state.velocityY, z: state.velocityZ }, lockRotations: true, friction: 0 };
}

/** Join the shared destruction batch instead of also calling moveCharacters.
 * Mass is explicit game tuning (80kg by default); the legacy helper is unchanged.
 */
export function characterCompoundBody(state: CharacterState, tuning: CharacterTuning, mass = 80): PhysicsCompoundBody {
  if (!Number.isSafeInteger(state.physicsId) || !Number.isFinite(mass) || mass < .01 || mass > 1e7)
    throw new Error('Compound characters require a stable integer physicsId and .01..1e7kg mass.');
  const body = characterBody(state,tuning);
  return {id:`character:${state.physicsId}`,position:body.position,velocity:body.velocity,mass,lockRotations:true,
    colliders:[{id:'capsule',shape:body.shape,position:{x:0,y:0,z:0},friction:body.friction}]};
}

/** Apply the result matching the submitted compound body's ID, preserving the
 * ordinary slope/grounding rules. Never step the character a second time.
 */
export function applyCharacterPhysicsResult(state: CharacterState, body: Pick<PhysicsBody,'velocity'>,
  result: PhysicsBodyResult, tuning: CharacterTuning): void {
  applyResult(state,body,result,tuning);
}

/** Stable IDs preserve body ordering across authority, prediction and replays. */
export function moveCharacters(states: CharacterState[], dt: number, tuning: CharacterTuning, scene: PhysicsScene): void {
  if (!states.length || !Number.isFinite(dt) || dt <= 0) return;
  const ordered = [...states].sort((a, b) => a.physicsId - b.physicsId);
  const bodies = ordered.map(state => characterBody(state, tuning));
  const results = stepPhysics({ scene, bodies, gravity: { x: 0, y: -tuning.gravity, z: 0 }, dt: Math.min(dt, 0.25) });
  ordered.forEach((state, index) => applyResult(state, bodies[index], results[index], tuning));
}

function applyResult(state: CharacterState, body: Pick<PhysicsBody,'velocity'>, result: PhysicsBodyResult, tuning: CharacterTuning): void {
  state.x = result.position.x; state.z = result.position.z;
  state.y = result.position.y - tuning.fighterHeight / 2;
  state.velocityX = result.velocity.x; state.velocityY = result.velocity.y; state.velocityZ = result.velocity.z;
  const ground = result.ground;
  const support = ground && ground.normal.y > 0
    ? tuning.fighterHeight / 2 - tuning.fighterRadius + tuning.fighterRadius / ground.normal.y : 0;
  state.grounded = ground && ground.normal.y >= Math.cos(tuning.maxSlopeDegrees * Math.PI / 180)
    && ground.distance <= support + 0.025 && body.velocity.y <= 0 ? 1 : 0;
  if (state.grounded) {
    // A rounded capsule can already be lifted by a tread while its centre ray
    // still sees the lower floor. Snapping down would undo native collision
    // resolution on every tick and prevent climbing solid stairs.
    if (ground!.normal.y > 0.999999) state.y = Math.max(state.y, result.position.y - ground!.distance);
    state.velocityY = 0;
  }
}

/** Shared circular boundary. Content may add terrain, props and other colliders. */
export function circularArenaWalls(radius: number, segments = 64): PhysicsScene['colliders'] {
  if (!Number.isFinite(radius) || radius <= 0 || !Number.isInteger(segments) || segments < 8 || segments > 64)
    throw new Error('Circular arena walls require a positive radius and 8–64 integer segments.');
  const colliders: PhysicsScene['colliders'] = [];
  for (let i = 0; i < segments; i++) {
    const angle = i * Math.PI * 2 / segments;
    colliders.push({ shape: { kind: 'box', halfExtents: { x: radius * Math.tan(Math.PI / segments) + 0.02, y: 500, z: 0.25 } },
      position: { x: Math.sin(angle) * (radius + 0.25), y: 0, z: Math.cos(angle) * (radius + 0.25) },
      rotation: { x: 0, y: Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2) } });
  }
  return colliders;
}
