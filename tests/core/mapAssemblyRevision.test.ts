import { expect, it, vi } from 'vitest';
import { buildSync } from 'esbuild';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { compileMapAssembly, type MapAssemblyManifest, type MapAssemblyRecipe } from '../../src/sandbox/mapAssembly.ts';

// This roof slope reproduced the production QuickJS/V8 fingerprint mismatch.
function recipe(): MapAssemblyRecipe {
  return { version: 1, id: 'revision-courtyard', parts: [
    { id: 'ground', role: 'floor', shape: { kind: 'box', size: { x: 10, y: .4, z: 10 } }, position: { x: 0, y: -.2, z: 0 }, support: 'foundation' },
    { id: 'wall', role: 'wall', shape: { kind: 'box', size: { x: 5.52, y: 3, z: .7 } }, mount: { part: 'ground', face: 'top', ownFace: 'bottom' } },
    { id: 'roof', role: 'roof', shape: { kind: 'gable', width: 5.52, depth: .7, rise: .72, thickness: .13 }, mount: { part: 'wall', face: 'top', ownFace: 'bottom' } },
  ] };
}
const slope = (map: MapAssemblyManifest) => map.parts.find(part => part.id === 'roof')!.faces.find(face => face.id === 'slope-left')!;
const geometry = (map: MapAssemblyManifest) => map.parts.map(({ faces, ...part }) => part);

it('gives signed zero the same revision without changing the compiled coordinates', () => {
  const input = recipe(), positive = compileMapAssembly(input);
  input.parts[0].position!.x = -0;
  const negative = compileMapAssembly(input);
  expect(Object.is(positive.parts.find(part => part.id === 'ground')!.position.x, 0)).toBe(true);
  expect(Object.is(negative.parts.find(part => part.id === 'ground')!.position.x, -0)).toBe(true);
  expect(negative.revision).toBe(positive.revision);
});

it('ignores ulp-scale derived direction noise only in the fingerprint', () => {
  const original = compileMapAssembly(recipe()), hypot = Math.hypot;
  const spy = vi.spyOn(Math, 'hypot').mockImplementation((...values) => {
    const result = hypot(...values);
    return values.filter(value => value !== 0).length > 1 ? result * (1 + Number.EPSILON) : result;
  });
  let noisy: MapAssemblyManifest;
  try { noisy = compileMapAssembly(recipe()); } finally { spy.mockRestore(); }
  expect(noisy.diagnostics.valid).toBe(true);
  // Preserve full-precision frames in the manifest; do not quantize render inputs.
  expect(slope(noisy).normal).not.toEqual(slope(original).normal);
  expect(Math.abs(slope(noisy).normal.y - slope(original).normal.y)).toBeLessThan(1e-14);
  expect(geometry(noisy)).toEqual(geometry(original));
  expect(noisy.revision).toBe(original.revision);
});

it.each([1e-8, .01])('keeps a %sm authored roof geometry change visible in the revision', delta => {
  const input = recipe(), original = compileMapAssembly(input), roof = input.parts[2].shape;
  if (roof.kind !== 'gable') throw new Error('Expected gable fixture');
  roof.rise += delta;
  const edited = compileMapAssembly(input);
  expect(edited.diagnostics.valid).toBe(true);
  expect(geometry(edited)).not.toEqual(geometry(original));
  expect(edited.revision).not.toBe(original.revision);
});

it('matches the map and collider revision across real QuickJS and V8 compilation', async () => {
  const expected = compileMapAssembly(recipe());
  const source = buildSync({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
    import {compileMapAssembly} from './src/sandbox/mapAssembly.ts';
    globalThis.result=compileMapAssembly(${JSON.stringify(recipe())});
  ` }, bundle: true, write: false, platform: 'neutral', format: 'iife', target: 'es2022' }).outputFiles[0].text;
  const module = await newQuickJSWASMModuleFromVariant(variant), context = module.newContext();
  try {
    const evaluated = context.evalCode(source);
    if (evaluated.error) { const error = context.dump(evaluated.error); evaluated.error.dispose(); throw new Error(JSON.stringify(error)); }
    evaluated.value.dispose();
    const value = context.getProp(context.global, 'result');
    try {
      const actual = context.dump(value) as MapAssemblyManifest;
      expect(actual.diagnostics).toEqual(expected.diagnostics);
      // JSON normalizes signed zero, which has no geometric meaning.
      expect(JSON.stringify(geometry(actual))).toBe(JSON.stringify(geometry(expected)));
      expect(actual.revision).toBe(expected.revision);
      expect(actual.scene.staticMap?.revision).toBe(expected.revision);
      expect(actual.scene.colliders).toEqual(expected.scene.colliders);
    } finally { value.dispose(); }
  } finally { context.dispose(); }
});
