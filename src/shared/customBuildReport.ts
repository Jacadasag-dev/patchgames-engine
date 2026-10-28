import { z } from 'zod';

const stage = z.enum(['not_run', 'passed', 'failed']);
const vector = z.object({x:z.number().finite(),y:z.number().finite(),z:z.number().finite()});
const bounds = z.object({min:vector,max:vector,size:vector,center:vector});
export const modelReportSchema = z.object({
  name:z.string().max(64),parts:z.number().int().min(1).max(48),posesChecked:z.number().int().min(1).max(307),
  bounds,collisionBounds:bounds.nullable(),truncated:z.boolean(),errors:z.number().int().nonnegative(),warnings:z.number().int().nonnegative(),
  diagnostics:z.array(z.object({code:z.enum(['FLOATING','BURIED','ATTACHMENT','BELOW_GROUND','NO_GROUND']),
    severity:z.enum(['error','warning']),pose:z.string().max(150),part:z.string().max(64),other:z.string().max(64).optional(),
    gap:z.number().finite().nonnegative().optional(),axis:vector.optional(),message:z.string().max(500)})).max(200),
});
const testResults = z.object({ total: z.number().int().nonnegative(), passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(), fileErrors: z.number().int().nonnegative(), truncated: z.boolean(),
  results: z.array(z.object({ file: z.string().max(300), name: z.string().max(200).nullable(), status: z.enum(['passed','failed']), error: z.string().max(1000).optional() })).max(2000) });
export const customBuildReportSchema = z.object({
  version: z.literal(1),
  stages: z.object({ boundary: stage, typecheck: stage, tests: stage, models: stage.optional(), bundles: stage, tuning: stage, simulation: stage, package: stage }),
  models:z.object({scope:z.literal('src/game/**/*.model.ts'),status:stage,files:z.array(z.object({
    file:z.string().max(300),report:modelReportSchema.optional(),error:z.string().max(1000).optional(),
  })).max(32)}).optional(),
  tests: testResults.extend({ scope: z.enum(['tests/game/request','tests/game excluding tests/game/baseline']) }),
  // Optional so stored reports from older workers remain readable without inventing evidence.
  baselineTests: testResults.extend({ scope: z.enum(['tests/game excluding tests/game/request','tests/game/baseline']),
    status: stage, blocking: z.literal(false) }).optional(),
  simulation: z.object({ seed: z.literal(17), steps: z.number().int().min(0).max(90), durationMs: z.number().min(0).max(3000), inputs: z.literal('neutral') }),
  visualInspection: z.literal('not_run'),
  compatibility:z.object({status:stage,seeds:z.array(z.number().int()).max(8),stepsPerSeed:z.number().int().max(300),inputs:z.literal('scripted'),replayMatched:z.boolean()}).optional(),
  error: z.string().max(6000).optional(),
});
export type CustomBuildReport = z.infer<typeof customBuildReportSchema>;
export const newCustomBuildReport = (): CustomBuildReport => ({
  version: 1, stages: { boundary:'not_run',typecheck:'not_run',tests:'not_run',models:'not_run',bundles:'not_run',tuning:'not_run',simulation:'not_run',package:'not_run' },
  models:{scope:'src/game/**/*.model.ts',status:'not_run',files:[]},
  tests: { scope:'tests/game excluding tests/game/baseline',total:0,passed:0,failed:0,fileErrors:0,truncated:false,results:[] },
  baselineTests: { scope:'tests/game/baseline',status:'not_run',blocking:false,total:0,passed:0,failed:0,fileErrors:0,truncated:false,results:[] },
  simulation: { seed:17,steps:0,durationMs:0,inputs:'neutral' }, visualInspection:'not_run',
});
