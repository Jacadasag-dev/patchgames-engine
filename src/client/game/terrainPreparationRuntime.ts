import { Sandbox, loadQuickJS } from '../../sandbox/host/quickjs.ts';
import type { TerrainPreparationRequest } from './terrainPreparation.ts';

/** Trusted preparation runner. Authored code is always confined to QuickJS. */
export class TerrainPreparationRuntime {
  private readonly sandbox: Sandbox;
  private constructor(sandbox: Sandbox) { this.sandbox = sandbox; }
  static async load(source: string): Promise<TerrainPreparationRuntime> {
    await loadQuickJS();
    return new TerrainPreparationRuntime(new Sandbox(source, ['prepare', 'exportPreparation']));
  }
  async prepare({ tuning, interests, world }: TerrainPreparationRequest): Promise<unknown> {
    const deadline = performance.now() + 20_000;
    for (let count = 0; count < 128; count++) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error('Terrain preparation exceeded its total time limit');
      const { value } = this.sandbox.call<{ ready: boolean; pending: number }>('prepare', { tuning, interests, world, dataOnly:true }, Math.min(2000, remaining));
      if (!value || typeof value.ready !== 'boolean' || !Number.isSafeInteger(value.pending) || value.pending < 0 || (value.ready && value.pending !== 0))
        throw new Error('Invalid terrain preparation readiness');
      if (value.ready) return this.sandbox.call('exportPreparation', { tuning, world }, 2000, 8 * 1024 * 1024).value;
      // Yield between bounded chunks so cancellation and worker messages run.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    throw new Error('Terrain preparation did not become ready within 128 calls');
  }
  dispose(): void { this.sandbox.dispose(); }
}
