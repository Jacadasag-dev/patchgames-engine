import { expect, it } from 'vitest';
import { ExecutionBudget, ExecutionBurstBudget, executionClock, type ExecutionClock } from '../../src/sandbox/host/executionBudget.ts';

function clock() {
  const now = { wall: 1000, cpu: 100 };
  const source: ExecutionClock = { wallNow: () => now.wall, threadCpuNow: () => now.cpu };
  return { now, source };
}

it('uses the detected trusted host clock capability', () => {
  expect(new ExecutionBudget(20, true).mode).toBe(executionClock.threadCpuNow ? 'thread-cpu' : 'wall');
});

it('counts executing-thread CPU while tolerating bounded scheduler pauses', () => {
  const { now, source } = clock(), budget = new ExecutionBudget(20, true, source);
  now.wall += 70; now.cpu += 8;
  expect(budget.expired()).toBe(false);
  expect(budget.snapshot()).toMatchObject({ mode: 'thread-cpu', wallMs: 70, cpuMs: 8, wallLimitMs: 100 });
  now.wall += 10; now.cpu += 12;
  expect(budget.expired()).toBe(true);
  expect(budget.snapshot().reason).toBe('cpu');
  // Expiration cannot be cleared by catching an error or a changing clock.
  now.wall = 1000; now.cpu = 100;
  expect(budget.expired()).toBe(true);
});

it('stops at the wall backstop even when the thread consumed little CPU', () => {
  const { now, source } = clock(), budget = new ExecutionBudget(20, true, source);
  now.cpu += 1; now.wall += 100;
  expect(budget.expired()).toBe(true);
  expect(budget.snapshot()).toMatchObject({ mode: 'thread-cpu', reason: 'wall', wallMs: 100 });
});

it('bounds a delayed CPU accounting quantum by the enclosing wall interval without adding budget', () => {
  const { now, source } = clock(), budget = new ExecutionBudget(4, true, source);
  now.wall += .16; now.cpu += 4;
  expect(budget.expired()).toBe(false);
  expect(budget.snapshot().cpuMs).toBeCloseTo(.16, 8);
  now.wall = 1003.99;
  expect(budget.expired()).toBe(false);
  now.wall = 1004;
  expect(budget.expired()).toBe(true);
  expect(budget.snapshot()).toMatchObject({ mode: 'thread-cpu', reason: 'cpu', cpuMs: 4, wallMs: 4, wallLimitMs: 100 });
  now.wall = 1000; now.cpu = 100;
  expect(budget.expired()).toBe(true);
});

it('excludes a slow ending CPU measurement but still rejects actual execution after it', () => {
  const { now, source } = clock(), budget = new ExecutionBudget(4, true, source);
  source.threadCpuNow = () => { now.wall += 4; now.cpu += 4; return now.cpu; };
  expect(budget.expired()).toBe(false);
  expect(budget.snapshot()).toMatchObject({ reason: null, cpuMs: 0, wallMs: 4, clockWallMs: 4 });
  now.wall += 4; now.cpu += 4;
  expect(budget.expired()).toBe(true);
  expect(budget.snapshot()).toMatchObject({ reason: 'cpu', cpuMs: 4, wallMs: 12, clockWallMs: 8 });
});

it('excludes slow initial and ending reads from a quantized CPU cap without granting extra authored time', () => {
  const { now, source } = clock();
  source.threadCpuNow = () => { now.wall += 6; return now.cpu; };
  const budget = new ExecutionBudget(4, true, source);
  now.wall += 1; now.cpu += 10; // A delayed CPU quantum while only 1ms elapsed outside sampling.
  source.threadCpuNow = () => { now.wall += 3; return now.cpu; };
  expect(budget.expired()).toBe(false);
  expect(budget.snapshot()).toMatchObject({ cpuMs: 1, wallMs: 10, clockWallMs: 9 });
  now.wall += 3;
  expect(budget.expired()).toBe(true);
  expect(budget.snapshot()).toMatchObject({ reason: 'cpu', cpuMs: 4, wallMs: 16, clockWallMs: 12 });
});

it('does not subtract a waiting sampler from genuine CPU consumption', () => {
  const { now, source } = clock(), budget = new ExecutionBudget(20, true, source);
  now.wall += 20; now.cpu += 20;
  source.threadCpuNow = () => { now.wall += 50; return now.cpu; };
  expect(budget.expired()).toBe(true);
  expect(budget.snapshot()).toMatchObject({ reason: 'cpu', cpuMs: 20, wallMs: 70, clockWallMs: 50 });
});

it('keeps the full wall backstop even if repeated measurements occupy every millisecond', () => {
  const { now, source } = clock();
  source.threadCpuNow = () => { now.wall += 10; return now.cpu; };
  const budget = new ExecutionBudget(4, true, source);
  for (let i = 0; i < 8; i++) expect(budget.expired()).toBe(false);
  expect(budget.expired()).toBe(true);
  expect(budget.snapshot()).toMatchObject({ reason: 'wall', wallMs: 100, clockWallMs: 100, wallLimitMs: 100 });
  now.wall = 1000;
  expect(budget.expired()).toBe(true);
});

it('keeps strict original wall limits without a usable CPU clock or when CPU accounting is not requested', () => {
  const clocks = [undefined, () => { throw new Error('unsupported'); }, () => Number.NaN, () => -1, () => 0];
  for (const [index, cpu] of clocks.entries()) {
    const { now, source } = clock(); source.threadCpuNow = cpu;
    const budget = new ExecutionBudget(20, index !== clocks.length - 1, source);
    now.wall += 20;
    expect(budget.expired()).toBe(true);
    expect(budget.snapshot()).toMatchObject({ mode: 'wall', reason: 'wall', wallLimitMs: 20 });
  }
});

it('fails closed if clocks break during execution', () => {
  for (const broken of [() => Number.NaN, () => -1, () => { throw new Error('clock failed'); }]) {
    const { source } = clock(), budget = new ExecutionBudget(20, true, source);
    source.threadCpuNow = broken;
    expect(budget.expired()).toBe(true);
    expect(budget.snapshot().reason).toBe('clock');
  }
  const { now, source } = clock(), budget = new ExecutionBudget(20, true, source);
  now.wall--;
  expect(budget.expired()).toBe(true);
  expect(budget.snapshot().reason).toBe('clock');
  const during = clock(), sampled = new ExecutionBudget(20, true, during.source);
  during.source.threadCpuNow = () => { during.now.wall--; return during.now.cpu; };
  expect(sampled.expired()).toBe(true);
  expect(sampled.snapshot().reason).toBe('clock');
});

it('spends bounded native credit only after a usable clock is established', () => {
  const { now, source } = clock(), budget = new ExecutionBudget(20, true, source, 20);
  expect(budget.limitMs).toBe(40);
  now.cpu += 25; now.wall += 25;
  expect(budget.expired()).toBe(false);
  now.cpu += 15; now.wall += 15;
  expect(budget.expired()).toBe(true);
  expect(budget.snapshot()).toMatchObject({ reason: 'cpu', cpuMs: 40, wallLimitMs: 100 });
  for (const credit of [-1, 21, NaN, Infinity]) expect(() => new ExecutionBudget(20, true, source, credit)).toThrow('Invalid native execution credit');
});

it('never grants native credit to a missing, initially invalid or unrequested CPU clock', () => {
  const clocks = [undefined, () => { throw new Error('unsupported'); }, () => Number.NaN, () => -1, () => 0];
  for (const [index, cpu] of clocks.entries()) {
    const { now, source } = clock(); source.threadCpuNow = cpu;
    const budget = new ExecutionBudget(20, index !== clocks.length - 1, source, 20);
    expect(budget.limitMs).toBe(20);
    now.wall += 20;
    expect(budget.expired()).toBe(true);
    expect(budget.snapshot()).toMatchObject({ mode: 'wall', reason: 'wall', wallLimitMs: 20 });
  }
});

it('keeps the original wall origin and fails closed when a credited CPU clock breaks', () => {
  const paused = clock(), budget = new ExecutionBudget(20, true, paused.source, 20);
  paused.now.cpu += 25; paused.now.wall += 75;
  expect(budget.expired()).toBe(false);
  paused.now.wall += 25;
  expect(budget.expired()).toBe(true);
  expect(budget.snapshot()).toMatchObject({ reason: 'wall', wallMs: 100 });
  for (const broken of [() => Number.NaN, () => -1, () => { throw new Error('clock failed'); }]) {
    const { now, source } = clock(), credited = new ExecutionBudget(20, true, source, 20);
    now.cpu += 25; now.wall += 25;
    expect(credited.expired()).toBe(false);
    source.threadCpuNow = broken;
    expect(credited.expired()).toBe(true);
    expect(credited.snapshot().reason).toBe('clock');
    source.threadCpuNow = () => now.cpu;
    expect(credited.expired()).toBe(true);
  }
});


it('permits an isolated live tick spike but exhausts credit under sustained overload',()=>{
 const budget=new ExecutionBurstBudget(30);expect(budget.limitMs).toBe(60);
 budget.charge(33);expect(budget.limitMs).toBe(57);
 budget.charge(2);expect(budget.limitMs).toBe(60);
 budget.charge(45);expect(budget.limitMs).toBe(45);
 budget.charge(45);expect(budget.limitMs).toBe(30);
 budget.charge(100);expect(budget.limitMs).toBe(30);
 budget.charge(0);expect(budget.limitMs).toBe(60);
});

it('does not accumulate unbounded live credit or gain credit from invalid timings',()=>{
 const budget=new ExecutionBurstBudget(20);
 for(let i=0;i<1000;i++)budget.charge(1);
 expect(budget.limitMs).toBe(40);
 for(const bad of [NaN,Infinity,-1]){budget.charge(bad);expect(budget.limitMs).toBe(20);}
 expect(()=>new ExecutionBurstBudget(0)).toThrow();
});
