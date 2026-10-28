import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { ExecutionBudget } from '../../src/sandbox/host/executionBudget.ts';
import { detectExecutionClock, GVISOR_MARKER_PATH, type ClockProcess } from '../../src/sandbox/host/executionClock.ts';

const missing = () => { throw Object.assign(new Error('not present'), { code: 'ENOENT' }); };
function host(statSync: (path: string) => unknown, cpu = () => ({ user: 1000, system: 0 })): ClockProcess {
  return { platform: 'linux', getBuiltinModule: id => {
    expect(id).toBe('node:fs');
    return { statSync };
  }, threadCpuUsage: cpu };
}

it.each([4, 20, 30])('keeps the unchanged %dms strict wall limit on marked gVisor without sampling its CPU clock', limit => {
  const stat = vi.fn(() => ({})), cpu = vi.fn(() => ({ user: 10000, system: 0 }));
  const capability = detectExecutionClock(host(stat, cpu));
  let wall = 100;
  const budget = new ExecutionBudget(limit, true, { wallNow: () => wall, ...capability });
  expect(capability.gvisor).toBe(true);
  expect(budget.mode).toBe('wall');
  expect(budget.wallLimitMs).toBe(limit);
  wall += limit - .01;
  expect(budget.expired()).toBe(false);
  wall = 100 + limit;
  expect(budget.expired()).toBe(true);
  expect(budget.snapshot().reason).toBe('wall');
  expect(cpu).not.toHaveBeenCalled();
  expect(stat).toHaveBeenCalledExactlyOnceWith(GVISOR_MARKER_PATH);
});

it('preserves native Linux thread CPU accounting and its bounded wall backstop', () => {
  let wall = 100, cpu = 1000;
  const capability = detectExecutionClock(host(missing, () => ({ user: cpu, system: 2000 })));
  expect(capability.gvisor).toBe(false);
  const budget = new ExecutionBudget(20, true, { wallNow: () => wall, ...capability });
  cpu += 8000; wall += 70;
  expect(budget.expired()).toBe(false);
  expect(budget.snapshot()).toMatchObject({ mode: 'thread-cpu', cpuMs: 8, wallLimitMs: 100 });
  cpu += 12000; wall += 12;
  expect(budget.expired()).toBe(true);
  expect(budget.snapshot().reason).toBe('cpu');
});

it.each(['EACCES', 'EIO', 'ENOTDIR', undefined])('uses strict wall accounting when runtime detection fails (%s)', code => {
  const capability = detectExecutionClock(host(() => { throw Object.assign(new Error('read failed'), { code }); }));
  expect(capability).toEqual({ gvisor: null });
  expect(new ExecutionBudget(4, true, { wallNow: () => 0, ...capability }).wallLimitMs).toBe(4);
});

it('does not assume CPU clock support from Linux alone or require Node APIs in browsers', () => {
  for (const runtime of [undefined, { platform: 'win32' }, { platform: 'darwin' }, { platform: 'linux' },
    { platform: 'linux', getBuiltinModule: () => undefined },
    { platform: 'linux', getBuiltinModule: () => { throw new Error('unavailable'); } }])
    expect(detectExecutionClock(runtime)).toEqual({ gvisor: null });
  expect(detectExecutionClock({ ...host(missing), threadCpuUsage: undefined })).toEqual({ gvisor: false });
});

it('bundles and runs the default clock detection in a browser realm without process or Node shims', async () => {
  const result = await build({ entryPoints: ['src/sandbox/host/executionBudget.ts'], platform: 'browser',
    format: 'iife', globalName: 'Budget', bundle: true, write: false });
  const context = { performance: { now: () => 0 },
    Budget: undefined as typeof import('../../src/sandbox/host/executionBudget.ts') | undefined };
  runInNewContext(result.outputFiles[0].text, context);
  expect(context.Budget!.executionClock.threadCpuNow).toBeUndefined();
  expect(new context.Budget!.ExecutionBudget(4, true).wallLimitMs).toBe(4);
});
