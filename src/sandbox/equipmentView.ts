/** View-only authored equipment sockets and post-animation arm placement.
 * Models use +Y up, +Z forward; a socket's +Z is its explicit aim/grip forward.
 * Gameplay owns aim, collisions, damage and authoritative actor roots. */
import { AxesHelper, BoxGeometry, ConeGeometry, CylinderGeometry, Group, Material, Matrix4, Mesh, MeshStandardMaterial,
  Object3D, Quaternion, Vector3 } from 'three';
import { getInspectionOwner, registerInspectionAttachment, registerInspectionEquipment, type InspectionCapsule } from './inspectionGeometry.ts';
import { createEquipmentOrientationMarkers, registerEquipmentOrientation, requireEquipmentOrientation } from './equipmentOrientation.ts';
import { isInspectionFrameActive, recordInspectionHandConstraint } from './inspectionTelemetry.ts';
import type { EquipmentWeight } from './equipmentMotion.ts';

export interface SocketVector { x: number; y: number; z: number }
export interface SocketRotation extends SocketVector { w: number }
export interface SocketFrame { position?: Readonly<SocketVector>; rotation?: Readonly<SocketRotation> }
export interface WorldSocketFrame { position: Vector3; rotation: Quaternion; forward: Vector3 }
export interface EquipmentAttachmentInspection {
  positionError: number; orientationError: number; grip: SocketVector; forward: SocketVector;
}
export interface EquipmentAttachment {
  model: Object3D;
  inspection(): EquipmentAttachmentInspection;
  detach(): void;
}
const xyz = (v: Readonly<SocketVector>) => new Vector3(v.x, v.y, v.z);
const plain = (v: Vector3): SocketVector => ({ x: v.x, y: v.y, z: v.z });
const identity = () => new Quaternion();
const finiteVector = (value: Readonly<SocketVector>, name: string) => {
  if (![value.x, value.y, value.z].every(n => Number.isFinite(n) && Math.abs(n) <= 1e8)) throw new Error(`Equipment ${name} requires a finite bounded vector.`);
};
function rotation(value?: Readonly<SocketRotation>): Quaternion {
  const q = value ? new Quaternion(value.x, value.y, value.z, value.w) : identity();
  if (![q.x, q.y, q.z, q.w].every(Number.isFinite) || q.lengthSq() < 1e-12) throw new Error('Equipment socket rotation must be a nonzero finite quaternion.');
  return q.normalize();
}
function socketMatrix(socket: SocketFrame): Matrix4 {
  const p = socket.position ?? { x: 0, y: 0, z: 0 }; finiteVector(p, 'socket position');
  return new Matrix4().compose(xyz(p), rotation(socket.rotation), new Vector3(1, 1, 1));
}
export function socketWorld(object: Object3D, socket: SocketFrame = {}): WorldSocketFrame {
  // Current Three versions do not propagate a changed ancestor's dirty flag
  // down to a matrix-owned child during a parent-only update. Refresh the exact
  // ancestor chain so sockets follow animated hands even before a render pass.
  for (let node: Object3D | null = object; node; node = node.parent) node.matrixWorldNeedsUpdate = true;
  object.updateWorldMatrix(true, false);
  const matrix = object.matrixWorld.clone().multiply(socketMatrix(socket));
  const position = new Vector3(), orientation = new Quaternion(), scale = new Vector3();
  matrix.decompose(position, orientation, scale);
  return { position, rotation: orientation.normalize(), forward: new Vector3(0, 0, 1).transformDirection(matrix) };
}
/** Attach once after creating a model. Explicit frame algebra replaces trial-and-
 * error Euler offsets. Root scale is retained; geometry/child transforms are not
 * changed. Normal carrying follows the animated hand without an IK target;
 * constrain the hand only for deliberate aiming, strikes or two-hand contact.
 * The returned diagnostic reads the current animated world matrices. */
export function attachEquipment(hand: Object3D, model: Object3D, modelGrip: SocketFrame, handSocket: SocketFrame = {}): EquipmentAttachment {
  if (hand === model) throw new Error('Equipment cannot attach to itself.');
  for (let node: Object3D | null = hand; node; node = node.parent) if (node === model) throw new Error('Equipment attachment would create a hierarchy cycle.');
  const scale = model.scale.clone();
  if (![scale.x, scale.y, scale.z].every(n => Number.isFinite(n) && n > 0)) throw new Error('Equipment scale must be finite and positive.');
  requireEquipmentOrientation(model);
  // The scale belongs between socket frames: the model grip still lands exactly
  // on the hand socket when authored geometry is converted to different units.
  const local = socketMatrix(handSocket).multiply(new Matrix4().makeScale(scale.x, scale.y, scale.z)).multiply(socketMatrix(modelGrip).invert());
  hand.add(model); model.matrix.copy(local); local.decompose(model.position, model.quaternion, model.scale);
  // Matrix ownership preserves even a nonuniform authored scale plus socket turn.
  model.matrixAutoUpdate = false; model.matrixWorldNeedsUpdate = true;
  registerInspectionAttachment(model);
  const inspection = () => {
    const palm = socketWorld(hand, handSocket), grip = socketWorld(model, modelGrip);
    return { positionError: palm.position.distanceTo(grip.position), orientationError: palm.rotation.angleTo(grip.rotation),
      grip: plain(grip.position), forward: plain(grip.forward) };
  };
  return { model, inspection, detach: () => model.removeFromParent() };
}

export interface HandPlacementTarget {
  /** Desired world-space socket position. With no socket this is the wrist. */
  position: Readonly<SocketVector>;
  /** World point on the desired elbow side, not a direction/vector offset. */
  pole: Readonly<SocketVector>;
  /** Desired world orientation of the socket; defaults to the animated one. */
  rotation?: Readonly<SocketRotation>;
  socket?: SocketFrame;
  weight?: number;
}
export interface HandChain { upper: string; lower: string; hand: string }
export interface HandPlacementDiagnostic {
  id: string; reachable: boolean; error: number; solvedError: number; orientationError: number;
  requested: SocketVector; actual: SocketVector; upperLength: number; lowerLength: number; warnings: string[];
}
export interface HandPlacementResult { hands: HandPlacementDiagnostic[]; warnings: string[] }
const defaultChains: Readonly<Record<string, HandChain>> = {
  left: { upper: 'left-shoulder', lower: 'left-elbow', hand: 'left-hand' },
  right: { upper: 'right-shoulder', lower: 'right-elbow', hand: 'right-hand' },
};
function uniformPositiveScale(node: Object3D): boolean {
  const elements = node.matrixWorld.elements;
  const x = new Vector3(elements[0], elements[1], elements[2]), y = new Vector3(elements[4], elements[5], elements[6]), z = new Vector3(elements[8], elements[9], elements[10]);
  const size = Math.max(x.length(), y.length(), z.length());
  if (!Number.isFinite(size) || size < 1e-8 || node.matrixWorld.determinant() <= 0
    || Math.max(Math.abs(x.length() - y.length()), Math.abs(x.length() - z.length())) > size * 1e-4
    || Math.max(Math.abs(x.dot(y)), Math.abs(x.dot(z)), Math.abs(y.dot(z))) > size * size * 1e-4) return false;
  // Check every ancestor, not only decomposed world scale: compounded anisotropy
  // can hide shear and invalidate a rigid two-segment solve.
  for (let object: Object3D | null = node; object; object = object.parent) {
    const s = object.scale, high = Math.max(s.x, s.y, s.z);
    if (![s.x, s.y, s.z].every(Number.isFinite) || Math.min(s.x, s.y, s.z) <= 1e-8
      || Math.max(Math.abs(s.x - s.y), Math.abs(s.x - s.z)) > high * 1e-4) return false;
  }
  return true;
}
function setWorldRotation(node: Object3D, desired: Quaternion): void {
  const parent = node.parent?.getWorldQuaternion(new Quaternion()) ?? identity();
  node.quaternion.copy(parent.invert().multiply(desired)).normalize(); node.updateMatrix(); node.updateWorldMatrix(false, true);
}
function alignDirection(node: Object3D, from: Vector3, to: Vector3): void {
  const q = new Quaternion().setFromUnitVectors(from.normalize(), to.normalize()).multiply(node.getWorldQuaternion(new Quaternion()));
  setWorldRotation(node, q);
}
/** Apply after the animation controller/rig has written a fresh pose each frame.
 * Rotates only the selected upper/lower/hand nodes. World translation, rotation
 * and uniform scaling are supported. Unsupported stretch/shear returns a warning
 * without modifying the chain; bone lengths and authoritative roots never move. */
export class HumanoidHandPlacement {
  private readonly chains = new Map<string, { upper: Object3D; lower: Object3D; hand: Object3D }>();
  readonly root: Object3D;
  private last: HandPlacementResult = { hands: [], warnings: [] };
  constructor(rig: { root: Object3D; joints: Readonly<Record<string, Object3D>> }, chains: Readonly<Record<string, HandChain>> = defaultChains) {
    this.root = rig.root;
    if (!Object.keys(chains).length || Object.keys(chains).length > 8) throw new Error('Hand placement requires 1..8 named chains.');
    const used = new Set<Object3D>();
    for (const [id, names] of Object.entries(chains)) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('Invalid hand chain ID.');
      const upper = rig.joints[names.upper], lower = rig.joints[names.lower], hand = rig.joints[names.hand];
      if (!upper || !lower || !hand || lower.parent !== upper || hand.parent !== lower || [upper, lower, hand].some(node => used.has(node)))
        throw new Error(`Hand chain ${id} requires distinct directly connected upper/lower/hand joints.`);
      for (const node of [upper, lower, hand]) used.add(node);
      this.chains.set(id, { upper, lower, hand });
    }
  }
  reset(): void { this.last = { hands: [], warnings: [] }; }
  inspection(): HandPlacementResult { return this.last; }
  apply(targets: Readonly<Record<string, HandPlacementTarget | undefined>>): HandPlacementResult {
    if (Object.keys(targets).length > 8) throw new Error('Hand placement supports at most eight targets.');
    // Validate the complete request before changing a rig.
    for (const [id, target] of Object.entries(targets)) if (target) {
      if (!this.chains.has(id)) throw new Error(`Unknown hand placement chain ${id}.`);
      finiteVector(target.position, 'target'); finiteVector(target.pole, 'pole'); rotation(target.rotation); socketMatrix(target.socket ?? {});
      if (!Number.isFinite(target.weight ?? 1) || (target.weight ?? 1) < 0 || (target.weight ?? 1) > 1) throw new Error('Hand placement weight must be within 0..1.');
    }
    this.root.updateWorldMatrix(true, true);
    const result: HandPlacementResult = { hands: [], warnings: [] };
    for (const [id, target] of Object.entries(targets)) {
      if (!target) continue;
      const { upper, lower, hand } = this.chains.get(id)!, warnings: string[] = [];
      const requested = xyz(target.position), original = socketWorld(hand, target.socket), weight = target.weight ?? 1;
      const a = upper.getWorldPosition(new Vector3()), b = lower.getWorldPosition(new Vector3()), c = hand.getWorldPosition(new Vector3());
      const upperLength = a.distanceTo(b), lowerLength = b.distanceTo(c);
      const finish = (reachable: boolean, solved: Vector3, desiredRotation: Quaternion) => {
        const actual = socketWorld(hand, target.socket);
        result.hands.push({ id, reachable, error: actual.position.distanceTo(requested), solvedError: actual.position.distanceTo(solved),
          orientationError: actual.rotation.angleTo(desiredRotation), requested: plain(requested), actual: plain(actual.position), upperLength, lowerLength, warnings });
        result.warnings.push(...warnings.map(warning => `${id}:${warning}`));
      };
      const solved = original.position.clone().lerp(requested, weight);
      const desiredRotation = original.rotation.clone().slerp(target.rotation ? rotation(target.rotation) : original.rotation, weight);
      if (![upper, lower, hand].every(uniformPositiveScale) || Math.min(upperLength, lowerLength) < 1e-6) {
        warnings.push('unsupported-stretched-or-degenerate-chain'); finish(false, solved, desiredRotation); continue;
      }
      if (!weight) { finish(true, solved, desiredRotation); continue; }
      const handRotation = desiredRotation.clone().multiply(rotation(target.socket?.rotation).invert());
      const handScale = hand.getWorldScale(new Vector3()).x;
      const offset = xyz(target.socket?.position ?? { x: 0, y: 0, z: 0 }).multiplyScalar(handScale).applyQuaternion(handRotation);
      const wrist = solved.clone().sub(offset), direction = wrist.clone().sub(a), requestedDistance = direction.length();
      if (requestedDistance < 1e-8) direction.copy(c).sub(a);
      if (direction.lengthSq() < 1e-12) direction.set(0, 0, 1);
      direction.normalize();
      const minimum = Math.abs(upperLength - lowerLength) + 1e-6, maximum = upperLength + lowerLength - 1e-6;
      const distance = Math.max(minimum, Math.min(maximum, requestedDistance));
      const reachable = requestedDistance >= minimum && requestedDistance <= maximum;
      if (!reachable) warnings.push('target-out-of-reach');
      const bend = xyz(target.pole).sub(a).addScaledVector(direction, -xyz(target.pole).sub(a).dot(direction));
      if (bend.lengthSq() < 1e-10) {
        bend.copy(b).sub(a).addScaledVector(direction, -b.clone().sub(a).dot(direction)); warnings.push('pole-collinear');
        if (bend.lengthSq() < 1e-10) {
          const axis = Math.abs(direction.y) < .9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
          bend.crossVectors(direction, axis);
        }
      }
      bend.normalize();
      const along = (upperLength * upperLength - lowerLength * lowerLength + distance * distance) / (2 * distance);
      const out = Math.sqrt(Math.max(0, upperLength * upperLength - along * along));
      const elbow = a.clone().addScaledVector(direction, along).addScaledVector(bend, out);
      const end = a.clone().addScaledVector(direction, distance);
      alignDirection(upper, b.clone().sub(a), elbow.clone().sub(a));
      const afterB = lower.getWorldPosition(new Vector3()), afterC = hand.getWorldPosition(new Vector3());
      alignDirection(lower, afterC.sub(afterB), end.sub(afterB));
      setWorldRotation(hand, handRotation);
      finish(reachable, solved, desiredRotation);
    }
    if (isInspectionFrameActive()) {
      const owner = getInspectionOwner(this.root);
      // Constructors can warm up the rig before it belongs to a scene/player.
      // Those discarded setup poses are not evidence of the rendered actor.
      let bound = false;
      for (let node: Object3D | null = this.root; node; node = node.parent)
        if (node.type === 'Scene' || typeof node.userData.inspectionActorId === 'string' && node.userData.inspectionActorId.length > 0) { bound = true; break; }
      for (const hand of bound ? result.hands : []) recordInspectionHandConstraint({ actorId: owner?.actorId,
        constraintId: owner ? hand.id : `${this.root.name || 'unowned-rig'}:${this.root.id}/${hand.id}`.slice(0, 160),
        weight: targets[hand.id]?.weight ?? 1, reachable: hand.reachable, requestedError: hand.error,
        solvedError: hand.solvedError, orientationError: hand.orientationError, warnings: hand.warnings });
    }
    this.last = result; return result;
  }
}

export interface EquipmentModelOptions {
  color?: number | string; metalColor?: number | string; scale?: number; markers?: boolean; orientationId?: string;
  /** Shared carry response; defaults to heavy for swords and medium for bows. */
  weight?: EquipmentWeight;
  /** 0..1, default 1. Allows custom animation to reduce or bypass carry response. */
  motionInfluence?: number;
}
export interface EquipmentSockets { primaryGrip: SocketFrame; secondaryGrip: SocketFrame; aim: SocketFrame }
export interface EquipmentSocketInspection { position: SocketVector; forward: SocketVector }
export interface SwordEquipmentModel {
  root: Group;
  sockets: EquipmentSockets;
  markers: Group;
  inspection(): Record<string, EquipmentSocketInspection>;
  dispose(): void;
}
export interface BowEquipmentInspection {
  draw: number; arrowVisible: boolean; sockets: Record<string, EquipmentSocketInspection>;
}
export interface BowEquipmentModel {
  root: Group;
  sockets: EquipmentSockets;
  markers: Group;
  arrow: Group;
  /** Update the string, nock, arrow and authored markers together; draw is 0..1. */
  setDraw(amount: number, arrowVisible?: boolean): void;
  inspection(): BowEquipmentInspection;
  dispose(): void;
}
function modelBase(options: EquipmentModelOptions) {
  if (options.weight !== undefined && !['medium', 'heavy', 'xheavy'].includes(options.weight)) throw new Error('Equipment weight must be medium, heavy or xheavy.');
  if (options.motionInfluence !== undefined && (!Number.isFinite(options.motionInfluence) || options.motionInfluence < 0 || options.motionInfluence > 1))
    throw new Error('Equipment motionInfluence must be within 0..1.');
  const root = new Group(), markers = new Group(); markers.name = 'equipment-socket-markers'; markers.visible = options.markers ?? false;
  const scale = options.scale ?? 1;
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1000) throw new Error('Equipment model scale must be within (0, 1000].');
  root.scale.setScalar(scale);
  const geometry = new BoxGeometry(1, 1, 1), materials: Material[] = [], extra: { dispose(): void }[] = [];
  const paint = (color: number | string, metalness = 0) => {
    const material = new MeshStandardMaterial({ color, roughness: metalness ? .4 : .8, metalness }); materials.push(material); return material;
  };
  const wood = paint(options.color ?? 0x815433), metal = paint(options.metalColor ?? 0xb5c3c1, .6), string = paint(0xe8debd);
  const box = (name: string, width: number, height: number, depth: number, x: number, y: number, z: number, material = wood) => {
    const mesh = new Mesh(geometry, material); mesh.name = name; mesh.scale.set(width, height, depth); mesh.position.set(x, y, z);
    mesh.castShadow = mesh.receiveShadow = true; root.add(mesh); return mesh;
  };
  const segment = (mesh: Object3D, a: Vector3, b: Vector3, thickness: number) => {
    mesh.position.copy(a).add(b).multiplyScalar(.5); mesh.scale.set(thickness, a.distanceTo(b), thickness);
    mesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), b.clone().sub(a).normalize());
  };
  const markerMap = new Map<string, AxesHelper>();
  const syncMarkers = (sockets: Readonly<Record<string, SocketFrame>>) => {
    for (const [name, frame] of Object.entries(sockets)) {
      let marker = markerMap.get(name);
      if (!marker) { marker = new AxesHelper(.16); marker.name = name; markers.add(marker); markerMap.set(name, marker); }
      marker.position.copy(xyz(frame.position ?? { x: 0, y: 0, z: 0 })); marker.quaternion.copy(rotation(frame.rotation));
    }
  };
  const inspection = (sockets: Readonly<Record<string, SocketFrame>>) => Object.fromEntries(Object.entries(sockets).map(([name, socket]) => {
    const world = socketWorld(root, socket); return [name, { position: plain(world.position), forward: plain(world.forward) }];
  }));
  root.add(markers);
  let disposed = false;
  const dispose = () => { if (disposed) return; disposed = true; root.removeFromParent(); geometry.dispose(); materials.forEach(material => material.dispose());
    extra.forEach(resource => resource.dispose()); markerMap.forEach(marker => { marker.geometry.dispose(); for (const material of Array.isArray(marker.material) ? marker.material : [marker.material]) material.dispose(); }); };
  return { root, markers, box, segment, wood, metal, string, extra, syncMarkers, inspection, dispose };
}
/** Editable reference sword: the handle center is the origin, blade is +Y.
 * Grip and aim sockets explicitly declare that their forward axis follows it. */
export function createSwordModel(options: EquipmentModelOptions = {}): SwordEquipmentModel {
  const model = modelBase(options); model.root.name = 'socket-sword';
  model.box('sword-grip', .065, .20, .065, 0, 0, 0);
  model.box('sword-pommel', .09, .065, .09, 0, -.12, 0, model.metal);
  model.box('sword-guard', .29, .045, .095, 0, .13, 0, model.metal);
  model.box('sword-blade', .075, .69, .025, 0, .49, 0, model.metal);
  const tip = model.box('sword-tip', .05, .11, .025, -.012, .885, 0, model.metal); tip.rotation.z = -.22;
  const forward = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
  const q = { x: forward.x, y: forward.y, z: forward.z, w: forward.w };
  const sockets = { primaryGrip: { position: { x: 0, y: 0, z: 0 }, rotation: q },
    secondaryGrip: { position: { x: 0, y: -.09, z: 0 }, rotation: q }, aim: { position: { x: 0, y: .94, z: 0 }, rotation: q } };
  model.syncMarkers(sockets);
  registerInspectionEquipment(model.root, [
    { id: 'grip', node: model.root, a: { x: 0, y: -.10, z: 0 }, b: { x: 0, y: .10, z: 0 }, radius: .0325, allowedBodyParts: ['left-hand', 'right-hand'] },
    { id: 'blade', node: model.root, a: { x: 0, y: .17, z: 0 }, b: { x: 0, y: .91, z: 0 }, radius: .025 },
    { id: 'guard', node: model.root, a: { x: -.12, y: .13, z: 0 }, b: { x: .12, y: .13, z: 0 }, radius: .0225 },
  ]);
  const unregisterOrientation = registerEquipmentOrientation(model.root, {
    id: options.orientationId ?? 'sword', grip: 'grip', weight: options.weight ?? 'heavy', motionInfluence: options.motionInfluence,
    points: [
      { id: 'grip', tags: ['grip'], position: { x: 0, y: 0, z: 0 } },
      { id: 'tip', tags: ['tip', 'blade'], position: { x: 0, y: .94, z: 0 } },
      { id: 'blade-center', tags: ['blade'], position: { x: 0, y: .49, z: 0 } },
      { id: 'edge-left', tags: ['sharp-edge'], position: { x: -.0375, y: .49, z: 0 } },
      { id: 'edge-right', tags: ['sharp-edge'], position: { x: .0375, y: .49, z: 0 } },
      { id: 'face-front', tags: ['flat-face'], position: { x: 0, y: .49, z: .0125 } },
      { id: 'face-back', tags: ['flat-face'], position: { x: 0, y: .49, z: -.0125 } },
    ],
    directions: [
      { id: 'blade-length', tags: ['tip', 'blade'], from: 'grip', to: 'tip', motionPoint: 'tip' },
      { id: 'edge-left', tags: ['sharp-edge'], from: 'blade-center', to: 'edge-left', motionPoint: 'tip' },
      { id: 'edge-right', tags: ['sharp-edge'], from: 'blade-center', to: 'edge-right', motionPoint: 'tip' },
      { id: 'face-front', tags: ['flat-face'], from: 'blade-center', to: 'face-front', motionPoint: 'tip' },
      { id: 'face-back', tags: ['flat-face'], from: 'blade-center', to: 'face-back', motionPoint: 'tip' },
    ],
  });
  const orientationMarkers = options.markers ? createEquipmentOrientationMarkers(model.root) : undefined;
  if (orientationMarkers) model.markers.add(orientationMarkers.root);
  return { root: model.root, sockets, markers: model.markers, inspection: () => model.inspection(sockets),
    dispose: () => { orientationMarkers?.dispose(); unregisterOrientation(); model.dispose(); } };
}
/** Editable reference bow: +Y limbs, +Z shot, wood handle at the origin.
 * secondaryGrip is the nock/string apex. Its arrow rest sits above the holding
 * palm and beside the wooden limb, so the shaft clears both throughout draw. */
export function createBowModel(options: EquipmentModelOptions = {}): BowEquipmentModel {
  const model = modelBase(options); model.root.name = 'socket-bow';
  model.box('bow-wood-grip', .065, .19, .065, 0, 0, 0);
  model.box('bow-arrow-rest', .065, .015, .06, .04, .10, 0);
  const tips = [-1, 1].map(side => new Vector3(0, side * .58, -.16));
  for (const [index, side] of [-1, 1].entries()) {
    const points = [new Vector3(0, side * .08, 0), new Vector3(0, side * .32, -.025), tips[index]];
    for (let part = 1; part < points.length; part++) model.segment(model.box(`bow-limb-${index}-${part}`, 1, 1, 1, 0, 0, 0), points[part - 1], points[part], .045);
  }
  const strings = tips.map((_, index) => model.box('bow-string-' + index, 1, 1, 1, 0, 0, 0, model.string));
  const arrow = new Group(); arrow.name = 'nocked-arrow'; model.root.add(arrow);
  const nockMarker = new Object3D(); nockMarker.name = 'bow-nock-landmark'; model.root.add(nockMarker);
  const shaftGeometry = new CylinderGeometry(.012, .012, .72, 5), tipGeometry = new ConeGeometry(.035, .10, 4);
  model.extra.push(shaftGeometry, tipGeometry);
  const shaft = new Mesh(shaftGeometry, model.wood), arrowTip = new Mesh(tipGeometry, model.metal);
  shaft.rotation.x = arrowTip.rotation.x = Math.PI / 2; shaft.position.z = .36; arrowTip.position.z = .77;
  arrow.add(shaft, arrowTip);
  const sockets = { primaryGrip: { position: { x: 0, y: 0, z: 0 } },
    secondaryGrip: { position: { x: .055, y: .12, z: -.16 } }, aim: { position: { x: .055, y: .12, z: .61 } } };
  let draw = 0;
  let orientationMarkers: ReturnType<typeof createEquipmentOrientationMarkers> | undefined;
  const setDraw = (amount: number, arrowVisible = true) => {
    if (!Number.isFinite(amount)) throw new Error('Bow draw amount must be finite.');
    draw = Math.max(0, Math.min(1, amount));
    sockets.secondaryGrip.position.z = -.16 - draw * .38;
    const nock = xyz(sockets.secondaryGrip.position);
    tips.forEach((tip, index) => model.segment(strings[index], tip, nock, .003));
    arrow.position.copy(nock); arrow.visible = arrowVisible;
    nockMarker.position.copy(nock);
    sockets.aim.position.z = nock.z + .77; model.syncMarkers(sockets);
    orientationMarkers?.update();
  };
  setDraw(0);
  const solids: InspectionCapsule[] = [
    { id: 'grip', node: model.root, a: { x: 0, y: -.08, z: 0 }, b: { x: 0, y: .08, z: 0 }, radius: .0325, allowedBodyParts: ['left-hand', 'right-hand'] },
    // Nock contact with the drawing hand is intentional. The other solid
    // limbs still check head, torso and arms normally; strings are not solids.
    { id: 'arrow', node: arrow, a: { x: 0, y: 0, z: .08 }, b: { x: 0, y: 0, z: .80 }, radius: .012, allowedBodyParts: ['left-hand', 'right-hand'] },
  ];
  for (const side of [-1, 1]) {
    solids.push({ id: `limb-${side}-lower`, node: model.root, a: { x: 0, y: side * .08, z: 0 }, b: { x: 0, y: side * .32, z: -.025 }, radius: .0225 });
    solids.push({ id: `limb-${side}-upper`, node: model.root, a: { x: 0, y: side * .32, z: -.025 }, b: { x: 0, y: side * .58, z: -.16 }, radius: .0225 });
  }
  registerInspectionEquipment(model.root, solids);
  const unregisterOrientation = registerEquipmentOrientation(model.root, {
    id: options.orientationId ?? 'bow', grip: 'grip', weight: options.weight ?? 'medium', motionInfluence: options.motionInfluence,
    points: [
      { id: 'grip', tags: ['grip'], position: { x: 0, y: 0, z: 0 } },
      { id: 'upper-limb-tip', tags: ['limb', 'tip'], position: { x: 0, y: .58, z: -.16 } },
      { id: 'lower-limb-tip', tags: ['limb', 'tip'], position: { x: 0, y: -.58, z: -.16 } },
      { id: 'nock', tags: ['string', 'secondary-grip'], node: nockMarker, position: { x: 0, y: 0, z: 0 } },
      { id: 'shot-forward', tags: ['aim'], node: nockMarker, position: { x: 0, y: 0, z: .82 } },
      { id: 'arrow-tip', tags: ['arrow', 'tip'], node: arrow, position: { x: 0, y: 0, z: .82 } },
    ],
    directions: [
      { id: 'shot', tags: ['aim', 'projectile'], from: 'nock', to: 'shot-forward', motionPoint: 'arrow-tip' },
      { id: 'limb-up', tags: ['up', 'limb'], from: 'lower-limb-tip', to: 'upper-limb-tip', motionPoint: 'upper-limb-tip' },
      { id: 'string-pull', tags: ['draw', 'string'], from: 'shot-forward', to: 'nock', motionPoint: 'nock' },
    ],
  });
  if (options.markers) { orientationMarkers = createEquipmentOrientationMarkers(model.root); model.markers.add(orientationMarkers.root); }
  return { root: model.root, sockets, markers: model.markers, arrow, setDraw,
    inspection: () => ({ draw, arrowVisible: arrow.visible, sockets: model.inspection(sockets) }),
    dispose: () => { orientationMarkers?.dispose(); unregisterOrientation(); model.dispose(); } };
}


export interface BowHandPlacementOptions {
  primary: Omit<HandPlacementTarget, 'pole'> & { pole?: Readonly<SocketVector> };
  secondary?: {
    pole?: Readonly<SocketVector>; socket?: SocketFrame; rotation?: Readonly<SocketRotation>; weight?: number;
    /** Follow-through from the actual nock, in its local axes and authored model
     * units. Bow/actor world scale is applied exactly once. Defaults to zero. */
    offset?: Readonly<SocketVector>;
  };
  draw?: number;
  arrowVisible?: boolean;
}
/** Two-pass constraint for an attached bow. Solve its actual holding hand first,
 * then place the other palm on the resulting string/nock frame. This avoids
 * duplicating grip algebra or chasing an unreachable theoretical model pose.
 * The caller owns the primary hold/aim frame and action timing; both poles and
 * palm frames are editable. secondary.offset adds release follow-through in the
 * actual nock frame, including bow/actor scale, before the single right-hand
 * solve. Inspect the returned errors before accepting poses. */
export function placeBowHands(placer: HumanoidHandPlacement,
  bow: Pick<BowEquipmentModel, 'root' | 'sockets' | 'setDraw'>, options: BowHandPlacementOptions): HandPlacementResult {
  if (options.secondary?.offset) finiteVector(options.secondary.offset, 'secondary offset');
  if (options.draw !== undefined) bow.setDraw(options.draw, options.arrowVisible ?? true);
  placer.root.updateWorldMatrix(true, true);
  const defaultPole = (side: number) => placer.root.localToWorld(new Vector3(side * .85, 1.3, -.12));
  const first = placer.apply({ left: { ...options.primary, pole: options.primary.pole ?? defaultPole(-1) } });
  const actual = socketWorld(bow.root, bow.sockets.secondaryGrip);
  if (options.secondary?.offset) actual.position.copy(xyz(options.secondary.offset)
    .applyMatrix4(bow.root.matrixWorld.clone().multiply(socketMatrix(bow.sockets.secondaryGrip))));
  const second = placer.apply({ right: { position: actual.position, rotation: options.secondary?.rotation ?? actual.rotation,
    pole: options.secondary?.pole ?? defaultPole(1), socket: options.secondary?.socket, weight: options.secondary?.weight } });
  return { hands: [...first.hands, ...second.hands], warnings: [...first.warnings, ...second.warnings] };
}
