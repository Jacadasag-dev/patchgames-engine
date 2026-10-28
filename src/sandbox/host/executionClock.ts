/** Trusted runtime detection only; no authored settings can select a clock. */
export const GVISOR_MARKER_PATH = '/proc/gvisor/kernel_is_gvisor';

export interface ClockProcess {
  platform: string;
  getBuiltinModule?: (id: string) => unknown;
  threadCpuUsage?: () => { user: number; system: number };
}
export interface ClockCapability {
  /** null means the runtime could not be identified safely. */
  gvisor: boolean | null;
  threadCpuNow?: () => number;
}

/** runsc samples runnable tasks in 10ms quanta, not actual executing-thread CPU.
 * Its official marker is enabled and required by our trusted launch contract.
 * Use getBuiltinModule so browser bundles need no static Node import or shim. */
export function detectExecutionClock(host: ClockProcess | undefined): ClockCapability {
  if (host?.platform !== 'linux') return { gvisor: null };
  try {
    const fs = host.getBuiltinModule?.('node:fs') as { statSync?: (path: string) => unknown } | undefined;
    if (typeof fs?.statSync !== 'function') return { gvisor: null };
    try {
      fs.statSync(GVISOR_MARKER_PATH);
      return { gvisor: true };
    } catch (error) {
      // Absence is normal on native Linux. Inaccessible/failed detection is not
      // evidence of a usable CPU clock: retain the strict wall fallback.
      if ((error as { code?: string } | null)?.code !== 'ENOENT') return { gvisor: null };
    }
    if (typeof host.threadCpuUsage !== 'function') return { gvisor: false };
    const cpuUsage = host.threadCpuUsage.bind(host);
    return { gvisor: false, threadCpuNow: () => {
      const value = cpuUsage();
      return (value.user + value.system) / 1000;
    } };
  } catch { return { gvisor: null }; }
}

export function requireGvisorMarker(marker: unknown): void {
  if (marker !== true) throw new Error('gVisor runtime marker missing; enable --gvisor-marker-file before running sandbox jobs.');
}

// Detection happens once per host realm, before any authored execution budget.
export const executionClockCapability = detectExecutionClock(typeof process === 'undefined' ? undefined : process);
