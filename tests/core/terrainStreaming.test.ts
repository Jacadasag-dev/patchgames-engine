import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { compileTerrain, compileTerrainChunk, inspectTerrainRecipe, sampleTerrain, terrainRecipeRevision, type TerrainRecipe } from '../../src/sandbox/terrain.ts';
import { TerrainStream, type TerrainInterest } from '../../src/sandbox/terrainStreaming.ts';
import { createTerrainWorld, prepareTerrainWorld, terrainInterestsFor, validateTerrainPreparedWorld } from '../../src/sandbox/terrainWorld.ts';
import { TerrainWorldView } from '../../src/sandbox/terrainView.ts';

function large(): TerrainRecipe {
  return { version: 1, seed: 42, bounds: { width: 20000, depth: 20000, cells: 32 }, base: { noise: { amplitude: 2, wavelength: 80, octaves: 2 } },
    assets: [{ id: 'tree', footprint: { kind: 'circle', radius: 1.5 }, appearance: { kind: 'tree' } }],
    regions: [{ id: 'forest', mask: { kind: 'box', width: 20000, depth: 20000, center: { x: 0, z: 0 } }, color: '#315b32',
      layers: [{ id: 'trees', assets: ['tree'], spacing: 16, density: 1 }] }] };
}
const ready = (stream: TerrainStream, interests: readonly TerrainInterest[]) => {
  let calls = 0;
  while (!stream.prepare(interests).ready) if (++calls > 128) throw new Error('Preparation did not finish');
  return stream.chunks;
};
const prepare = (world: ReturnType<typeof createTerrainWorld>, interests: readonly TerrainInterest[]) => {
  let calls = 0;
  while (!world.prepare({}, interests).ready) if (++calls > 128) throw new Error('Preparation did not finish');
  return world.read({});
};

describe('spatial terrain streaming', () => {
  it.each([undefined, { chunkSize: 64 as const, cells: 8 }])('incrementally prepares the same immutable metadata as the constructor with config %j', streaming => {
    const input = large(); input.streaming = streaming;
    input.assets[0].footprint = { kind: 'box', width: 4, depth: 6 };
    input.assets[0].collider = { shape: { kind: 'box', halfExtents: { x: 2, y: 1, z: 3 } }, offsetY: 1 };
    input.regions[0].layers[0].scale = [.5, 2];
    input.placements = [{ id: 'fixed', asset: 'tree', position: { x: 8000, z: 8000 }, scale: 3 }];
    input.overrides = { remove: ['removed-scatter-id'], pin: [{ id: 'pinned', asset: 'tree', position: { x: -8000, z: -8000 }, scale: 4 }] };
    const original = structuredClone(input), synchronous = new TerrainStream(input), work = TerrainStream.prepare(input);
    expect(work.next()).toEqual({ done: false, value: undefined });
    // Validation has taken its private copy. Interleaved caller edits cannot
    // change the identity or collision reach of that accepted generation.
    input.seed++; input.assets[0].collider.shape = { kind: 'ball', radius: 30 };
    input.overrides.pin![0].scale = 20;
    let result = work.next(), slices = 2;
    while (!result.done && slices < 8) { result = work.next(); slices++; }
    expect(result.done).toBe(true); expect(slices).toBeGreaterThan(2);
    const incremental = result.value as TerrainStream;
    expect(incremental.recipe).toEqual(synchronous.recipe);
    expect(incremental.revision).toBe(synchronous.revision);
    expect(incremental.inspection()).toEqual(synchronous.inspection());
    expect(incremental.colliderReach).toBe(Math.hypot(2, 3) * 4);
    expect(incremental.chunks).toEqual([]);
    expect(incremental.inspection()).toMatchObject({ generated: 0, cached: 0, loaded: [] });
    for (const value of [incremental.recipe, incremental.recipe.assets, incremental.recipe.assets[0].collider!.shape,
      incremental.recipe.regions[0].layers[0].scale, incremental.recipe.overrides!.pin![0].position]) expect(Object.isFrozen(value)).toBe(true);
    expect(synchronous.recipe.seed).toBe(original.seed);
    const interests = [{ x: 64, z: 64, radius: 1 }];
    expect(ready(incremental, interests)).toEqual(ready(synchronous, interests));
  });

  it('rejects the same invalid global metadata in incremental and synchronous preparation before generating chunks', () => {
    const invalidSeed = large(); invalidSeed.seed = -1;
    const invalidConfig = large(); invalidConfig.streaming = { cells: 33 };
    const invalidRoute = large(); invalidRoute.routes = [{ id: 'broken', width: 3, points: [{ x: 0, z: 0 }, { x: 0, z: 0 }] }];
    const conflict = large(); conflict.placements = [
      { id: 'one', asset: 'tree', position: { x: 5000, z: 5000 } }, { id: 'two', asset: 'tree', position: { x: 5000, z: 5000 } },
    ];
    for (const input of [invalidSeed, invalidConfig, invalidRoute, conflict]) {
      let error: unknown;
      try { new TerrainStream(input); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      const work = TerrainStream.prepare(input);
      expect(() => { for (let n = 0; n < 8; n++) if (work.next().done) throw new Error('Invalid metadata was accepted'); })
        .toThrow((error as Error).message);
    }
  });

  it.each([2, 13])('groups repeated chunk warnings while preserving %i distinct issues and honest truncation', count => {
    const world = createTerrainWorld(() => ({ version: 1, seed: 1, bounds: { width: 512, depth: 512, cells: 16 }, assets: [], regions: [],
      routes: Array.from({ length: count }, (_, i) => ({ id: `narrow-${i}`, width: 1,
        points: [{ x: -50 + i * 8, z: -40 }, { x: -50 + i * 8, z: 40 }] })) }));
    const snapshot = prepareTerrainWorld(world, {}, [{ x: 0, z: 0 }]);
    const report = snapshot.inspection() as ReturnType<typeof snapshot.inspection> & {
      issueOccurrenceCount: number; issues: (ReturnType<typeof snapshot.inspection>['issues'][number] & { chunks: string[] })[] };
    expect(snapshot.chunks).toHaveLength(4);
    expect(report.issueCount).toBe(count); expect(report.issueOccurrenceCount).toBe(count * 4);
    expect(report.issues).toHaveLength(Math.min(count, 12)); expect(report.truncated).toBe(count > 12);
    expect(report.issues.map(issue => issue.ids)).toEqual(Array.from({ length: count }, (_, i) => `narrow-${i}`).sort().slice(0, 12).map(id => [id]));
    for (const { chunks, ...issue } of report.issues) {
      expect(chunks).toEqual(snapshot.streaming.loaded);
      for (const chunk of snapshot.chunks) expect(chunk.manifest.diagnostics.issues).toContainEqual(issue);
    }
  });

  it('validates global constraints without generating the enormous world, then bounds actual generation to one window', () => {
    const recipe = large(), metadata = inspectTerrainRecipe(recipe);
    expect(metadata.valid).toBe(true); expect(metadata.counts.candidates).toBe(0);
    const chunk = compileTerrainChunk(recipe, { x: 0, z: 0, size: 128 });
    expect(chunk.diagnostics.valid).toBe(true);
    expect(chunk.diagnostics.counts.candidates).toBeLessThan(150);
    expect(chunk.heights).toHaveLength(1089);
    expect(chunk.instances.length).toBeGreaterThan(40);
    expect(chunk.instances.every(instance => instance.position.x >= 0 && instance.position.x < 128 && instance.position.z >= 0 && instance.position.z < 128)).toBe(true);
    recipe.placements = [{ id: 'bad', asset: 'tree', position: { x: 5000, z: 5000 } }, { id: 'overlap', asset: 'tree', position: { x: 5000, z: 5000 } }];
    expect(inspectTerrainRecipe(recipe).issues.some(issue => issue.code === 'protected-overlap')).toBe(true);
  });

  it('keeps shared seam samples, world coordinates, and independent chunk generation identical on revisit', () => {
    const recipe = large();
    recipe.routes = [{ id: 'world-road', points: [{ x: -9000, z: 64 }, { x: 9000, z: 64 }], width: 12, shoulder: 4, grade: { strength: .5 } }];
    const left = compileTerrainChunk(recipe, { x: 0, z: 0, size: 128 }), right = compileTerrainChunk(recipe, { x: 1, z: 0, size: 128 });
    expect(left.diagnostics.valid).toBe(true); expect(right.diagnostics.valid).toBe(true);
    for (let row = 0; row <= 32; row++) {
      expect(left.heights[32 * 33 + row]).toBe(right.heights[row]);
      expect(left.colors[32 * 33 + row]).toBe(right.colors[row]);
      expect(sampleTerrain(left, 128, row * 4).height).toBe(sampleTerrain(right, 128, row * 4).height);
    }
    expect(compileTerrainChunk(recipe, { x: 0, z: 0, size: 128 })).toEqual(left);
    expect(new Set([...left.instances, ...right.instances].map(instance => instance.id)).size).toBe(left.instances.length + right.instances.length);
    for (const a of left.instances) for (const b of right.instances) expect(Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z)).toBeGreaterThan(3);
  });

  it('retains complete metadata diagnostics without generating or hashing a discarded surface', () => {
    // Captured from the original four independent hash passes, including UTF-16.
    expect(terrainRecipeRevision({ version: 1, seed: 17, bounds: { width: 512, depth: 768 },
      assets: [{ id: '🌲', footprint: { kind: 'circle', radius: 1 } }], regions: [] }))
      .toBe('terrain-stream-v1:d0e6afaced7740ea3d939b40274c8b6e');
    const base = large(); base.bounds = { width: 128, depth: 128, cells: 16 }; base.regions = [];
    const invalidSeed = structuredClone(base); invalidSeed.seed = -1;
    const invalidNoise = structuredClone(base); invalidNoise.base!.noise!.octaves = 7;
    const invalidRoute = structuredClone(base); invalidRoute.routes = [{ id: 'bad', width: 2, points: [{ x: 0, z: 0 }, { x: 0, z: 0 }] }];
    const overlap = structuredClone(base); overlap.placements = [
      { id: 'first', asset: 'tree', position: { x: 5, z: 5 } }, { id: 'second', asset: 'tree', position: { x: 5, z: 5 } },
    ];
    for (const recipe of [base, invalidSeed, invalidNoise, invalidRoute, overlap]) {
      const metadata = inspectTerrainRecipe(recipe), compiled = compileTerrain(recipe).diagnostics;
      expect(metadata.valid).toBe(compiled.valid); expect(metadata.issues).toEqual(compiled.issues);
      expect(metadata.sampling).toEqual(compiled.sampling); expect(metadata.counts).toEqual({ candidates: 0, instances: 0, colliders: 0, excluded: 0 });
    }
  });

  it('generates at most one missing chunk per prepare and atomically publishes complete multiplayer interest', () => {
    const stream = new TerrainStream(large()), first = stream.prepare([{ x: 0, z: 0 }]);
    expect(first.ready).toBe(false); expect(first.pending).toBe(3); expect(stream.chunks).toHaveLength(0);
    const initial = ready(stream, [{ x: 0, z: 0 }]); expect(initial).toHaveLength(4);
    const players = Array.from({ length: 32 }, (_, i) => ({ x: -8192 + i * 512, z: 4096 }));
    const before = stream.inspection().generated;
    expect(stream.prepare(players).ready).toBe(false); expect(stream.chunks).toHaveLength(0);
    expect(stream.prepared([{ x: 0, z: 0 }])).toBe(false);
    expect(stream.prepared(players)).toBe(false);
    expect(stream.inspection().generated).toBe(before + 1);
    const union = ready(stream, players); expect(union).toHaveLength(128);
    expect(stream.prepared(players)).toBe(true);
    expect(union.every(chunk => chunk.manifest.diagnostics.valid)).toBe(true);
    expect(stream.inspection().missing).toEqual([]);
    expect(() => stream.prepare([{ x: 0, z: 0, radius: 10000 }])).toThrow('budget');
    expect(stream.chunks).toBe(union);
    expect(() => stream.prepare(players.map(player => ({ ...player, x: player.x + 30, velocity: { x: 128, z: 0 } })))).toThrow('budget');
    expect(stream.chunks).toBe(union);
    expect(() => stream.prepare(players, [{ x: 64, z: 64 }])).toThrow('budget');
    expect(stream.chunks).toBe(union);
  });

  it('evicts derived chunks, regenerates stable identities, and preserves serializable removals independently of visit order', () => {
    const recipe = large(), stream = new TerrainStream(recipe);
    const original = ready(stream, [{ x: 64, z: 64 }])[0];
    for (let group = 0; group < 3; group++) ready(stream, Array.from({ length: 32 }, (_, i) => ({ x: -8192 + i * 512, z: 1024 + group * 1024 })));
    expect(stream.inspection().cached).toBeLessThanOrEqual(128); expect(stream.inspection().evicted).toBeGreaterThan(0);
    expect(stream.prepared([{ x: 64, z: 64 }])).toBe(false);
    expect(ready(stream, [{ x: 64, z: 64 }])[0]).toEqual(original);
    expect(stream.prepared([{ x: 64, z: 64 }])).toBe(true);
    const edits = { remove: [original.manifest.instances[0].id] };
    const world = createTerrainWorld(large); world.setEdits(JSON.parse(JSON.stringify(edits)));
    const edited = prepare(world, [{ x: 64, z: 64 }]);
    expect(edited.instances.some(instance => instance.id === edits.remove[0])).toBe(false);
    expect(edited.instances).toEqual(original.manifest.instances.slice(1));
    world.setEdits({}); expect(prepare(world, [{ x: 64, z: 64 }]).instances).toEqual(original.manifest.instances);
  });

  it('matches readiness to generated required IDs without skipping interest or union validation', () => {
    const recipe: TerrainRecipe = { version: 1, seed: 1, bounds: { width: 20000, depth: 20000 }, assets: [], regions: [] };
    const players = Array.from({ length: 32 }, (_, i) => ({ x: -8192 + i * 512, z: 4096 }));
    const stream = new TerrainStream(recipe), loaded = new Set(ready(stream, players).map(chunk => chunk.id));
    expect(loaded.size).toBe(128);
    type Plan = [readonly TerrainInterest[] | undefined, readonly TerrainInterest[] | undefined];
    const valid: Plan[] = [
      [players, undefined], [players.map(point => ({ ...point, x: point.x + 1, velocity: { x: -2, z: 0 } })), undefined],
      [players.slice(0, 16), players.slice(16)], [players, players],
      [Array.from({ length: 32 }, () => players[0]), undefined],
      [undefined, undefined], [[], []],
      [[{ x: 10000, z: 10000, radius: 0, velocity: { x: 1000, z: 1000 } }, { x: -10000, z: -10000, radius: 0 }], undefined],
      [[{ x: 64, z: 64, radius: 1, velocity: { x: 128, z: -128 } }], [{ x: 128, z: -128 }]],
    ];
    for (const [interests, initial] of valid) {
      const generated = new TerrainStream(recipe);
      for (let count = 0; count < 128 && !generated.prepare(interests, initial).ready; count++) { /* One chunk per call. */ }
      expect(generated.inspection().ready).toBe(true);
      const expected = generated.chunks.every(chunk => loaded.has(chunk.id));
      const before = stream.inspection();
      expect(stream.prepared(interests, initial)).toBe(expected);
      expect(stream.inspection()).toEqual(before);
    }
    const invalid: Plan[] = [
      [[...players, players[0]], undefined], [players, [{ x: 64, z: 64 }]],
      [[{ x: 0, z: 0, radius: 10000 }], undefined],
      [players.map(point => ({ ...point, x: point.x + 30, velocity: { x: 128, z: 0 } })), undefined],
      [[{ x: 0, z: 0 }, ...players.slice(1, 31), { x: NaN, z: 0 }], undefined],
      [[{ x: 0, z: 0, radius: -1 }], undefined], [[{ x: 10001, z: 0 }], undefined],
      [[{ x: 0, z: 0, velocity: { x: Infinity, z: 0 } }], undefined],
      [players, [...players, players[0]]], [null as unknown as TerrainInterest[], undefined],
    ];
    for (const [interests, initial] of invalid) {
      let error: unknown;
      try { new TerrainStream(recipe).prepare(interests, initial); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      const before = stream.inspection();
      expect(() => stream.prepared(interests, initial)).toThrow((error as Error).message);
      expect(stream.inspection()).toEqual(before);
    }
    const ordered = new TerrainStream(recipe);
    expect(ordered.prepare([{ x: 0, z: 0 }]).pending).toBe(3);
    expect(ordered.inspection().missing).toEqual(['-1:0', '0:-1', '0:0']);
    expect(ordered.prepared([{ x: 0, z: 0 }])).toBe(false);
    expect(ordered.prepare([{ x: 0, z: 0 }]).pending).toBe(2);
    expect(ordered.inspection().missing).toEqual(['0:-1', '0:0']);
  });

  it('exposes only loaded support/collision and renders/disposes resident chunks rather than the whole world', () => {
    const world = createTerrainWorld(large), empty = world.read({});
    expect(empty.manifest).toBeUndefined(); expect(empty.instances).toEqual([]); expect(empty.available(64, 64)).toBe(false);
    expect(() => empty.sample(64, 64)).toThrow('not loaded'); expect(empty.clearance({ x: 64, y: 0, z: 64 }, .4, 1.8)).toBe(false);
    const loaded = prepare(world, [{ x: 64, z: 64 }]);
    expect(loaded.available(64, 64, 1)).toBe(true); expect(loaded.available(127, 64, 2)).toBe(false);
    expect(loaded.footSupports({ here: { x: 64, z: 64 }, distant: { x: 5000, z: 5000 } }, 10)).toHaveProperty('here');
    expect(loaded.footSupports({ distant: { x: 5000, z: 5000 } }, 10)).toEqual({});
    expect(loaded.scene.terrainChunks).toHaveLength(1);
    expect(world.read({}).scene).toBe(loaded.scene);
    const view = new TerrainWorldView(loaded), oldRoot = view.root.children[0];
    let disposed = false;
    oldRoot.traverse(object => { if (object instanceof THREE.Mesh) object.geometry.addEventListener('dispose', () => { disposed = true; }); });
    view.update(prepare(world, [{ x: 1088, z: 64 }]));
    expect(view.root.children).toHaveLength(1); expect(view.root.children[0]).not.toBe(oldRoot); expect(disposed).toBe(true);
    expect(view.inspection()).toMatchObject({ renderedChunks: 1 }); view.dispose(); expect(view.root.children).toHaveLength(0);
  });

  it('uses authored initial interests and the same live actor/motion extraction in every caller', () => {
    const world = createTerrainWorld(large, { initialInterests: () => [{ x: 1088, z: 64 }] });
    expect(world.prepare({}).ready).toBe(true); expect(world.read({}).available(1088, 64)).toBe(true); expect(world.read({}).available(0, 0)).toBe(false);
    expect(terrainInterestsFor([{ hp: 0, state: { x: 1, z: 2 } }, { state: { x: 3, z: 4, velocityX: 5, velocityZ: 6 } },
      { state: { x: 7, z: 8, vx: 9, vz: 10 } }, { state: { x: NaN, z: 0 } }])).toEqual([
      { x: 3, z: 4, velocity: { x: 5, z: 6 } }, { x: 7, z: 8, velocity: { x: 9, z: 10 } },
    ]);
  });

  it.each([32, 128, 512] as const)('keeps exact loaded-footprint boundaries and old snapshots with %im chunks', chunkSize => {
    const recipe: TerrainRecipe = { version: 1, seed: 31, bounds: { width: chunkSize * 6, depth: chunkSize * 6 },
      streaming: { chunkSize, cells: 8 }, assets: [], regions: [] };
    const world = createTerrainWorld(() => recipe);
    const original = prepareTerrainWorld(world, {}, [{ x: -chunkSize / 2, z: -chunkSize / 2, radius: 0 }]);
    expect(original.chunks.map(chunk => chunk.id)).toEqual(['-1:-1']);
    expect(original.available(-chunkSize / 2, -chunkSize / 2, chunkSize / 2)).toBe(true);
    expect(original.available(-chunkSize / 2, -chunkSize / 2, chunkSize / 2 + .001)).toBe(false);
    // A point on a resident seam is supported; a footprint crossing it needs
    // both neighboring chunks, including on the negative side of the origin.
    for (const x of [-chunkSize, 0]) {
      expect(original.available(x, -chunkSize / 2)).toBe(true);
      expect(original.available(x, -chunkSize / 2, .001)).toBe(false);
    }
    const moved = prepareTerrainWorld(world, {}, [{ x: chunkSize / 2, z: chunkSize / 2, radius: 0 }]);
    expect(moved.chunks.map(chunk => chunk.id)).toEqual(['0:0']);
    expect(moved.available(-chunkSize / 2, -chunkSize / 2, 1)).toBe(false);
    expect(original.available(-chunkSize / 2, -chunkSize / 2, 1)).toBe(true);
    expect(original.available(chunkSize / 2, chunkSize / 2, 1)).toBe(false);
    const client = createTerrainWorld(() => recipe);
    client.adoptPrepared({}, validateTerrainPreparedWorld(world.exportPrepared({})), true);
    expect(client.read({}).available(chunkSize / 2, chunkSize / 2, chunkSize / 2)).toBe(true);
    expect(client.read({}).available(chunkSize / 2, chunkSize / 2, chunkSize / 2 + .001)).toBe(false);
    const edge = prepareTerrainWorld(world, {}, [{ x: -chunkSize * 3, z: chunkSize * 3, radius: 0 }]);
    expect(edge.available(-chunkSize * 3, chunkSize * 3)).toBe(true);
    expect(edge.available(-chunkSize * 3, chunkSize * 3, .001)).toBe(false);
  });

  it('prepares evicted off-origin spawn interest together with current players before a join or respawn', () => {
    const world = createTerrainWorld(large, { initialInterests: () => [{ x: 1088, z: 64 }] });
    const initial = prepareTerrainWorld(world, {});
    expect(initial.available(1088, 64, 1)).toBe(true);
    const players = [{ x: 64, z: 64 }];
    const moved = prepareTerrainWorld(world, {}, players);
    expect(moved.available(1088, 64, 1)).toBe(false);
    expect(world.prepared({}, players, true)).toBe(false);
    const combined = prepareTerrainWorld(world, {}, players, true);
    expect(combined.available(64, 64, 1)).toBe(true);
    expect(combined.available(1088, 64, 1)).toBe(true);
    expect(combined.chunks).toHaveLength(2);
    expect(combined.chunks.find(chunk => chunk.id === initial.chunks[0].id)).toEqual(initial.chunks[0]);
  });

  it('projects serializable world edits without generation and applies them identically in a fresh host', () => {
    const options = { edits: (world: { removedId?: string } | undefined) => world?.removedId ? { remove: [world.removedId] } : {} };
    const world = createTerrainWorld(large, options), interests = [{ x: 64, z: 64 }];
    const original = prepareTerrainWorld(world, {}, interests), state = { removedId: original.instances[0].id };
    world.sync({}, state);
    expect(world.prepared({}, interests)).toBe(false); expect(world.read({}).streaming.generated).toBe(0);
    const edited = prepareTerrainWorld(world, {}, interests), fresh = createTerrainWorld(large, options);
    fresh.sync({}, JSON.parse(JSON.stringify(state)));
    const regenerated = prepareTerrainWorld(fresh, {}, interests);
    expect(regenerated.instances).toEqual(edited.instances); expect(regenerated.scene).toEqual(edited.scene);
    expect(edited.instances.some(instance => instance.id === state.removedId)).toBe(false);
  });

  it('loads neighboring owner chunks for obstacles extending across a seam before declaring player collision ready', () => {
    const recipe: TerrainRecipe = { version: 1, seed: 1, bounds: { width: 512, depth: 512 }, regions: [],
      assets: [{ id: 'wall', footprint: { kind: 'box', width: 80, depth: 8 },
        collider: { offsetY: 2, shape: { kind: 'box', halfExtents: { x: 40, y: 2, z: 4 } } } }],
      placements: [{ id: 'seam-wall', asset: 'wall', position: { x: 140, z: 64 } }] };
    const world = createTerrainWorld(() => recipe), interests = [{ x: 110, z: 64, radius: 2 }];
    expect(world.prepare({}, interests).ready).toBe(false);
    expect(world.prepared({}, interests)).toBe(false);
    const accepted = prepare(world, interests);
    expect(accepted.chunks.map(chunk => chunk.id)).toEqual(['0:0', '1:0']);
    expect(accepted.instances.map(instance => instance.id)).toEqual(['seam-wall']);
    expect(accepted.scene.colliders).toHaveLength(1);
    expect(accepted.available(110, 64, .5)).toBe(true);
    expect(accepted.clearance({ x: 110, y: 0, z: 64 }, .5, 1.8)).toBe(false);
    const client = createTerrainWorld(() => recipe);
    client.adoptPrepared({}, validateTerrainPreparedWorld(world.exportPrepared({})), true);
    expect(client.prepared({}, interests)).toBe(true);
    expect(client.read({}).scene).toEqual(accepted.scene);
    expect(client.read({}).available(20, 64, .5)).toBe(false);
  });

  it('retains required collision and scene identity during pending preparation, with honest readiness diagnostics', () => {
    const world = createTerrainWorld(large), current = [{ x: 64, z: 64 }];
    const initial = prepare(world, current);
    const wanted = [...current, { x: 2048, z: 0 }];
    const progress = world.prepare({}, wanted), pending = world.read({});
    expect(progress.ready).toBe(false); expect(pending.streaming.ready).toBe(false);
    expect(pending.scene).toBe(initial.scene); expect(pending.available(64, 64, 1)).toBe(true);
    expect(pending.available(2048, 0, 1)).toBe(false); expect(world.prepared({}, wanted)).toBe(false);
    expect(() => world.exportPrepared({})).toThrow('complete');
    const accepted = prepare(world, wanted);
    expect(accepted.available(2048, 0, 1)).toBe(true); expect(accepted.scene).not.toBe(initial.scene);
    expect(accepted.inspection().changes.surfaceChanged).toBe(true);
  });

  it('transfers only prepared geometry into matching streamed/eager clients without generation and rejects stale or altered data atomically', () => {
    for (const width of [64, 20000]) {
      const recipe = large(); recipe.bounds.width = recipe.bounds.depth = width;
      const authority = createTerrainWorld(() => recipe), client = createTerrainWorld(() => recipe);
      const interests = [{ x: width === 64 ? 0 : 64, z: width === 64 ? 0 : 64 }];
      const original = prepare(authority, interests), transfer = JSON.parse(JSON.stringify(authority.exportPrepared({})));
      const fastClient = createTerrainWorld(() => recipe), verified = validateTerrainPreparedWorld(transfer);
      expect(fastClient.adoptPrepared({}, verified, true).ready).toBe(true);
      expect(fastClient.read({}).scene).toEqual(original.scene);
      expect(fastClient.read({}).instances).toEqual(original.instances);
      expect(client.prepared({}, interests)).toBe(false);
      expect(client.adoptPrepared({}, transfer).ready).toBe(true);
      const adopted = client.read({});
      expect(adopted.scene).toEqual(original.scene); expect(adopted.instances).toEqual(original.instances);
      expect(adopted.loadedRevision).toBe(original.loadedRevision); expect(client.prepared({}, interests)).toBe(true);
      expect(client.prepared({ changed: true }, interests)).toBe(false);
      const altered = structuredClone(transfer); altered.revision += '-stale';
      expect(() => client.adoptPrepared({}, altered)).toThrow('revision'); expect(client.read({})).toBe(adopted);
      const geometry = structuredClone(transfer);
      (geometry.eager ?? geometry.streamed.chunks[0].manifest).heights[0] += 1;
      expect(() => client.adoptPrepared({}, geometry)).toThrow('checksum'); expect(client.read({})).toBe(adopted);
      if (width > 64) {
        expect(adopted.chunks.every(chunk => chunk.manifest.recipe === adopted.recipe && Object.isFrozen(chunk.manifest.heights))).toBe(true);
        expect(adopted.streaming.generated).toBe(0);
        expect(client.prepared({}, [{ x: 1088, z: 64 }])).toBe(false);
        expect(client.read({}).streaming.generated).toBe(0);
      }
    }
  });

  it('preserves the accepted cache when a verified transfer targets a different tuning revision', () => {
    const world = createTerrainWorld((tuning: { seed: number }) => ({ ...large(), seed: tuning.seed }));
    const tuning = { seed: 1 }, interests = [{ x: 64, z: 64 }];
    while (!world.prepare(tuning, interests).ready) { /* one chunk per call */ }
    const accepted = world.read(tuning), transferred = validateTerrainPreparedWorld(world.exportPrepared(tuning));
    expect(() => world.adoptPrepared({ seed: 2 }, transferred, true)).toThrow('revision');
    expect(world.read(tuning)).toBe(accepted); expect(world.prepared(tuning, interests)).toBe(true);
  });
});
