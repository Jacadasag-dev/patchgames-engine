import { z } from 'zod';

const count = z.number().int().nonnegative(), finite = z.number().finite(), id = z.string().min(1).max(160);
export const inspectionGameplayCameraSampleSchema = z.object({
  timeMs: finite, actorId: id.optional(), status: z.enum(['supported', 'partial', 'unsupported']),
  nearDistance: finite.positive(), rayCount: count, blockedRays: count, centerBlocked: z.boolean(),
  nearestDistance: finite.nonnegative().optional(), maskedMeshes: count, omitted: count,
  blockers: z.array(z.object({ id, actorId: id.optional(), itemId: id.optional(), rays: count,
    minDistance: finite.nonnegative() }).strict()).max(8),
  items: z.array(z.object({ itemId: id, actorId: id.optional(), landmarks: count, onScreen: count,
    visible: count, occluded: count }).strict()).max(8),
  limitation: z.string().max(300),
}).strict().superRefine((sample, ctx) => {
  if (sample.blockedRays > sample.rayCount || sample.centerBlocked && sample.blockedRays === 0)
    ctx.addIssue({ code: 'custom', message: 'Blocked rays must be a subset of sampled rays.' });
  if (sample.blockers.some(blocker => blocker.rays > sample.blockedRays)
    || sample.blockers.reduce((sum, blocker) => sum + blocker.rays, 0) > sample.blockedRays)
    ctx.addIssue({ code: 'custom', message: 'Blocker counts cannot exceed blocked rays.' });
  if (sample.items.some(item => item.onScreen > item.landmarks || item.visible + item.occluded > item.onScreen))
    ctx.addIssue({ code: 'custom', message: 'Visible and occluded landmarks must be sampled on-screen landmarks.' });
});
export type InspectionGameplayCameraSample = z.infer<typeof inspectionGameplayCameraSampleSchema>;
export const inspectionGameplayCameraSummarySchema = z.object({
  samples: count, fromMs: finite, toMs: finite, supportedSamples: count, partialSamples: count, unsupportedSamples: count,
  maxBlockedFraction: finite.min(0).max(1), peak: inspectionGameplayCameraSampleSchema.optional(),
  items: z.array(z.object({ itemId: id, actorId: id.optional(), samples: count, occludedSamples: count,
    offscreenSamples: count, minVisibleFraction: finite.min(0).max(1), peakAtMs: finite }).strict()).max(16),
  truncated: z.boolean(),
}).strict();
export type InspectionGameplayCameraSummary = z.infer<typeof inspectionGameplayCameraSummarySchema>;

/** Measurements are evidence, not rules about where an item should be visible. */
export class InspectionGameplayCameraAnalyzer {
  private value: InspectionGameplayCameraSummary = { samples: 0, fromMs: 0, toMs: 0, supportedSamples: 0,
    partialSamples: 0, unsupportedSamples: 0, maxBlockedFraction: 0, items: [], truncated: false };
  add(input: unknown, atMs: number): void {
    const parsed = inspectionGameplayCameraSampleSchema.safeParse(input);
    const report = this.value;
    if (!report.samples) report.fromMs = atMs;
    report.samples++; report.toMs = atMs;
    if (!parsed.success) { report.unsupportedSamples++; report.truncated ||= input !== undefined; return; }
    const sample = parsed.data;
    report[`${sample.status}Samples`]++;
    report.truncated ||= sample.omitted > 0;
    const fraction = sample.rayCount ? sample.blockedRays / sample.rayCount : 0;
    if (!report.peak || fraction > report.maxBlockedFraction
      || fraction === report.maxBlockedFraction && sample.centerBlocked && !report.peak.centerBlocked) {
      report.maxBlockedFraction = fraction; report.peak = sample;
    }
    for (const item of sample.items) {
      let retained = report.items.find(value => value.itemId === item.itemId && value.actorId === item.actorId);
      const visibleFraction = item.landmarks ? item.visible / item.landmarks : 0;
      if (!retained) {
        if (report.items.length >= 16) { report.truncated = true; continue; }
        retained = { itemId: item.itemId, ...(item.actorId ? { actorId: item.actorId } : {}), samples: 0,
          occludedSamples: 0, offscreenSamples: 0, minVisibleFraction: visibleFraction, peakAtMs: sample.timeMs };
        report.items.push(retained);
      }
      retained.samples++; retained.occludedSamples += Number(item.occluded > 0);
      retained.offscreenSamples += Number(item.onScreen === 0);
      if (visibleFraction < retained.minVisibleFraction) { retained.minVisibleFraction = visibleFraction; retained.peakAtMs = sample.timeMs; }
    }
  }
  finish(): InspectionGameplayCameraSummary { return structuredClone(this.value); }
}
