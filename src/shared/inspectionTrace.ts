/** Bounded, renderer-independent evidence collected during normal inspections.
 * These checks detect mechanical symptoms, not whether an animation looks good. */
import { z } from 'zod';
import { inspectionGameplayCameraSummarySchema } from './inspectionCamera.ts';

const finite = z.number().finite();
const label = z.string().min(1).max(160);
const vector = z.object({ x: finite, y: finite, z: finite }).strict();
const equipmentWeight = z.enum(['medium', 'heavy', 'xheavy']);
/** Bounded descriptive carry response. Lag is a measurement, never a defect. */
export const inspectionEquipmentMotionSchema = z.object({
  loads: z.array(z.object({ id: label, weight: equipmentWeight, influence: finite.min(0).max(1),
    joints: z.array(label).max(8) }).strict()).max(8),
  loadCount: z.number().int().nonnegative().max(16),
  joints: z.array(z.object({ joint: label, responseMs: finite.nonnegative(), lagRadians: finite.nonnegative() }).strict()).max(8),
  jointCount: z.number().int().nonnegative().max(64),
}).strict();
export type InspectionEquipmentMotion = z.infer<typeof inspectionEquipmentMotionSchema>;
function cloneEquipmentMotion(value: InspectionEquipmentMotion): InspectionEquipmentMotion {
  return { ...value, loads: value.loads.map(load => ({ ...load, joints: load.joints.slice() })), joints: value.joints.map(joint => ({ ...joint })) };
}
export const inspectionActorSampleSchema = z.object({
  actorId: label, timeMs: finite, epoch: z.union([label, finite]).optional(),
  reset: z.boolean().optional(), resetReason: z.string().max(32).nullable().optional(), posture: label.optional(),
  observedSpeed: finite.nonnegative().optional(), intendedSpeed: finite.nonnegative().optional(),
  intendedVelocity: vector.optional(), grounded: z.boolean().optional(),
  source: label.nullable().optional(), sourceTimeMs: finite.nullable().optional(), sourceDurationMs: finite.positive().optional(),
  loop: z.boolean().optional(), idle: z.boolean().optional(), holdsEnd: z.boolean().optional(),
  playbackRate: finite.nonnegative().optional(), switched: z.boolean().optional(), activeAction: z.boolean().optional(),
  activeClips: z.array(label).max(8).optional(),
  equipmentMotion: inspectionEquipmentMotionSchema.optional(),
  // Shared actors emit a three-number unchanged-pose fingerprint. Bounded raw
  // channels remain accepted for adapters and reproducible synthetic probes.
  pose: z.array(finite).max(1280).optional(), poseBasis: z.enum(['applied-rig', 'composed-pose', 'unavailable']),
  warnings: z.array(z.string().max(200)).max(12),
}).strict();
export type InspectionActorSample = z.infer<typeof inspectionActorSampleSchema>;
export const inspectionOverlapSampleSchema = z.object({
  actorId: label, pair: label, kind: z.enum(['equipment-body', 'equipment-ground', 'body-ground', 'custom']),
  timeMs: finite, depth: finite.nonnegative(), position: vector.optional(),
  approximation: z.enum(['capsule-proxy', 'bounds-proxy', 'exact']),
  intent: z.enum(['unexpected', 'unknown', 'allowed']).optional(),
  activeAction: z.boolean().optional(), activeClips: z.array(label).max(8).optional(),
}).strict();
export type InspectionOverlapSample = z.infer<typeof inspectionOverlapSampleSchema>;
/** Every measured contact survives aggregation, including brief contacts and
 * authored exemptions. Adapter intent is evidence, not the builder's verdict. */
export const inspectionOverlapObservationSchema = z.object({
  actorId: label, pair: label, kind: inspectionOverlapSampleSchema.shape.kind,
  approximation: inspectionOverlapSampleSchema.shape.approximation,
  intent: inspectionOverlapSampleSchema.shape.intent.unwrap(),
  fromMs: finite, toMs: finite, samples: z.number().int().positive(), episodes: z.number().int().positive(),
  maxDepth: finite.nonnegative(), peakAtMs: finite, peakPosition: vector.optional(),
  activeAction: z.boolean().optional(), activeClips: z.array(label).max(8).optional(),
}).strict();
export type InspectionOverlapObservation = z.infer<typeof inspectionOverlapObservationSchema>;
const handConstraintMeasurement = z.object({
  weight: finite.min(0).max(1), reachable: z.boolean(), requestedError: finite.nonnegative(),
  solvedError: finite.nonnegative(), orientationError: finite.nonnegative(),
  activeAction: z.boolean().optional(), activeClips: z.array(label).max(8).optional(),
}).strict();
export const inspectionHandConstraintSampleSchema = handConstraintMeasurement.extend({
  actorId: label.optional(), constraintId: label, timeMs: finite,
  warnings: z.array(z.string().max(160)).max(8),
}).strict();
export type InspectionHandConstraintSample = z.infer<typeof inspectionHandConstraintSampleSchema>;
export const inspectionHandConstraintSummarySchema = z.object({
  actorId: label.optional(), constraintId: label, fromMs: finite, toMs: finite,
  samples: z.number().int().positive(), blendedSamples: z.number().int().nonnegative(), unreachableSamples: z.number().int().nonnegative(),
  maxRequestedError: finite.nonnegative(), maxRequestedErrorAtMs: finite,
  maxSolvedError: finite.nonnegative(), maxSolvedErrorAtMs: finite,
  maxOrientationError: finite.nonnegative(), maxOrientationErrorAtMs: finite,
  peak: handConstraintMeasurement.extend({ atMs: finite }).strict(), warnings: z.array(z.string().max(160)).max(8),
}).strict();
export type InspectionHandConstraintSummary = z.infer<typeof inspectionHandConstraintSummarySchema>;
export const inspectionCoverageSampleSchema = z.object({
  actorId: label.optional(), check: label, status: z.enum(['supported', 'unsupported', 'partial']), reason: z.string().max(240).optional(),
}).strict();
export type InspectionCoverageSample = z.infer<typeof inspectionCoverageSampleSchema>;
const orientationId = z.string().min(1).max(64);
const orientationTags = z.array(z.string().min(1).max(32)).max(8);
const alignment = finite.min(-1).max(1);
// Optional in persisted evidence so reports authored before carry weights still read.
const equipmentCarryMetadata = {
  weight: equipmentWeight.optional(), motionInfluence: finite.min(0).max(1).optional(),
};
/** Tagged geometry is sampled after animation and constraints in world space.
 * Relative velocities remove carry motion without inventing an attack intent. */
export const inspectionEquipmentSampleSchema = z.object({
  itemId: z.string().min(1).max(128), actorId: label.optional(), timeMs: finite, grip: orientationId,
  ...equipmentCarryMetadata,
  points: z.array(z.object({ id: orientationId, tags: orientationTags, position: vector, visible: z.boolean(),
    velocity: vector.optional(), gripRelativeVelocity: vector.optional(), ownerRelativeVelocity: vector.optional(),
  }).strict()).max(16),
  directions: z.array(z.object({ id: orientationId, tags: orientationTags, from: orientationId, to: orientationId,
    direction: vector, motionPoint: orientationId, worldAlignment: alignment.optional(),
    gripRelativeAlignment: alignment.optional(), ownerRelativeAlignment: alignment.optional(),
  }).strict()).max(16),
  coverage: z.enum(['supported', 'partial']), warnings: z.array(z.string().max(160)).max(16),
  activeAction: z.boolean().optional(),
  activeClips: z.array(label).max(8).optional(),
}).strict();
export type InspectionEquipmentSample = z.infer<typeof inspectionEquipmentSampleSchema>;
const equipmentMotionSchema = z.object({
  atMs: finite, pointId: orientationId, directionId: orientationId, tags: orientationTags,
  ...equipmentCarryMetadata,
  speed: finite.nonnegative(), alignment, basis: z.enum(['owner-relative', 'grip-relative', 'world']),
  velocity: vector, activeAction: z.boolean().optional(), activeClips: z.array(label).max(8).optional(),
}).strict();
export const inspectionEquipmentSummarySchema = z.object({
  itemId: z.string().min(1).max(128), actorId: label.optional(), samples: z.number().int().nonnegative(),
  /** Most recent authored carry settings; peakMotion retains its own settings. */
  ...equipmentCarryMetadata,
  semanticSignatures: z.array(z.string().min(1).max(32)).min(1).max(8),
  motionSamples: z.number().int().nonnegative(), activeActionSamples: z.number().int().nonnegative(),
  unknownActionSamples: z.number().int().nonnegative(), partialSamples: z.number().int().nonnegative(),
  directionalMotionSamples: z.number().int().nonnegative(), fromMs: finite, toMs: finite,
  maxSpeed: finite.nonnegative(), maxOwnerRelativeSpeed: finite.nonnegative(),
  peakMotion: equipmentMotionSchema.optional(),
}).strict();
export const inspectionTelemetryFrameSchema = z.object({
  timeMs: finite, actors: z.array(inspectionActorSampleSchema).max(64), overlaps: z.array(inspectionOverlapSampleSchema).max(128),
  coverage: z.array(inspectionCoverageSampleSchema).max(128), truncated: z.boolean(),
  equipment: z.array(inspectionEquipmentSampleSchema).max(64).optional(),
  handConstraints: z.array(inspectionHandConstraintSampleSchema).max(128).optional(),
}).strict();
export type InspectionTelemetryFrame = z.infer<typeof inspectionTelemetryFrameSchema>;
export const inspectionTraceFindingSchema = z.object({
  id: label, actorId: label, kind: z.enum(['frozen-source-clock', 'frozen-pose', 'repeated-source-restarts', 'repeated-phase-seeks',
    'unsettled-rest', 'source-churn', 'geometric-overlap', 'constraint-observation', 'camera-observation']), severity: z.enum(['error', 'review']),
  fromMs: finite, toMs: finite, peakAtMs: finite, samples: z.number().int().nonnegative(), message: z.string().max(500),
  source: label.optional(), pair: label.optional(), maxDepth: finite.nonnegative().optional(), approximation: label.optional(),
  poseBasis: z.enum(['applied-rig', 'composed-pose', 'unavailable']).optional(),
  contactIntent: inspectionOverlapSampleSchema.shape.intent.optional(),
}).strict();
export type InspectionTraceFinding = z.infer<typeof inspectionTraceFindingSchema>;
export const inspectionTraceSummarySchema = z.object({
  version: z.literal(1), frames: z.number().int().nonnegative(), fromMs: finite, toMs: finite, truncated: z.boolean(),
  actors: z.array(z.object({ actorId: label, samples: z.number().int().nonnegative(), clockSamples: z.number().int().nonnegative(),
    appliedPoseSamples: z.number().int().nonnegative(), composedPoseSamples: z.number().int().nonnegative(),
    missingSourceMetadataSamples: z.number().int().nonnegative(), missingIntentSamples: z.number().int().nonnegative(),
    /** Latest shared carry response, including actual counts when detail was bounded. */
    equipmentMotion: inspectionEquipmentMotionSchema.optional(),
  }).strict()).max(64),
  coverage: z.array(inspectionCoverageSampleSchema).max(128), findings: z.array(inspectionTraceFindingSchema).max(64),
  equipment: z.array(inspectionEquipmentSummarySchema).max(64).optional(),
  overlapObservations: z.array(inspectionOverlapObservationSchema).max(128).optional(),
  handConstraints: z.array(inspectionHandConstraintSummarySchema).max(128).optional(),
  gameplayCamera: inspectionGameplayCameraSummarySchema.optional(),
  warnings: z.array(z.object({ actorId: label, actorIds: z.array(label).min(1).max(64).optional(), message: z.string().max(200), fromMs: finite, toMs: finite,
    samples: z.number().int().positive() }).strict()).max(64).optional(),
  metrics: z.object({ loopWraps: z.number().int().nonnegative(), sourceRewinds: z.number().int().nonnegative(),
    sourceSwitches: z.number().int().nonnegative(), overlapSamples: z.number().int().nonnegative(),
    ignoredAllowedOverlaps: z.number().int().nonnegative(), invalidFrames: z.number().int().nonnegative(),
  }).strict(),
}).strict();
export type InspectionTraceSummary = z.infer<typeof inspectionTraceSummarySchema>;

type ActorState = { previous?: InspectionActorSample; counter: InspectionTraceSummary['actors'][number];
  clockFrom?: number; poseFrom?: number; restFrom?: number; episode: number; episodeIntent?: InspectionActorSample;
  rewinds: number[]; seeks: number[]; switches: number[]; lastSources: Map<string, { timeMs: number; sourceTimeMs: number }> };
type OverlapState = { fromMs: number; lastMs: number; samples: number; maxDepth: number; peakAtMs: number };
type EquipmentState = { counter: z.infer<typeof inspectionEquipmentSummarySchema> };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
/** A bounded metadata fingerprint, not a source/security receipt. The two words
 * avoid retaining long repeated tag catalogs while making a dropped surface
 * distinguishable from a measured orientation repair in before/after checks. */
function equipmentSemantics(sample: InspectionEquipmentSample): string {
  const text = JSON.stringify({ grip: sample.grip, weight: sample.weight, motionInfluence: sample.motionInfluence,
    points: sample.points.map(point => [point.id, [...point.tags].sort()]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    directions: sample.directions.map(direction => [direction.id, [...direction.tags].sort(), direction.from, direction.to, direction.motionPoint])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  });
  let first = 2166136261, second = 0x9e3779b9;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index); first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ code, 2246822519); second ^= second >>> 13;
  }
  return `v1:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
}
function preferEquipmentMotion(next: z.infer<typeof equipmentMotionSchema>, previous: z.infer<typeof equipmentMotionSchema>): boolean {
  // Item motion relative to its owner is more informative than a faster world
  // translation of the whole character. Keep the reference frame explicit;
  // this ranks descriptive evidence without evaluating the action's purpose.
  const order = { 'owner-relative': 2, 'grip-relative': 1, world: 0 };
  return order[next.basis] !== order[previous.basis] ? order[next.basis] > order[previous.basis]
    : next.alignment * next.speed > previous.alignment * previous.speed;
}
function metadata(sample: InspectionActorSample): boolean {
  return !!sample.source && sample.sourceTimeMs !== null && sample.sourceTimeMs !== undefined
    && sample.sourceDurationMs !== undefined && sample.loop !== undefined;
}
function sameIntent(a: InspectionActorSample, b: InspectionActorSample): boolean {
  if (a.intendedSpeed === undefined || b.intendedSpeed === undefined) {
    // Missing intent remains a coverage gap, but must not erase clock evidence
    // every frame. Split on a clear observed movement change when available.
    if (a.intendedSpeed !== b.intendedSpeed) return false;
    if (a.observedSpeed === undefined || b.observedSpeed === undefined) return true;
    return (a.observedSpeed > .4) === (b.observedSpeed > .4)
      && Math.abs(a.observedSpeed - b.observedSpeed) <= Math.max(.5, Math.max(a.observedSpeed, b.observedSpeed) * .3);
  }
  if ((a.intendedSpeed > .15) !== (b.intendedSpeed > .15)) return false;
  if (Math.abs(a.intendedSpeed - b.intendedSpeed) > Math.max(.5, Math.max(a.intendedSpeed, b.intendedSpeed) * .2)) return false;
  if (a.intendedSpeed > .15 && b.intendedSpeed > .15 && a.intendedVelocity && b.intendedVelocity) {
    const x = a.intendedVelocity, y = b.intendedVelocity;
    return (x.x * y.x + x.y * y.y + x.z * y.z) / Math.max(1e-8, Math.hypot(x.x, x.y, x.z) * Math.hypot(y.x, y.y, y.z)) > .85;
  }
  return true;
}
function poseDistance(a: number[] | undefined, b: number[] | undefined): number {
  if (!a?.length || a.length !== b?.length) return Infinity;
  let distance = 0;
  for (let i = 0; i < a.length; i++) distance = Math.max(distance, Math.abs(a[i] - b[i]));
  return distance;
}
function findingPriority(finding: Pick<InspectionTraceFinding, 'kind' | 'severity' | 'maxDepth' | 'fromMs' | 'toMs' | 'pair'>): number {
  // Ranking only: anatomy hints never suppress or assert the validity of a
  // collision. A brief blade/head strike deserves evidence before a long,
  // shallow carry contact. Duration is only a small tie-breaker.
  const target = finding.pair?.split('/').at(-1) ?? '';
  const criticalContact = /^(?:head|face|neck|eyes?)(?:$|[_.:-])/i.test(target) ? 80 : 0;
  const kind = finding.kind === 'geometric-overlap' ? 80 + criticalContact + Math.min(100, (finding.maxDepth ?? 0) * 1000)
    : finding.kind === 'source-churn' || finding.kind === 'unsettled-rest' ? 30 : 60;
  return (finding.severity === 'error' ? 1000 : 0) + kind + Math.min(1, (finding.toMs - finding.fromMs) / 10000);
}
function boundedCoverage(records: InspectionCoverageSample[], markTruncated: () => void): InspectionCoverageSample[] {
  let result = records;
  // Prefer detailed unsupported actor entries. Common supported checks can be
  // summarized across large rosters; per-actor animation counts stay in actors.
  for (const status of ['supported', 'partial', 'unsupported'] as const) {
    if (result.length <= 128) break;
    const groups = new Map<string, InspectionCoverageSample[]>();
    for (const record of result) if (record.actorId !== undefined && record.status === status) {
      const key = JSON.stringify([record.check, record.status, record.reason]);
      const group = groups.get(key) ?? []; group.push(record); groups.set(key, group);
    }
    for (const group of [...groups.values()].sort((a, b) => b.length - a.length)) {
      if (result.length <= 128) break;
      if (group.length < 2) continue;
      const members = new Set(group), first = group[0];
      result = result.filter(record => !members.has(record));
      result.push({ check: first.check, status, reason: `${group.length} observed actors: ${first.reason ?? status} Detailed animation counts are in actors.`.slice(0, 240) });
    }
  }
  if (result.length > 128) {
    markTruncated();
    result = result.sort((a, b) => Number(a.status === 'supported') - Number(b.status === 'supported')).slice(0, 127);
    result.push({ check: 'coverage-budget', status: 'partial', reason: 'Additional distinct coverage records exceeded the bounded summary.' });
  }
  return result;
}

/** Keeps only current actor state and merged events; never retains full frame
 * histories. Unknown adapters produce missing-coverage counts, not a pass. */
export class InspectionTraceAnalyzer {
  private states = new Map<string, ActorState>();
  private overlaps = new Map<string, OverlapState>();
  private overlapObservations = new Map<string, InspectionOverlapObservation>();
  private handConstraints = new Map<string, InspectionHandConstraintSummary>();
  private equipmentStates = new Map<string, EquipmentState>();
  private findings = new Map<string, InspectionTraceFinding>();
  private nextFindingId = 1;
  private coverage = new Map<string, InspectionCoverageSample>();
  private warnings = new Map<string, NonNullable<InspectionTraceSummary['warnings']>[number]>();
  private report: Omit<InspectionTraceSummary, 'actors' | 'coverage' | 'findings' | 'warnings'> = { version: 1, frames: 0, fromMs: 0, toMs: 0, truncated: false,
    metrics: { loopWraps: 0, sourceRewinds: 0, sourceSwitches: 0, overlapSamples: 0, ignoredAllowedOverlaps: 0, invalidFrames: 0 } };

  add(input: InspectionTelemetryFrame): void {
    const parsed = inspectionTelemetryFrameSchema.safeParse(input);
    if (!parsed.success) { this.report.metrics.invalidFrames++; this.report.truncated = true; return; }
    const frame = parsed.data;
    if (!this.report.frames) this.report.fromMs = frame.timeMs;
    this.report.toMs = Math.max(this.report.toMs, frame.timeMs); this.report.frames++;
    this.report.truncated ||= frame.truncated;
    for (const item of frame.coverage) {
      const key = JSON.stringify([item.actorId, item.check, item.status, item.reason]);
      if (this.coverage.has(key) || this.coverage.size < 128) this.coverage.set(key, item); else this.report.truncated = true;
    }
    for (const sample of frame.actors) this.actor(sample);
    for (const sample of frame.overlaps) this.overlap(sample);
    for (const sample of frame.equipment ?? []) this.equipment(sample);
    for (const sample of frame.handConstraints ?? []) this.handConstraint(sample);
  }

  private finding(key: string, value: Omit<InspectionTraceFinding, 'id'>): void {
    const current = this.findings.get(key);
    if (current) {
      current.toMs = Math.max(current.toMs, value.toMs); current.samples++;
      if (value.maxDepth !== undefined && value.maxDepth > (current.maxDepth ?? 0)) {
        current.maxDepth = value.maxDepth; current.peakAtMs = value.peakAtMs;
      }
      return;
    }
    if (this.findings.size >= 64) {
      this.report.truncated = true;
      const weakest = [...this.findings].sort((a, b) => findingPriority(a[1]) - findingPriority(b[1]))[0];
      if (findingPriority(value) <= findingPriority(weakest[1])) return;
      this.findings.delete(weakest[0]);
    }
    this.findings.set(key, { id: `trace-${this.nextFindingId++}`, ...value });
  }
  private actor(sample: InspectionActorSample): void {
    let state = this.states.get(sample.actorId);
    if (!state) {
      if (this.states.size >= 64) { this.report.truncated = true; return; }
      state = { counter: { actorId: sample.actorId, samples: 0, clockSamples: 0, appliedPoseSamples: 0, composedPoseSamples: 0,
        missingSourceMetadataSamples: 0, missingIntentSamples: 0 }, episode: 0, rewinds: [], seeks: [], switches: [], lastSources: new Map() };
      this.states.set(sample.actorId, state);
    }
    const count = state.counter; count.samples++;
    count.equipmentMotion = sample.equipmentMotion;
    for (const message of sample.warnings) {
      // One warning type can affect an entire lobby. Preserve every affected
      // actor without spending the distinct-warning budget once per player.
      // This also leaves space for a late, actor-specific contact/IK failure.
      const warning = this.warnings.get(message);
      if (warning) {
        warning.samples++; warning.toMs = Math.max(warning.toMs, sample.timeMs);
        if (!warning.actorIds!.includes(sample.actorId)) {
          if (warning.actorIds!.length < 64) warning.actorIds!.push(sample.actorId); else this.report.truncated = true;
          warning.actorId = '*';
        }
      } else if (this.warnings.size < 64) this.warnings.set(message, { actorId: sample.actorId, actorIds: [sample.actorId], message,
        fromMs: sample.timeMs, toMs: sample.timeMs, samples: 1 });
      else this.report.truncated = true;
    }
    if (metadata(sample)) count.clockSamples++; else count.missingSourceMetadataSamples++;
    if (sample.intendedSpeed === undefined) count.missingIntentSamples++;
    if (sample.poseBasis === 'applied-rig' && sample.pose?.length) count.appliedPoseSamples++;
    if (sample.poseBasis === 'composed-pose' && sample.pose?.length) count.composedPoseSamples++;
    const previous = state.previous, delta = previous ? sample.timeMs - previous.timeMs : 0;
    const reset = !previous || sample.reset || sample.epoch !== previous.epoch || delta <= 0 || delta > 250 || sample.posture !== previous.posture;
    if (reset || !state.episodeIntent || !sameIntent(state.episodeIntent, sample)) {
      state.episode++; state.episodeIntent = sample; state.rewinds = []; state.seeks = []; state.switches = []; state.lastSources.clear();
      state.restFrom = undefined;
    }
    if (reset) { state.clockFrom = undefined; state.poseFrom = undefined; state.previous = sample; return; }
    const held = sample.holdsEnd && !sample.loop && metadata(sample) && sample.sourceTimeMs! >= sample.sourceDurationMs! - 1;
    const paused = sample.playbackRate === 0;
    const present = (kind: InspectionTraceFinding['kind'], fromMs: number, severity: InspectionTraceFinding['severity'], message: string) =>
      this.finding(JSON.stringify([sample.actorId, kind, state.episode, sample.source]), { actorId: sample.actorId, kind, severity,
        fromMs, toMs: sample.timeMs, peakAtMs: sample.timeMs, samples: 1, message, ...(sample.source ? { source: sample.source } : {}) });
    if (metadata(sample) && metadata(previous) && sample.source === previous.source && !held && !paused) {
      const expected = delta * (sample.playbackRate ?? 1), raw = sample.sourceTimeMs! - previous.sourceTimeMs!;
      // Very short loops can complete one or more cycles between frames; an
      // identical sampled phase is not evidence that their clock stopped.
      const cycles = sample.loop ? Math.max(0, Math.round((expected - raw) / sample.sourceDurationMs!)) : 0;
      const wrapped = cycles > 0 && Math.abs(raw + cycles * sample.sourceDurationMs! - expected) < Math.max(12, expected * .3);
      if (wrapped) this.report.metrics.loopWraps += cycles;
      const actual = wrapped ? raw + cycles * sample.sourceDurationMs! : raw;
      if (Math.abs(actual) < .001 && expected > .01) state.clockFrom ??= previous.timeMs; else state.clockFrom = undefined;
      if (state.clockFrom !== undefined && sample.timeMs - state.clockFrom >= 300)
        present('frozen-source-clock', state.clockFrom, 'error', 'The source clock stopped advancing while presentation continued.');
      if (raw < -Math.max(5, expected * .25) && !wrapped) {
        this.report.metrics.sourceRewinds++;
        const events = sample.loop ? state.seeks : state.rewinds; events.push(sample.timeMs);
        while (events.length && sample.timeMs - events[0] > 2000) events.shift();
        if (events.length >= 3) present(sample.loop ? 'repeated-phase-seeks' : 'repeated-source-restarts', events[0],
          (sample.intendedSpeed ?? 1) < .15 ? 'error' : 'review', 'The same motion repeatedly jumps backward during an unchanged movement request.');
      }
    } else state.clockFrom = undefined;
    if (sample.source && sample.source !== previous.source) {
      this.report.metrics.sourceSwitches++; state.switches.push(sample.timeMs);
      while (state.switches.length && sample.timeMs - state.switches[0] > 2000) state.switches.shift();
      if (state.switches.length >= 10 && sample.intendedSpeed !== undefined)
        present('source-churn', state.switches[0], 'review', 'Frequent source changes under a stable movement request may interrupt motion.');
      const old = state.lastSources.get(sample.source);
      if (!sample.loop && old && sample.timeMs - old.timeMs < 2000 && sample.sourceTimeMs !== undefined && sample.sourceTimeMs !== null
        && sample.sourceTimeMs < old.sourceTimeMs - 20) {
        state.rewinds.push(sample.timeMs);
        while (state.rewinds.length && sample.timeMs - state.rewinds[0] > 2000) state.rewinds.shift();
        if (state.rewinds.length >= 3) present('repeated-source-restarts', state.rewinds[0], 'review', 'A nonlooping source repeatedly re-enters an earlier phase.');
      }
    }
    if (sample.source && sample.sourceTimeMs !== undefined && sample.sourceTimeMs !== null) {
      if (!state.lastSources.has(sample.source) && state.lastSources.size >= 32) state.lastSources.delete(state.lastSources.keys().next().value!);
      state.lastSources.set(sample.source, { timeMs: sample.timeMs, sourceTimeMs: sample.sourceTimeMs });
    }
    const moving = (sample.observedSpeed ?? 0) > .4 && (sample.intendedSpeed ?? 0) > .15;
    if (moving && !held && !paused && !sample.activeAction && sample.poseBasis === previous.poseBasis && poseDistance(sample.pose, previous.pose) < 1e-6)
      state.poseFrom ??= previous.timeMs;
    else state.poseFrom = undefined;
    if (state.poseFrom !== undefined && sample.timeMs - state.poseFrom >= 600) {
      present('frozen-pose', state.poseFrom, 'review', sample.poseBasis === 'applied-rig'
        ? 'The applied rig remains unchanged during continuous movement.' : 'The composed pose remains unchanged during continuous movement; final rig motion is not available.');
      const key = JSON.stringify([sample.actorId, 'frozen-pose', state.episode, sample.source]);
      const finding = this.findings.get(key); if (finding) finding.poseBasis = sample.poseBasis;
    }
    if (sample.intendedSpeed !== undefined && sample.intendedSpeed < .15 && (sample.observedSpeed ?? Infinity) < .35
      && sample.grounded !== false && sample.idle === false && !sample.activeAction && !held && !paused) state.restFrom ??= previous.timeMs;
    else state.restFrom = undefined;
    if (state.restFrom !== undefined && sample.timeMs - state.restFrom >= 4000)
      present('unsettled-rest', state.restFrom, 'review', 'Locomotion did not settle to an idle source after four seconds without movement intent.');
    state.previous = sample;
  }
  private overlap(sample: InspectionOverlapSample): void {
    const observationKey = JSON.stringify([sample.actorId, sample.pair, sample.kind, sample.approximation, sample.intent ?? 'unknown']);
    const observation = this.overlapObservations.get(observationKey);
    if (observation) {
      if (sample.timeMs - observation.toMs > 100 || sample.timeMs < observation.toMs) observation.episodes++;
      observation.fromMs = Math.min(observation.fromMs, sample.timeMs); observation.toMs = Math.max(observation.toMs, sample.timeMs); observation.samples++;
      if (sample.depth > observation.maxDepth) Object.assign(observation, { maxDepth: sample.depth, peakAtMs: sample.timeMs,
        peakPosition: sample.position && { ...sample.position }, activeAction: sample.activeAction, activeClips: sample.activeClips?.slice() });
    } else {
      if (this.overlapObservations.size >= 128) {
        this.report.truncated = true;
        if (sample.intent !== 'allowed') {
          const allowed = [...this.overlapObservations].find(([, value]) => value.intent === 'allowed');
          if (allowed) this.overlapObservations.delete(allowed[0]);
        }
      }
      if (this.overlapObservations.size < 128) this.overlapObservations.set(observationKey, {
        actorId: sample.actorId, pair: sample.pair, kind: sample.kind, approximation: sample.approximation, intent: sample.intent ?? 'unknown',
        fromMs: sample.timeMs, toMs: sample.timeMs, samples: 1, episodes: 1, maxDepth: sample.depth, peakAtMs: sample.timeMs,
        peakPosition: sample.position && { ...sample.position }, activeAction: sample.activeAction, activeClips: sample.activeClips?.slice(),
      });
    }
    if (sample.intent === 'allowed') { this.report.metrics.ignoredAllowedOverlaps++; return; }
    this.report.metrics.overlapSamples++;
    if (sample.depth < .01) return;
    const key = observationKey;
    let state = this.overlaps.get(key);
    if (!state || sample.timeMs - state.lastMs > 100 || sample.timeMs < state.lastMs) {
      if (!this.overlaps.has(key) && this.overlaps.size >= 128) { this.report.truncated = true; return; }
      state = { fromMs: sample.timeMs, lastMs: sample.timeMs, samples: 0, maxDepth: sample.depth, peakAtMs: sample.timeMs };
      this.overlaps.set(key, state);
    }
    state.lastMs = sample.timeMs; state.samples++;
    if (sample.depth > state.maxDepth) { state.maxDepth = sample.depth; state.peakAtMs = sample.timeMs; }
    if (sample.timeMs - state.fromMs >= 100 || sample.depth >= .08) this.finding(`overlap:${key}:${state.fromMs}`, {
      actorId: sample.actorId, kind: 'geometric-overlap', severity: 'review', fromMs: state.fromMs, toMs: sample.timeMs,
      peakAtMs: state.peakAtMs, samples: state.samples, pair: sample.pair, maxDepth: state.maxDepth, approximation: sample.approximation,
      contactIntent: sample.intent ?? 'unknown',
      message: `${sample.kind} overlap (${sample.approximation}); inspect contact intent and proxy accuracy before changing the animation.`,
    });
  }
  private handConstraint(sample: InspectionHandConstraintSample): void {
    const key = JSON.stringify([sample.actorId, sample.constraintId]);
    const measurement = { atMs: sample.timeMs, weight: sample.weight, reachable: sample.reachable,
      requestedError: sample.requestedError, solvedError: sample.solvedError, orientationError: sample.orientationError,
      activeAction: sample.activeAction, activeClips: sample.activeClips?.slice() };
    let summary = this.handConstraints.get(key);
    if (!summary) {
      if (this.handConstraints.size >= 128) { this.report.truncated = true; return; }
      summary = { actorId: sample.actorId, constraintId: sample.constraintId, fromMs: sample.timeMs, toMs: sample.timeMs,
        samples: 1, blendedSamples: Number(sample.weight < 1), unreachableSamples: Number(!sample.reachable),
        maxRequestedError: sample.requestedError, maxRequestedErrorAtMs: sample.timeMs,
        maxSolvedError: sample.solvedError, maxSolvedErrorAtMs: sample.timeMs,
        maxOrientationError: sample.orientationError, maxOrientationErrorAtMs: sample.timeMs, peak: measurement, warnings: sample.warnings.slice() };
      this.handConstraints.set(key, summary); return;
    }
    summary.samples++; summary.fromMs = Math.min(summary.fromMs, sample.timeMs); summary.toMs = Math.max(summary.toMs, sample.timeMs);
    summary.blendedSamples += Number(sample.weight < 1); summary.unreachableSamples += Number(!sample.reachable);
    for (const [field, timeField, value] of [
      ['maxRequestedError', 'maxRequestedErrorAtMs', sample.requestedError],
      ['maxSolvedError', 'maxSolvedErrorAtMs', sample.solvedError],
      ['maxOrientationError', 'maxOrientationErrorAtMs', sample.orientationError],
    ] as const) if (value > summary[field]) { summary[field] = value; summary[timeField] = sample.timeMs; }
    // Prefer actual residual constraint error to intentional blend separation.
    // This chooses evidence; it does not classify the design as a failure.
    // Match capture attention scales so an orientation-only excursion cannot
    // be hidden by a smaller combined residual at a different frame.
    const priority = (value: Pick<InspectionHandConstraintSample, 'solvedError' | 'orientationError'>) =>
      Math.max(value.solvedError / .005, value.orientationError / .05);
    if (summary.peak.reachable && !measurement.reachable
      || summary.peak.reachable === measurement.reachable && priority(measurement) > priority(summary.peak)) summary.peak = measurement;
    for (const warning of sample.warnings) if (!summary.warnings.includes(warning)) {
      if (summary.warnings.length < 8) summary.warnings.push(warning); else this.report.truncated = true;
    }
  }
  private equipment(sample: InspectionEquipmentSample): void {
    const key = JSON.stringify([sample.actorId, sample.itemId]);
    let state = this.equipmentStates.get(key);
    if (!state) {
      if (this.equipmentStates.size >= 64) { this.report.truncated = true; return; }
      state = { counter: { itemId: sample.itemId, ...(sample.actorId ? { actorId: sample.actorId } : {}),
        semanticSignatures: [], samples: 0, motionSamples: 0, activeActionSamples: 0, unknownActionSamples: 0, partialSamples: 0,
        directionalMotionSamples: 0, fromMs: sample.timeMs, toMs: sample.timeMs, maxSpeed: 0, maxOwnerRelativeSpeed: 0 } };
      this.equipmentStates.set(key, state);
    }
    const count = state.counter; count.samples++; count.toMs = Math.max(count.toMs, sample.timeMs);
    count.weight = sample.weight; count.motionInfluence = sample.motionInfluence;
    const semanticSignature = equipmentSemantics(sample);
    if (!count.semanticSignatures.includes(semanticSignature)) {
      if (count.semanticSignatures.length < 8) count.semanticSignatures.push(semanticSignature);
      else this.report.truncated = true;
    }
    if (sample.coverage !== 'supported') count.partialSamples++;
    if (sample.activeAction) count.activeActionSamples++;
    if (sample.activeAction === undefined) count.unknownActionSamples++;
    const speed = (value: { x: number; y: number; z: number } | undefined) => value ? Math.hypot(value.x, value.y, value.z) : 0;
    const visiblePoints = sample.points.filter(point => point.visible);
    if (visiblePoints.some(point => point.ownerRelativeVelocity !== undefined)) count.motionSamples++;
    for (const point of visiblePoints) {
      count.maxSpeed = Math.max(count.maxSpeed, speed(point.velocity));
      count.maxOwnerRelativeSpeed = Math.max(count.maxOwnerRelativeSpeed, speed(point.ownerRelativeVelocity));
    }
    // Tags are authored vocabulary, never a whitelist of good and bad surfaces.
    // Retain the strongest observed leading direction with its exact tags and
    // frame of reference, leaving the meaning of the motion to the author.
    let candidate: z.infer<typeof equipmentMotionSchema> | undefined;
    for (const direction of sample.directions) {
      const point = visiblePoints.find(value => value.id === direction.motionPoint);
      const visible = (id: string) => visiblePoints.some(value => value.id === id);
      if (!point || !visible(direction.from) || !visible(direction.to)) continue;
      const measurements = [
        { velocity: point.ownerRelativeVelocity, alignment: direction.ownerRelativeAlignment, basis: 'owner-relative' as const },
        { velocity: point.gripRelativeVelocity, alignment: direction.gripRelativeAlignment, basis: 'grip-relative' as const },
        { velocity: point.velocity, alignment: direction.worldAlignment, basis: 'world' as const },
      ];
      const measured = measurements.find(value => value.velocity && value.alignment !== undefined);
      if (!measured || speed(measured.velocity) < 1e-4) continue;
      const motion = { atMs: sample.timeMs, pointId: point.id, directionId: direction.id, tags: [...direction.tags],
        weight: sample.weight, motionInfluence: sample.motionInfluence,
        speed: speed(measured.velocity), alignment: measured.alignment!, basis: measured.basis,
        velocity: { ...measured.velocity! }, ...(sample.activeAction === undefined ? {} : { activeAction: sample.activeAction }),
        ...(sample.activeClips ? { activeClips: sample.activeClips.slice() } : {}) };
      if (!candidate || preferEquipmentMotion(motion, candidate)) candidate = motion;
    }
    if (candidate) {
      count.directionalMotionSamples++;
      if (!count.peakMotion || preferEquipmentMotion(candidate, count.peakMotion)) count.peakMotion = candidate;
    }
  }
  finish(): InspectionTraceSummary {
    const details: InspectionCoverageSample[] = [];
    for (const { counter } of this.states.values()) {
      const status = (measured: number) => measured === 0 ? 'unsupported' as const : measured === counter.samples ? 'supported' as const : 'partial' as const;
      details.push({ actorId: counter.actorId, check: 'source-clock', status: status(counter.clockSamples),
        reason: counter.clockSamples === counter.samples ? 'Source timing, duration and loop semantics were available.' : 'Source metadata was unavailable for some or all samples; clock/phase checks cannot cover those intervals.' },
      { actorId: counter.actorId, check: 'movement-intent', status: status(counter.samples - counter.missingIntentSamples),
        reason: counter.missingIntentSamples ? 'Movement intent was unavailable for some or all samples; neutral-rest and stable-request checks are limited.' : 'Supplied movement intent was observed.' },
      { actorId: counter.actorId, check: 'applied-pose', status: status(counter.appliedPoseSamples),
        reason: counter.appliedPoseSamples === counter.samples ? 'Post-constraint rig motion was sampled.'
          : counter.composedPoseSamples ? 'Some or all pose evidence is composed-only; it does not measure final rig constraints.' : 'Applied rig motion was unavailable for some or all samples.' });
    }
    for (const { counter } of this.equipmentStates.values()) {
      details.push({ ...(counter.actorId ? { actorId: counter.actorId } : {}), check: 'equipment-motion',
        status: !counter.motionSamples ? 'unsupported' : counter.motionSamples >= counter.samples - 1 ? 'supported' : 'partial',
        reason: counter.motionSamples ? 'Owner-relative tagged landmark motion was sampled. Direction alignments describe motion without classifying its intent.'
          : 'Owner-relative landmark velocities were unavailable; world trajectories alone cannot distinguish carry movement from an item swing.' });
    }
    if (!this.handConstraints.size) details.push({ check: 'hand-constraints', status: 'unsupported',
      reason: 'No shared hand constraints were applied during this run; custom constraints need telemetry to be measured.' });
    else for (const counter of this.handConstraints.values()) details.push({ actorId: counter.actorId, check: 'hand-constraints',
      status: counter.actorId && this.states.has(counter.actorId) ? 'supported' : 'partial', reason: counter.actorId && this.states.has(counter.actorId)
        ? 'Shared hand solves sampled continuously. Requested error includes blend separation; solved error measures the blended target residual.'
        : 'Hand solves were sampled, but no matching animation actor context was observed for the rig.' });
    if (!this.states.size) details.push({ check: 'animation', status: 'unsupported', reason: 'No shared actor telemetry was emitted by this view.' });
    if (this.report.metrics.invalidFrames) details.push({ check: 'telemetry-validation', status: 'partial', reason: 'Invalid telemetry frames were discarded; coverage counts describe accepted frames only.' });
    if (this.report.truncated) details.push({ check: 'diagnostic-budget', status: 'partial', reason: 'Some bounded telemetry or diagnostic evidence was omitted.' });
    const coverage = boundedCoverage([...details, ...this.coverage.values()], () => { this.report.truncated = true; });
    return { ...this.report, metrics: { ...this.report.metrics }, actors: [...this.states.values()].map(state => ({ ...state.counter,
      ...(state.counter.equipmentMotion ? { equipmentMotion: cloneEquipmentMotion(state.counter.equipmentMotion) } : {}) })),
      coverage, findings: [...this.findings.values()].sort((a, b) => findingPriority(b) - findingPriority(a)).map(value => ({ ...value })),
      overlapObservations: [...this.overlapObservations.values()].map(value => ({ ...value,
        peakPosition: value.peakPosition && { ...value.peakPosition }, activeClips: value.activeClips?.slice() })),
      handConstraints: [...this.handConstraints.values()].map(value => ({ ...value, warnings: value.warnings.slice(),
        peak: { ...value.peak, activeClips: value.peak.activeClips?.slice() } })),
      ...(this.equipmentStates.size ? { equipment: [...this.equipmentStates.values()].map(state => ({ ...state.counter, semanticSignatures: [...state.counter.semanticSignatures],
        ...(state.counter.peakMotion ? { peakMotion: { ...state.counter.peakMotion, tags: [...state.counter.peakMotion.tags],
          activeClips: state.counter.peakMotion.activeClips?.slice(), velocity: { ...state.counter.peakMotion.velocity } } } : {}) })) } : {}),
      warnings: [...this.warnings.values()].map(value => ({ ...value, actorIds: value.actorIds?.slice() })) };
  }
}

/** Image nominations preserve measurements without promoting them to failures.
 * Explicit allowed contacts stay in the trace but do not spend capture budget.
 * Thresholds here only choose useful pictures; they never decide design intent. */
export function getInspectionCaptureCandidates(summary: InspectionTraceSummary): InspectionTraceFinding[] {
  const candidates = summary.findings.map(value => ({ ...value }));
  for (const [index, contact] of (summary.overlapObservations ?? []).entries()) {
    if (contact.intent === 'allowed') continue;
    if (summary.findings.some(finding => finding.kind === 'geometric-overlap' && finding.actorId === contact.actorId
      && finding.pair === contact.pair && finding.approximation === contact.approximation
      && finding.fromMs <= contact.peakAtMs && finding.toMs >= contact.peakAtMs)) continue;
    candidates.push({ id: `overlap-observation-${index + 1}`, actorId: contact.actorId, kind: 'geometric-overlap', severity: 'review',
      fromMs: contact.peakAtMs, toMs: contact.peakAtMs, peakAtMs: contact.peakAtMs, samples: contact.samples,
      pair: contact.pair, maxDepth: contact.maxDepth, approximation: contact.approximation, contactIntent: contact.intent,
      message: `Measured ${contact.kind} contact (${contact.approximation}, adapter intent: ${contact.intent}). Capture nomination only; brief contact and proxy accuracy need design context.` });
  }
  for (const [index, constraint] of (summary.handConstraints ?? []).entries()) {
    const peak = constraint.peak;
    if (peak.reachable && peak.solvedError <= .005 && peak.orientationError <= .05) continue;
    candidates.push({ id: `constraint-observation-${index + 1}`, actorId: constraint.actorId ?? 'unowned-rig',
      kind: 'constraint-observation', severity: 'review', source: constraint.constraintId,
      fromMs: peak.atMs, toMs: peak.atMs, peakAtMs: peak.atMs, samples: constraint.samples,
      message: `Shared hand constraint ${constraint.constraintId}: reachable=${peak.reachable}, blended-target residual=${peak.solvedError.toFixed(4)}m, orientation residual=${peak.orientationError.toFixed(4)}rad, blend=${peak.weight.toFixed(3)}. Capture nomination only; requested-target separation may be intentional.`.slice(0, 500) });
  }
  const camera = summary.gameplayCamera, peak = camera?.peak;
  if (camera && peak && peak.status !== 'unsupported' && camera.maxBlockedFraction >= .25) candidates.push({
    id: 'camera-observation-1', actorId: peak.actorId ?? 'gameplay-camera', kind: 'camera-observation', severity: 'review',
    fromMs: peak.timeMs, toMs: peak.timeMs, peakAtMs: peak.timeMs, samples: camera.samples,
    message: `Near-camera geometry occupied ${(camera.maxBlockedFraction * 100).toFixed(1)}% of sampled gameplay-view rays. Capture nomination only; camera purpose and intended visibility determine whether this is unwanted.`,
  });
  return candidates.sort((a, b) => findingPriority(b) - findingPriority(a));
}

/** Spend a six-frame image budget on before/during/after evidence first, keeping
 * one representative interval outside findings. Requested times fill spare
 * slots; explicit caller captures should bypass this policy in the renderer. */
export function selectInspectionCaptureTimes(summary: InspectionTraceSummary, durationMs: number,
  requestedTimes: readonly number[] = [], maxCaptures = 6): number[] {
  const end = clamp(Number.isFinite(durationMs) ? durationMs : 0, 0, 60000), limit = clamp(Number.isFinite(maxCaptures) ? Math.floor(maxCaptures) : 6, 1, 6);
  const selected: number[] = [], add = (time: number) => {
    const bounded = Math.round(clamp(time, 0, end));
    if (Number.isFinite(bounded) && selected.length < limit && !selected.some(value => Math.abs(value - bounded) < 80)) selected.push(bounded);
  };
  const findings = getInspectionCaptureCandidates(summary);
  if (findings.length) {
    const top = findings[0]; add(top.fromMs - 160); add(top.peakAtMs); add(top.toMs + 160);
    const second = findings.find(finding => finding.actorId !== top.actorId || finding.kind !== top.kind || finding.pair !== top.pair);
    if (second) add(second.peakAtMs);
    const clean = [end * .5, end * .25, end * .75, end, 0].find(time => !findings.some(finding => time >= finding.fromMs - 100 && time <= finding.toMs + 100));
    if (clean !== undefined) add(clean);
  }
  for (const time of requestedTimes) add(time);
  if (!selected.length) for (const fraction of [0, .33, .67, 1]) add(end * fraction);
  return selected.sort((a, b) => a - b);
}
