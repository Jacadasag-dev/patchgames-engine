import { Object3D, Quaternion, Vector3 } from 'three';
import { HumanoidHandPlacement, placeBowHands, socketWorld, type SocketFrame, type createBowModel, type createSwordModel } from '../sandbox/equipmentView.ts';
import type { ActorAnimationContext } from '../sandbox/actorAnimation.ts';

export const ARENA_PALM: SocketFrame = { position: { x: 0, y: -.055, z: 0 } };
// Center the sword handle in the curled fingers, clear of the wrist crease.
export const ARENA_SWORD_PALM: SocketFrame = { position: { x: 0, y: -.075, z: 0 } };
// A bow's upright handle crosses the holding palm; the drawing fingers hook
// the string from the opposite side. Each grip frame defines that relationship
// explicitly without rotating the shared model or its shot-forward axis.
export const ARENA_BOW_PALM: SocketFrame = { position: { x: 0, y: -.075, z: 0 },
  rotation: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -Math.PI / 2) };
export const ARENA_BOW_DRAW_PALM: SocketFrame = { position: { x: 0, y: -.075, z: 0 },
  rotation: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2) };
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };
const forward = new Vector3(0, 0, 1);
const directionRotation = (x: number, y: number, z: number) => new Quaternion().setFromUnitVectors(forward, new Vector3(x, y, z).normalize());
// The blade is palm +Z and its sharp edges are palm ±X. Roll the grip so an
// edge, rather than the broad face, leads this downward cut. These are authored
// move semantics: another move could deliberately strike with the flat.
const cutRotation = (x: number, y: number, z: number) => directionRotation(x, y, z)
  .multiply(new Quaternion().setFromAxisAngle(forward, -Math.PI / 2));
// Ordinary editable pose profiles. Their targets are palm frames, not guessed
// mesh rotations; the shared solver preserves actual arm segment lengths.
const cuts = [
  { phase: 0, p: new Vector3(.45, -.18, .28), q: cutRotation(.15, .35, 1) },
  { phase: .25, p: new Vector3(.45, -.06, .33), q: cutRotation(.10, .80, .60) },
  { phase: .45, p: new Vector3(.32, -.12, .36), q: cutRotation(0, .12, 1) },
  { phase: .65, p: new Vector3(.27, -.24, .34), q: cutRotation(-.10, -.25, 1) },
  { phase: 1, p: new Vector3(.45, -.18, .28), q: cutRotation(.15, .35, 1) },
];

/** The same arm chains serve first-person play, remote players and inspection.
 * Timers come from gameplay; these layers never invent hits or fire arrows. */
export class ArenaEquipmentPose {
  readonly hands: HumanoidHandPlacement;
  private bowWeight = 0;
  private swordWeight = 0;
  private lastDraw = 0;
  private releaseDraw = 0;
  private releasing = false;
  private raised = 0;
  private displayedDraw = 0;
  private readonly rig: { root: Object3D; joints: Readonly<Record<string, Object3D>> };
  private readonly bow: ReturnType<typeof createBowModel>;
  private readonly sword: ReturnType<typeof createSwordModel>;
  constructor(rig: { root: Object3D; joints: Readonly<Record<string, Object3D>> },
    bow: ReturnType<typeof createBowModel>, sword: ReturnType<typeof createSwordModel>) {
    this.rig = rig; this.bow = bow; this.sword = sword;
    this.hands = new HumanoidHandPlacement(rig);
  }
  reset() { this.bowWeight = this.swordWeight = this.lastDraw = this.releaseDraw = this.raised = this.displayedDraw = 0;
    this.releasing = false; this.bow.setDraw(0, false); this.hands.reset(); this.lastHands = { hands: [], warnings: [] }; }
  apply(context: Readonly<ActorAnimationContext>, aimRoot: Object3D) {
    const { signals, deltaMs, reset } = context, p = signals.parameters ?? {};
    const active = !['downed', 'dead'].includes(signals.posture ?? '') && p.active !== false && !Number(p.bandageMs ?? 0);
    if (!active) { this.reset(); return; }
    const blend = reset ? 1 : 1 - Math.exp(-deltaMs / 90);
    this.bowWeight += (Number(p.equipped === 2) - this.bowWeight) * blend;
    this.swordWeight += (Number(p.equipped === 1) - this.swordWeight) * blend;
    const remaining = Number(p.attackRemainingMs ?? 0), attackWeapon = Number(p.attackWeapon ?? p.equipped ?? 0);
    const draw = clamp(Number(p.bowDrawPhase ?? (Number(p.bowDrawMs ?? 0) / Math.max(1, Number(p.bowDrawDurationMs ?? 800)))));
    const release = remaining > 0 && attackWeapon === 2;
    if (release) this.releaseDraw = p.bowReleaseDrawPhase !== undefined
      ? clamp(Number(p.bowReleaseDrawPhase)) : !this.releasing ? this.lastDraw : this.releaseDraw;
    const releasePhase = release ? clamp(Number(p.bowReleasePhase ?? (1 - remaining / Math.max(1, Number(p.bowReleaseMs ?? 260))))) : 0;
    const recover = 1 - smooth(Math.max(0, releasePhase - .2) / .8);
    this.displayedDraw = release ? 0 : draw > 0 || reset ? draw : this.displayedDraw * Math.exp(-deltaMs / 65);
    const extension = release ? this.releaseDraw * recover : this.displayedDraw;
    const desiredRaise = smooth(extension / .45);
    // Cancellation lowers the real arms gently. The string of a fired bow
    // releases immediately while the hand remains back for follow-through.
    this.raised = reset ? desiredRaise : Math.max(desiredRaise, this.raised * Math.exp(-deltaMs / 80));
    // Unarmed/carry-only frames have no hand constraint. Preserve the temporal
    // state above, but avoid recomposing the entire body to calculate unused IK
    // targets. The animation rig and renderer still update the displayed pose.
    if (p.equipped !== 2 && !(p.equipped === 1 && this.swordWeight > .001 && remaining > 0 && attackWeapon === 1)) {
      this.lastHands = { hands: [], warnings: [] }; this.lastDraw = this.raised = this.displayedDraw = 0; this.releasing = false;
      return;
    }
    const j = this.rig.joints;
    const scale = aimRoot.getWorldScale(new Vector3()).x, heading = aimRoot.getWorldQuaternion(new Quaternion());
    const pitch = Math.max(-1.35, Math.min(1.35, Number(p.aimPitch ?? 0)));
    const aim = heading.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -pitch));
    // Extreme aim does not require folding the whole torso over the bow or
    // lifting its wrist into the eye camera. Keep reach in front of the chest
    // and cant the limbs around the unchanged gameplay shot direction.
    const bowSteep = smooth((-pitch - .3) / .7);
    const bowUp = smooth((pitch - .25) / .8);
    const upAttenuation = .5 + .15 * smooth((pitch - 1.05) / .3);
    const bowReach = heading.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -pitch * (1 - .65 * bowSteep - upAttenuation * bowUp)));
    const bowAim = aim.clone().multiply(new Quaternion().setFromAxisAngle(forward, -Math.max(smooth((-pitch - .15) / .45), .6 * bowUp)));
    if (p.equipped === 2) {
      // Aim the torso in world space so locomotion's hip twist and smoothed body
      // turns cannot pull an extended bow hand off its grip. Legs retain the
      // original matched motion; equipment still follows the actual arm bones.
      const desired = bowReach.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), .45 + .20 * extension));
      const chest = j.chest, world = chest.getWorldQuaternion(new Quaternion()).slerp(desired, this.bowWeight);
      chest.quaternion.copy(chest.parent!.getWorldQuaternion(new Quaternion()).invert().multiply(world));
    }
    this.rig.root.updateWorldMatrix(true, true);
    const center = j['left-shoulder'].getWorldPosition(new Vector3()).add(j['right-shoulder'].getWorldPosition(new Vector3())).multiplyScalar(.5);
    const point = (v: Vector3, rotation = aim) => v.clone().multiplyScalar(scale).applyQuaternion(rotation).add(center);
    const rightPole = point(new Vector3(.8, -.25, -.08), heading);
    if (p.equipped === 2 && this.bowWeight > .001) {
      const stringDraw = release ? this.releaseDraw * (1 - smooth(releasePhase / .18)) : this.displayedDraw;
      // Extend the holding arm as the drawing hand comes back. Starting at
      // full extension would put an undrawn string beyond the other arm.
      // The nock finishes beside the drawing cheek, not through the eye camera.
      // Carry at chest height so the lower limb stays ahead of the legs as
      // pitch changes. Draw extends the bow arm rather than lifting a low bow
      // through the face. At steep down-aim, avoid overextending that arm.
      const grip = point(new Vector3(.135, .09 + .05 * this.raised + .12 * bowUp,
        .39 + .19 * extension * (1 - bowSteep) - extension * (.05 * bowUp + .07 * bowSteep)), bowReach);
      // Keep a relaxed, undrawn bow ahead of the hips even after locomotion
      // has fully settled; a draw brings the string back toward the cheek.
      grip.add(new Vector3(0, 0, .08 * (1 - extension) * (1 - bowSteep) * scale).applyQuaternion(heading));
      const handRotation = bowAim.clone().multiply(new Quaternion().copy(ARENA_BOW_PALM.rotation!).invert());
      const leftPole = grip.clone().add(new Vector3(0, .5 * scale, 0).applyQuaternion(handRotation));
      // Equip with the bow already upright, then bring the actual hand forward
      // around the body. Blending the item's rotation from a relaxed hanging
      // wrist sweeps the long limbs through the legs and opposite arm. Start
      // just outside that hanging pose, including the first high-rate frame.
      const equipStart = socketWorld(j['left-hand'], ARENA_BOW_PALM).position;
      const lowered = smooth((center.y - equipStart.y - .2 * scale) / (.25 * scale));
      const equipWeight = Math.max(.25 * lowered, this.bowWeight);
      const equipGrip = equipStart.lerp(grip, equipWeight)
        .add(new Vector3(0, 0, .10 * lowered * Math.sin(Math.PI * equipWeight) * scale).applyQuaternion(heading));
      // An already raised running hand needs no extra low-hand lift. Preserve
      // its elbow plane longer so the equip does not jerk the shoulder.
      const slowPole = this.bowWeight * this.bowWeight;
      const equipPole = j['left-elbow'].getWorldPosition(new Vector3()).lerp(leftPole, slowPole + (equipWeight - slowPole) * lowered);
      // Let go of the string: the drawing hand stays near the cheek briefly
      // while the string snaps forward, then returns with the recovery pose.
      this.lastHands = placeBowHands(this.hands, this.bow, {
        draw: stringDraw, arrowVisible: !release && Number(p.arrows ?? 1) > 0,
        primary: { position: equipGrip, rotation: bowAim, pole: equipPole, socket: ARENA_BOW_PALM },
        // Let the bow rise past the drawing arm before that hand joins the
        // nock; simultaneous equip blends sweep a limb through the forearm.
        secondary: { rotation: bowAim, pole: rightPole, socket: ARENA_BOW_DRAW_PALM, weight: this.bowWeight * this.bowWeight,
          offset: release ? { x: .07 * Math.sin(releasePhase * Math.PI), y: .02 * recover,
            z: -(this.releaseDraw - stringDraw) * .38 * recover } : undefined },
      });
      this.lastDraw = draw; this.releasing = release;
    } else if (p.equipped === 1 && this.swordWeight > .001 && remaining > 0 && attackWeapon === 1) {
      const duration = Math.max(1, Number(p.attackDurationMs ?? 550));
      const phase = clamp(Number(p.swordAttackPhase ?? (1 - remaining / duration)));
      const next = cuts.findIndex(key => key.phase >= phase && key.phase > 0), a = cuts[Math.max(0, next - 1)], b = cuts[Math.max(1, next)];
      const t = smooth((phase - a.phase) / (b.phase - a.phase));
      // The right shoulder moves with the matched torso. Anchor reach there,
      // rather than the midpoint between shoulders, so a turning gait cannot
      // pull the sword arm straight and fold the handle back into its forearm.
      const shoulder = j['right-shoulder'].getWorldPosition(new Vector3());
      // Looking steeply up/down turns the blade, while the hand stays forward
      // of the torso. Rotating the whole reach by camera pitch would drive a
      // downward cut through the legs, or an upward windup through the head.
      const steep = smooth((Math.abs(pitch) - .4) / .7);
      const reachAim = heading.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -pitch * .35));
      const outside = .22 * steep;
      const swordPoint = (v: Vector3) => v.clone().sub(new Vector3(.4 - outside, 0, 0))
        .multiplyScalar(scale).applyQuaternion(reachAim).add(shoulder);
      const position = swordPoint(a.p.clone().lerp(b.p, t));
      const localRotation = a.q.clone().slerp(b.q, t), blade = forward.clone().applyQuaternion(localRotation);
      const bladePitch = Math.atan2(blade.y, blade.z);
      // At steep aim, shorten the overhead windup/follow-through instead of
      // folding the blade backward past the head or underneath the forearm.
      const cutPitch = Math.max(-1.4, Math.min(1.4, pitch + bladePitch)) - bladePitch;
      const rotation = heading.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -cutPitch)).multiply(localRotation);
      // A slight outward wrist flex on a downward cut separates the pommel
      // from the forearm while keeping the blade outside the shin's line.
      if (pitch < 0) rotation.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -.22 * steep));
      // Aim constrains an actual strike only. Carrying uses the animated wrist
      // socket, so the sword swings with the arm instead of pinning it in space.
      const weight = this.swordWeight * smooth(phase / .12) * (1 - smooth((phase - .84) / .16));
      const wristWeight = this.swordWeight * smooth((phase - .04) / .16) * (1 - smooth((phase - .70) / .23));
      // Blend the elbow's bend plane too: changing its pole at full strength
      // would flip the forearm while the wrist was still mostly in its gait pose.
      // Move the hand clear first, then turn the blade. On recovery, restore its
      // carry angle before lowering the arm, avoiding a diagonal shortcut
      // through the forearm during interpolation.
      const palmRotation = j['right-hand'].getWorldQuaternion(new Quaternion()).slerp(rotation, wristWeight);
      const palm = j['right-hand'].localToWorld(new Vector3(0, -.075, 0)).lerp(position, weight);
      const swordPole = j['right-elbow'].getWorldPosition(new Vector3())
        .lerp(new Vector3(0, .5 * scale, 0).applyQuaternion(palmRotation).add(palm), weight);
      this.lastHands = this.hands.apply({ right: { position: palm, rotation: palmRotation, pole: swordPole, socket: ARENA_SWORD_PALM } });
      this.lastDraw = this.raised = this.displayedDraw = 0; this.releasing = false;
    } else { this.lastHands = { hands: [], warnings: [] }; this.lastDraw = this.raised = this.displayedDraw = 0; this.releasing = false; }
  }
  private lastHands: ReturnType<HumanoidHandPlacement['inspection']> = { hands: [], warnings: [] };
  inspection() { return { hands: this.lastHands, bow: this.bow.inspection(), sword: this.sword.inspection() }; }
}
