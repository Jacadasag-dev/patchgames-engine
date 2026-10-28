import { expect, it } from 'vitest';
import { compileMapAssembly, defineMapAssembly, MAP_ASSEMBLY_LIMITS, type MapAssemblyRecipe, type MapConnection } from '../../src/sandbox/mapAssembly.ts';

const entry = (): MapAssemblyRecipe => ({ version: 1, id: 'adversarial-entry', parts: [
  { id: 'floor', role: 'floor', support: 'foundation', shape: { kind: 'box', size: { x: 20, y: .4, z: 8 } }, position: { x: 0, y: -.2, z: 0 } },
  { id: 'wall', role: 'wall', shape: { kind: 'box', size: { x: 4, y: 3, z: .3 } }, mount: { part: 'floor', face: 'top', ownFace: 'bottom' } },
  { id: 'sign', role: 'sign', shape: { kind: 'box', size: { x: 1.2, y: .6, z: .05 } }, mount: { part: 'wall', face: 'front', ownFace: 'back' } },
], signs: [{ part: 'sign', text: 'COURT', approaches: [{ id: 'entry', position: { x: 0, y: 1.5, z: 3 }, minVisibleFraction: 1 }] }] });
const failed = (recipe: MapAssemblyRecipe, check: string) => {
  const result = compileMapAssembly(recipe);
  expect(result.diagnostics.valid).toBe(false);
  expect(result.diagnostics.coverage.find(item => item.check === check)?.status).toBe('failed');
  expect(() => defineMapAssembly(recipe.id, () => recipe)).toThrow();
  return result;
};

it('cannot forge a connection outside a real face using a patch smaller than an area tolerance', () => {
  const recipe: MapAssemblyRecipe = { version: 1, id: 'tiny-forged-patch', parts: [
    { id: 'ground', role: 'floor', support: 'foundation', shape: { kind: 'box', size: { x: 4, y: 1, z: 4 } }, position: { x: 0, y: -.5, z: 0 } },
    { id: 'detached-wall', role: 'wall', shape: { kind: 'box', size: { x: 1, y: 1, z: 1 } }, position: { x: 10, y: .5, z: 0 } },
  ], connections: [{ id: 'fake-patch', kind: 'mate',
    a: { part: 'detached-wall', face: 'bottom', region: { minU: -10.00005, maxU: -9.99995, minV: -.00005, maxV: .00005 } },
    b: { part: 'ground', face: 'top', region: { minU: -.00005, maxU: .00005, minV: -.00005, maxV: .00005 } },
  }] };
  const result = failed(recipe, 'connections');
  expect(result.diagnostics.issues.some(issue => issue.code === 'unsupported-part' && issue.ids.includes('detached-wall'))).toBe(true);
});

it('retains contact refs independently without freezing or aliasing the editable source', () => {
  const recipe = entry();
  recipe.connections = [{ id: 'extra-wall-contact', kind: 'mate',
    a: { part: 'wall', face: 'bottom', region: { minU: -1, maxU: 1, minV: -.1, maxV: .1 } },
    b: { part: 'floor', face: 'top' },
  }];
  const first = compileMapAssembly(recipe), input = recipe.connections[0].a;
  expect(first.diagnostics.valid).toBe(true);
  expect(Object.isFrozen(input)).toBe(false); expect(Object.isFrozen(input.region)).toBe(false);
  input.region!.maxU = 4;
  const retained = first.connections.find(connection => connection.id === 'extra-wall-contact')!;
  expect(retained.a.region!.maxU).toBe(1);
  const changed = failed(recipe, 'connections');
  expect(changed.revision).not.toBe(first.revision);
});

it('detects a trim bar between sparse visibility rays while preserving a clear text-border counterpart', () => {
  const recipe = entry();
  expect(compileMapAssembly(recipe).diagnostics.valid).toBe(true);
  recipe.parts.push({ id: 'obscuring-trim', role: 'trim', shape: { kind: 'box', size: { x: 1.2, y: .12, z: .02 } },
    mount: { part: 'sign', face: 'front', ownFace: 'back', v: .1 } });
  const result = failed(recipe, 'readability');
  expect(result.diagnostics.issues.some(issue => issue.check === 'readability' && issue.ids.includes('obscuring-trim'))).toBe(true);
  recipe.parts.at(-1)!.shape = { kind: 'box', size: { x: 1.2, y: .06, z: .02 } };
  recipe.parts.at(-1)!.mount!.v = .27;
  expect(compileMapAssembly(recipe).diagnostics.issues).toEqual([]);
});

it('rejects effectively edge-on sign approaches but permits a readable oblique approach', () => {
  const recipe = entry();
  recipe.signs![0].approaches[0].position = { x: 10, y: 1.5, z: .201 };
  failed(recipe, 'readability');
  recipe.signs![0].approaches[0].position = { x: 4, y: 1.5, z: 3 };
  expect(compileMapAssembly(recipe).diagnostics.issues).toEqual([]);
});

it('rejects cyclic or deeply nested malformed metadata without unbounded canonical traversal', () => {
  const cyclic = entry();
  (cyclic.parts[0].position as unknown as Record<string, unknown>).extra = cyclic;
  expect(() => compileMapAssembly(cyclic)).not.toThrow();
  failed(cyclic, 'geometry');
  let deep: unknown = {};
  for (let i = 0; i < 3000; i++) deep = { child: deep };
  const nested = entry();
  (nested.parts[0] as unknown as Record<string, unknown>).unknown = deep;
  expect(() => compileMapAssembly(nested)).not.toThrow();
  const result = failed(nested, 'geometry');
  expect(JSON.stringify(result).length).toBeLessThan(30_000);
});

it('resolves a converging unsupported contact graph with bounded reported work', () => {
  const layers = 28;
  const connections: MapConnection[] = [];
  for (let layer = 0; layer < layers - 1; layer++) for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) {
    connections.push({ id: `c-${layer}-${a}-${b}`, kind: 'mate',
      a: { part: `p-${layer * 2 + a}`, face: layer % 2 ? 'bottom' : 'top' },
      b: { part: `p-${(layer + 1) * 2 + b}`, face: layer % 2 ? 'top' : 'bottom' } });
  }
  const recipe: MapAssemblyRecipe = { version: 1, id: 'converging-unsupported', connections,
    parts: Array.from({ length: layers * 2 }, (_, i) => ({ id: `p-${i}`, role: 'wall',
      shape: { kind: 'box', size: { x: 1, y: 1, z: 1 } }, position: { x: 0, y: Math.floor(i / 2) % 2 + .5, z: 0 } })),
  };
  const result = compileMapAssembly(recipe);
  expect(result.diagnostics.valid).toBe(false);
  expect(result.diagnostics.coverage.find(item => item.check === 'support')).toMatchObject({ status: 'failed', checked: layers * 2, total: layers * 2 });
  expect(result.diagnostics.issues.filter(issue => issue.code === 'unsupported-part')).toHaveLength(layers * 2);
  expect(result.diagnostics.operations).toBeLessThanOrEqual(MAP_ASSEMBLY_LIMITS.operations);
});
