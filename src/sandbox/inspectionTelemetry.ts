/** Opt-in only at the renderer boundary, automatic for every shared actor.
 * Normal gameplay pays one boolean check, with no pose capture or allocation. */
import type { ActorPresentationSignals, AnimationPose } from './animation.ts';
import type { ActorAnimationResult } from './actorAnimation.ts';
import type { InspectionActorSample, InspectionCoverageSample, InspectionEquipmentMotion, InspectionEquipmentSample, InspectionHandConstraintSample, InspectionOverlapSample, InspectionTelemetryFrame } from '../shared/inspectionTrace.ts';

let current: InspectionTelemetryFrame | undefined;
let paused = false;
let previousTime = -Infinity;
const actorEpochs = new Map<string, InspectionActorSample['epoch']>();
const validLabel = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 160;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const optionalNumber = (value: unknown) => value === undefined || finite(value);
const optionalBoolean = (value: unknown) => value === undefined || typeof value === 'boolean';
const validVector = (value: { x: number; y: number; z: number } | undefined) => value === undefined
  || !!value && finite(value.x) && finite(value.y) && finite(value.z);
function validEquipmentMotion(value: InspectionEquipmentMotion | undefined): boolean {
  return value === undefined || !!value && Number.isInteger(value.loadCount) && value.loadCount >= 0 && value.loadCount <= 16
    && Number.isInteger(value.jointCount) && value.jointCount >= 0 && value.jointCount <= 64
    && Array.isArray(value.loads) && value.loads.length <= Math.min(value.loadCount, 8)
    && value.loads.every(load => load && validLabel(load.id) && ['medium', 'heavy', 'xheavy'].includes(load.weight)
      && finite(load.influence) && load.influence >= 0 && load.influence <= 1
      && Array.isArray(load.joints) && load.joints.length <= 8 && load.joints.every(validLabel))
    && Array.isArray(value.joints) && value.joints.length <= Math.min(value.jointCount, 8)
    && value.joints.every(joint => joint && validLabel(joint.joint) && finite(joint.responseMs) && joint.responseMs >= 0
      && finite(joint.lagRadians) && joint.lagRadians >= 0);
}
function cloneEquipmentMotion(value: InspectionEquipmentMotion): InspectionEquipmentMotion {
  return { loadCount: value.loadCount, jointCount: value.jointCount,
    loads: value.loads.map(load => ({ id: load.id, weight: load.weight, influence: load.influence, joints: load.joints.slice() })),
    joints: value.joints.map(joint => ({ joint: joint.joint, responseMs: joint.responseMs, lagRadians: joint.lagRadians })) };
}
export function isInspectionFrameActive(): boolean { return current !== undefined; }
export function beginInspectionFrame(timeMs: number, presentationPaused = false): void {
  if (!Number.isFinite(timeMs) || timeMs <= previousTime || timeMs - previousTime > 250) actorEpochs.clear();
  previousTime = timeMs;
  paused = presentationPaused;
  current = { timeMs: Number.isFinite(timeMs) ? timeMs : 0, actors: [], overlaps: [], equipment: [], handConstraints: [], coverage: [], truncated: !Number.isFinite(timeMs) };
}
export function endInspectionFrame(): InspectionTelemetryFrame {
  const frame = current ?? { timeMs: 0, actors: [], overlaps: [], coverage: [], truncated: true };
  for (const sample of [...frame.overlaps, ...frame.handConstraints ?? []]) if (sample.actorId !== undefined) {
    const actor = frame.actors.find(value => value.actorId === sample.actorId);
    if (sample.activeAction === undefined && actor?.activeAction !== undefined) sample.activeAction = paused ? false : actor.activeAction;
    if (sample.activeClips === undefined && actor?.activeClips) sample.activeClips = paused ? [] : actor.activeClips.slice();
  }
  for (const item of frame.equipment ?? []) if (item.actorId !== undefined) {
    const actor = frame.actors.find(value => value.actorId === item.actorId);
    if (item.activeAction === undefined && actor?.activeAction !== undefined) item.activeAction = paused ? false : actor.activeAction;
    if (item.activeClips === undefined && actor?.activeClips) item.activeClips = paused ? [] : actor.activeClips.slice();
    if (actor && (actor.reset || actor.resetReason !== undefined && actor.resetReason !== null
      || actorEpochs.has(actor.actorId) && actorEpochs.get(actor.actorId) !== actor.epoch)) {
      for (const point of item.points) { delete point.velocity; delete point.gripRelativeVelocity; delete point.ownerRelativeVelocity; }
      for (const direction of item.directions) { delete direction.worldAlignment; delete direction.gripRelativeAlignment; delete direction.ownerRelativeAlignment; }
    }
  }
  for (const actor of frame.actors) if (actorEpochs.has(actor.actorId) || actorEpochs.size < 64) actorEpochs.set(actor.actorId, actor.epoch);
  current = undefined; paused = false; return frame;
}
/** The collector deliberately uses small runtime guards rather than importing
 * report validation (and Zod) into every game's view worker. */
export function recordInspectionEquipment(sample: InspectionEquipmentSample): void {
  if (!current) return;
  try {
    const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 64;
    const tags = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 8
      && value.every(tag => typeof tag === 'string' && tag.length > 0 && tag.length <= 32);
    const alignment = (value: unknown) => value === undefined || finite(value) && value >= -1 && value <= 1;
    const valid = sample && typeof sample.itemId === 'string' && sample.itemId.length > 0 && sample.itemId.length <= 128
      && (sample.actorId === undefined || validLabel(sample.actorId)) && finite(sample.timeMs) && id(sample.grip)
      && (sample.weight === undefined || ['medium', 'heavy', 'xheavy'].includes(sample.weight))
      && (sample.motionInfluence === undefined || finite(sample.motionInfluence) && sample.motionInfluence >= 0 && sample.motionInfluence <= 1)
      && Array.isArray(sample.points) && sample.points.length <= 16 && sample.points.every(point => point && id(point.id)
        && tags(point.tags) && point.position !== undefined && validVector(point.position) && typeof point.visible === 'boolean'
        && validVector(point.velocity) && validVector(point.gripRelativeVelocity) && validVector(point.ownerRelativeVelocity))
      && Array.isArray(sample.directions) && sample.directions.length <= 16 && sample.directions.every(direction => direction && id(direction.id)
        && tags(direction.tags) && id(direction.from) && id(direction.to) && id(direction.motionPoint)
        && direction.direction !== undefined && validVector(direction.direction)
        && alignment(direction.worldAlignment) && alignment(direction.gripRelativeAlignment) && alignment(direction.ownerRelativeAlignment))
      && ['supported', 'partial'].includes(sample.coverage) && optionalBoolean(sample.activeAction)
      && (sample.activeClips === undefined || Array.isArray(sample.activeClips) && sample.activeClips.length <= 8 && sample.activeClips.every(validLabel))
      && Array.isArray(sample.warnings) && sample.warnings.length <= 16
      && sample.warnings.every(warning => typeof warning === 'string' && warning.length <= 160);
    if (!valid) {
      current.truncated = true;
      recordInspectionCoverage({ ...(sample && validLabel(sample.actorId) ? { actorId: sample.actorId } : {}),
        check: 'equipment-orientation', status: 'unsupported', reason: 'Malformed equipment orientation telemetry was discarded.' });
      return;
    }
    const cloneVector = (value: { x: number; y: number; z: number } | undefined) => value && { x: value.x, y: value.y, z: value.z };
    const item: InspectionEquipmentSample = { itemId: sample.itemId, actorId: sample.actorId, timeMs: sample.timeMs, grip: sample.grip,
      weight: sample.weight, motionInfluence: sample.motionInfluence,
      points: sample.points.map(point => ({ id: point.id, tags: point.tags.slice(), position: cloneVector(point.position)!, visible: point.visible,
        velocity: cloneVector(point.velocity), gripRelativeVelocity: cloneVector(point.gripRelativeVelocity), ownerRelativeVelocity: cloneVector(point.ownerRelativeVelocity) })),
      directions: sample.directions.map(direction => ({ id: direction.id, tags: direction.tags.slice(), from: direction.from, to: direction.to,
        direction: cloneVector(direction.direction)!, motionPoint: direction.motionPoint, worldAlignment: direction.worldAlignment,
        gripRelativeAlignment: direction.gripRelativeAlignment, ownerRelativeAlignment: direction.ownerRelativeAlignment })),
      coverage: sample.coverage, warnings: sample.warnings.slice(), activeAction: paused ? false : sample.activeAction,
      activeClips: paused ? [] : sample.activeClips?.slice() };
    const equipment = current.equipment ??= [];
    const index = equipment.findIndex(value => value.actorId === item.actorId && value.itemId === item.itemId);
    if (index >= 0) equipment[index] = item;
    else if (equipment.length < 64) equipment.push(item);
    else current.truncated = true;
  } catch { current.truncated = true; }
}
export function recordInspectionActor(sample: InspectionActorSample): void {
  if (!current) return;
  try {
    if (!sample || !validLabel(sample.actorId) || !finite(sample.timeMs)
      || ![sample.sourceDurationMs, sample.observedSpeed, sample.intendedSpeed, sample.playbackRate].every(value => optionalNumber(value) && (value === undefined || value >= 0))
      || !(sample.sourceTimeMs === null || optionalNumber(sample.sourceTimeMs))
      || ![sample.reset, sample.grounded, sample.loop, sample.idle, sample.holdsEnd, sample.switched, sample.activeAction].every(optionalBoolean)
      || sample.source !== undefined && sample.source !== null && !validLabel(sample.source)
      || sample.posture !== undefined && !validLabel(sample.posture)
      || sample.epoch !== undefined && !validLabel(sample.epoch) && !finite(sample.epoch)
      || sample.resetReason !== undefined && sample.resetReason !== null && (typeof sample.resetReason !== 'string' || sample.resetReason.length > 32)
      || !validVector(sample.intendedVelocity) || !['applied-rig', 'composed-pose', 'unavailable'].includes(sample.poseBasis)
      || sample.pose !== undefined && (!Array.isArray(sample.pose) || sample.pose.length > 1280 || !sample.pose.every(finite))
      || sample.activeClips !== undefined && (!Array.isArray(sample.activeClips) || sample.activeClips.length > 8 || !sample.activeClips.every(validLabel))
      || !validEquipmentMotion(sample.equipmentMotion)
      || !Array.isArray(sample.warnings) || sample.warnings.length > 12 || sample.warnings.some(warning => typeof warning !== 'string' || warning.length > 200)
      || sample.sourceDurationMs === 0) { current.truncated = true; return; }
    const value: InspectionActorSample = { actorId: sample.actorId, timeMs: sample.timeMs, epoch: sample.epoch,
      reset: sample.reset, resetReason: sample.resetReason, posture: sample.posture,
      observedSpeed: sample.observedSpeed, intendedSpeed: sample.intendedSpeed, intendedVelocity: sample.intendedVelocity && { ...sample.intendedVelocity },
      grounded: sample.grounded, source: sample.source, sourceTimeMs: sample.sourceTimeMs, sourceDurationMs: sample.sourceDurationMs,
      loop: sample.loop, idle: sample.idle, holdsEnd: sample.holdsEnd, playbackRate: paused ? 0 : sample.playbackRate,
      switched: sample.switched, activeAction: sample.activeAction, activeClips: paused ? [] : sample.activeClips?.slice(),
      equipmentMotion: sample.equipmentMotion && cloneEquipmentMotion(sample.equipmentMotion),
      pose: sample.pose?.slice(), poseBasis: sample.poseBasis, warnings: sample.warnings.slice() };
    const index = current.actors.findIndex(actor => actor.actorId === value.actorId);
    if (index >= 0) current.actors[index] = value;
    else if (current.actors.length < 64) current.actors.push(value);
    else current.truncated = true;
  } catch { current.truncated = true; }
}
export function recordInspectionOverlap(sample: InspectionOverlapSample): void {
  if (!current) return;
  try {
    const valid = sample && validLabel(sample.actorId) && validLabel(sample.pair) && finite(sample.timeMs) && finite(sample.depth) && sample.depth >= 0
      && ['equipment-body', 'equipment-ground', 'body-ground', 'custom'].includes(sample.kind) && validVector(sample.position)
      && ['capsule-proxy', 'bounds-proxy', 'exact'].includes(sample.approximation)
      && (sample.intent === undefined || ['unexpected', 'unknown', 'allowed'].includes(sample.intent))
      && optionalBoolean(sample.activeAction) && (sample.activeClips === undefined || Array.isArray(sample.activeClips)
        && sample.activeClips.length <= 8 && sample.activeClips.every(validLabel));
    if (valid && current.overlaps.length < 128) current.overlaps.push({ actorId: sample.actorId, pair: sample.pair, kind: sample.kind,
      timeMs: sample.timeMs, depth: sample.depth, position: sample.position && { ...sample.position }, approximation: sample.approximation, intent: sample.intent,
      activeAction: sample.activeAction, activeClips: sample.activeClips?.slice() });
    else current.truncated = true;
  } catch { current.truncated = true; }
}
/** Automatic shared-solver hook. The collector supplies inspection time and
 * associates action context after the complete actor update, without requiring
 * a game's optional inspection() payload or extra builder instrumentation. */
export function recordInspectionHandConstraint(sample: Omit<InspectionHandConstraintSample, 'timeMs'>): void {
  if (!current) return;
  try {
    const valid = sample && (sample.actorId === undefined || validLabel(sample.actorId)) && validLabel(sample.constraintId)
      && finite(sample.weight) && sample.weight >= 0 && sample.weight <= 1 && typeof sample.reachable === 'boolean'
      && [sample.requestedError, sample.solvedError, sample.orientationError].every(value => finite(value) && value >= 0)
      && optionalBoolean(sample.activeAction) && (sample.activeClips === undefined || Array.isArray(sample.activeClips)
        && sample.activeClips.length <= 8 && sample.activeClips.every(validLabel))
      && Array.isArray(sample.warnings) && sample.warnings.length <= 8
      && sample.warnings.every(value => typeof value === 'string' && value.length <= 160);
    if (!valid) {
      current.truncated = true;
      recordInspectionCoverage({ check: 'hand-constraints', status: 'unsupported', reason: 'Malformed hand-constraint telemetry was discarded.' }); return;
    }
    const value: InspectionHandConstraintSample = { actorId: sample.actorId, constraintId: sample.constraintId, timeMs: current.timeMs,
      weight: sample.weight, reachable: sample.reachable, requestedError: sample.requestedError,
      solvedError: sample.solvedError, orientationError: sample.orientationError, activeAction: paused ? false : sample.activeAction,
      activeClips: paused ? [] : sample.activeClips?.slice(), warnings: sample.warnings.slice() };
    const records = current.handConstraints ??= [];
    const index = records.findIndex(record => record.actorId === value.actorId && record.constraintId === value.constraintId);
    if (index >= 0) records[index] = value;
    else if (records.length < 128) records.push(value); else current.truncated = true;
  } catch { current.truncated = true; }
}
export function recordInspectionCoverage(sample: InspectionCoverageSample): void {
  if (!current) return;
  try {
    const valid = sample && (sample.actorId === undefined || validLabel(sample.actorId)) && validLabel(sample.check)
      && ['supported', 'unsupported', 'partial'].includes(sample.status)
      && (sample.reason === undefined || typeof sample.reason === 'string' && sample.reason.length <= 240);
    if (valid && current.coverage.length < 128) current.coverage.push({ actorId: sample.actorId, check: sample.check, status: sample.status, reason: sample.reason });
    else current.truncated = true;
  } catch { current.truncated = true; }
}
/** Only an unchanged-pose fingerprint, not reconstructable animation data or
 * a quality score. Two independent words bound collision risk while avoiding
 * hundreds of per-joint numbers crossing the worker boundary every frame. */
export function inspectionPoseFingerprint(pose: AnimationPose): number[] {
  let first = 2166136261, second = 0x9e3779b9, count = 0;
  const mix = (word: number) => { first = Math.imul(first ^ word, 16777619); second = Math.imul(second ^ word, 2246822519); second ^= second >>> 13; };
  const channel = (value: number) => {
    if (!Number.isFinite(value)) throw new Error('Nonfinite inspection pose channel.');
    const quantized = Math.round(value * 1e6);
    mix(quantized | 0); mix(Math.floor(quantized / 0x100000000) | 0); count++;
  };
  for (const name of Object.keys(pose).sort().slice(0, 128)) {
    for (let i = 0; i < name.length; i++) mix(name.charCodeAt(i)); mix(0);
    const joint = pose[name], p = joint.position, q = joint.rotation, s = joint.scale;
    // q and -q represent the same rotation. Canonicalize to avoid false motion.
    const sign = q && q.w < 0 ? -1 : 1;
    for (const value of [p?.x ?? 0, p?.y ?? 0, p?.z ?? 0, (q?.x ?? 0) * sign, (q?.y ?? 0) * sign,
      (q?.z ?? 0) * sign, (q?.w ?? 1) * sign, s?.x ?? 1, s?.y ?? 1, s?.z ?? 1]) channel(value);
  }
  return count ? [first >>> 0, second >>> 0, count] : [];
}
/** Called after afterApply so real rig capture includes hands, contacts and IK.
 * Custom rigs can implement capture(); otherwise evidence is explicitly the
 * composed pose, never mislabeled as the final rendered skeleton. */
export function recordActorAnimationInspection(signals: Readonly<ActorPresentationSignals>, result: Readonly<ActorAnimationResult>,
  rig?: { capture?(): AnimationPose }): void {
  if (!current) return;
  try {
    let pose = result.pose, poseBasis: InspectionActorSample['poseBasis'] = 'composed-pose';
    if (rig?.capture) {
      try { pose = rig.capture(); poseBasis = 'applied-rig'; }
      catch { recordInspectionCoverage({ actorId: signals.id, check: 'applied-pose', status: 'unsupported', reason: 'Custom rig capture failed; composed pose only.' }); }
    }
    const motion = result.diagnostics.locomotion, v = signals.velocity, intent = signals.intendedVelocity;
    const up = signals.up ?? { x: 0, y: 1, z: 0 }, length = Math.hypot(up.x, up.y, up.z) || 1;
    const planar = (value: { x: number; y: number; z: number }) => {
      const vertical = (value.x * up.x + value.y * up.y + value.z * up.z) / length;
      return Math.sqrt(Math.max(0, value.x * value.x + value.y * value.y + value.z * value.z - vertical * vertical));
    };
    const channels = inspectionPoseFingerprint(pose);
    recordInspectionActor({ actorId: signals.id, timeMs: current.timeMs, epoch: signals.epoch,
      reset: result.diagnostics.reset, resetReason: result.diagnostics.resetReason, posture: signals.posture,
      ...(v ? { observedSpeed: planar(v) } : {}), ...(intent ? { intendedSpeed: planar(intent), intendedVelocity: { ...intent } } : {}),
      grounded: signals.grounded, source: motion?.source, sourceTimeMs: motion?.sourceTimeMs,
      sourceDurationMs: motion?.sourceDurationMs, loop: motion?.loop, idle: motion?.idle, holdsEnd: motion?.holdsEnd,
      playbackRate: motion?.playbackRate, switched: motion?.switched,
      activeAction: result.diagnostics.animation.actions.some(action => action.status === 'active'),
      activeClips: [...new Set(result.diagnostics.animation.actions.filter(action => action.status === 'active').map(action => action.clip))].slice(0, 8),
      equipmentMotion: result.diagnostics.equipmentMotion,
      pose: channels, poseBasis: channels.length ? poseBasis : 'unavailable', warnings: result.diagnostics.warnings.slice(0, 12) });
  } catch {
    current.truncated = true;
    recordInspectionCoverage({ actorId: signals.id, check: 'animation', status: 'partial', reason: 'Actor telemetry could not be sampled.' });
  }
}
