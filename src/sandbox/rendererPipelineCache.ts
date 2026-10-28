/** Three releases a pipeline as soon as its final render object disappears.
 * Automatically rebuilt instance/batch proxies can disappear and return during
 * camera movement, needlessly recompiling identical GPU programs. Keep a small
 * bounded pool of those exact immutable native cache entries. */
export interface CachedProgram { code: string; stage: string; usedTimes: number }
export interface CachedPipeline {
  cacheKey: string;
  usedTimes: number;
  vertexProgram?: CachedProgram;
  fragmentProgram?: CachedProgram;
  computeProgram?: CachedProgram;
}
export interface PipelineManager {
  _releasePipeline(pipeline: CachedPipeline): void;
  _releaseProgram(program: CachedProgram): void;
  getForRender(...args: unknown[]): unknown;
  getForCompute?(...args: unknown[]): unknown;
}
export interface PipelineRetentionLimits { pipelines: number; programs: number; shaderBytes: number }

export function retainRendererPipelines(manager: PipelineManager,
  limits: PipelineRetentionLimits = { pipelines: 512, programs: 512, shaderBytes: 4 * 1024 * 1024 }) {
  if (typeof manager?._releasePipeline !== 'function' || typeof manager?._releaseProgram !== 'function'
    || typeof manager.getForRender !== 'function') {
    throw new Error('The renderer does not expose the expected pipeline cache lifecycle.');
  }
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error('Invalid pipeline retention limits.');
  const releasePipeline = manager._releasePipeline, releaseProgram = manager._releaseProgram;
  const getForRender = manager.getForRender, getForCompute = manager.getForCompute;
  const pipelines = new Map<CachedPipeline, true>(), programs = new Map<CachedProgram, number>();
  const releasedPrograms = new WeakSet<CachedProgram>();
  let bytes = 0, pipelineEvictions = 0, programEvictions = 0, disposed = false, resolving = 0;
  const forgetPipeline = (pipeline: CachedPipeline) => {
    pipelines.delete(pipeline);
    if (pipeline.usedTimes === 0) { releasePipeline.call(manager, pipeline); pipelineEvictions++; }
  };
  const forgetProgram = (program: CachedProgram) => {
    bytes -= programs.get(program) ?? 0;
    programs.delete(program);
    if (program.usedTimes !== 0) return;
    // A retired pipeline keeps its stage strongly referenced. Drop it too, so
    // the shader byte budget cannot be bypassed by the pipeline pool.
    for (const pipeline of pipelines.keys()) {
      if (pipeline.vertexProgram === program || pipeline.fragmentProgram === program || pipeline.computeProgram === program) {
        forgetPipeline(pipeline);
      }
    }
    releaseProgram.call(manager, program); releasedPrograms.add(program); programEvictions++;
  };
  const trim = () => {
    // Native lookups temporarily decrement counts before selecting and
    // incrementing the replacement pipeline. Eviction in that interval could
    // remove a zero-count stage already selected for immediate reuse.
    if (resolving) return;
    while (programs.size > limits.programs || bytes > limits.shaderBytes) forgetProgram(programs.keys().next().value!);
    while (pipelines.size > limits.pipelines) forgetPipeline(pipelines.keys().next().value!);
  };
  manager._releasePipeline = pipeline => {
    if (disposed) { releasePipeline.call(manager, pipeline); return; }
    if ([pipeline.vertexProgram, pipeline.fragmentProgram, pipeline.computeProgram].some(program => program && releasedPrograms.has(program))) {
      forgetPipeline(pipeline); return;
    }
    pipelines.delete(pipeline); pipelines.set(pipeline, true);
    trim();
  };
  manager._releaseProgram = program => {
    if (disposed) { releaseProgram.call(manager, program); return; }
    bytes -= programs.get(program) ?? 0;
    programs.delete(program);
    const size = program.code.length * 2;
    programs.set(program, size); bytes += size;
    trim();
  };
  manager.getForRender = function(this: PipelineManager, object: unknown, promises?: unknown) {
    resolving++;
    try { return getForRender.call(this, object, promises); }
    finally { resolving--; trim(); }
  };
  if (getForCompute) manager.getForCompute = function(this: PipelineManager, node: unknown, bindings?: unknown, promises?: unknown) {
    resolving++;
    try { return getForCompute.call(this, node, bindings, promises); }
    finally { resolving--; trim(); }
  };
  return {
    stats: () => ({ retainedPipelines: pipelines.size, retainedPrograms: programs.size,
      retainedShaderBytes: bytes, pipelineEvictions, programEvictions }),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const pipeline of pipelines.keys()) forgetPipeline(pipeline);
      for (const program of programs.keys()) forgetProgram(program);
      manager._releasePipeline = releasePipeline; manager._releaseProgram = releaseProgram;
      manager.getForRender = getForRender;
      if (getForCompute) manager.getForCompute = getForCompute;
    },
  };
}
