/** Bounded world-space PBR baking. Standard materials work on both renderers;
 * shared integer texel coordinates and two-texel gutters keep chunk seams equal. */
import * as THREE from 'three';
import { createTerrainHeightSampler, sampleTerrain, type TerrainManifest, type TerrainRecipe, type TerrainMask, type TerrainRoute } from './terrain.ts';
import { resolveSurfaceMaterial, type ResolvedSurfaceMaterial, type SurfaceMaterialInput } from './surfaceMaterials.ts';
import { SurfaceMaterialCache, trackSurfaceMaterialWork } from './surfaceMaterialView.ts';
import { resolveTerrainChannels, sampleTerrainChannel } from './terrainChannels.ts';
import { createTerrainBaseHeightSampler } from './terrain.ts';
import type { MaterialSurfaceFields, TexturePixels } from '../shared/materialRecipeRenderer.ts';

export interface TerrainMaterialOptions {
  /** Requested world texel density; bounded 0.25..32. Defaults to 8. */
  texelsPerMetre?: number;
  /** Atlas side limit including gutters, 16..512. Defaults to 512. Density is
   * reduced consistently for the world when needed and reported by inspection. */
  maxResolution?: number;
  /** Global height-mask normalization. Default is the conservative recipe range,
   * shared by every chunk. Slope masks use atan(rise/run)/(PI/2). */
  elevationRange?: [number, number];
  /** Maximum material/color layers affecting one chunk, including base. */
  maxLayers?: number;
}
export interface TerrainMaterialAtlas {
  material: THREE.MeshStandardMaterial;
  ready: Promise<void>;
  inspection(): { resolution: number; texelsPerMetre: number; requestedTexelsPerMetre: number; densityReduced: boolean; layers: number; status: 'loading' | 'ready' | 'error' | 'disposed'; error?: string; elevationRange: [number, number] };
  dispose(): void;
}
type Lease = ReturnType<SurfaceMaterialCache['acquire']>;
interface AtlasJob { run(): Promise<void>; resolve(): void; reject(error: unknown): void; cancelled: boolean; stop?: () => void }
interface AtlasQueue { active: number; jobs: AtlasJob[]; tiles: Map<string, Lease> }
const queues = new WeakMap<SurfaceMaterialCache, AtlasQueue>();
function queueFor(cache: SurfaceMaterialCache): AtlasQueue {
  let queue = queues.get(cache); if (!queue) { queue = { active: 0, jobs: [], tiles: new Map() }; queues.set(cache, queue); } return queue;
}
function enqueueAtlas(cache: SurfaceMaterialCache, run: () => Promise<void>): { ready: Promise<void>; cancel(): void } {
  const queue = queueFor(cache);
  if (queue.jobs.length + queue.active >= 128) throw new Error('Terrain material preparation exceeds its 128-atlas queue budget.');
  let job!: AtlasJob;
  const ready = new Promise<void>((resolve, reject) => { job = { run, resolve, reject, cancelled: false }; });
  const pump = () => {
    while (queue.active < 2 && queue.jobs.length) {
      const next = queue.jobs.shift()!; if (next.cancelled) continue; queue.active++;
      const cancelled = new Promise<void>(resolve => { next.stop = resolve; });
      void Promise.race([next.run(), cancelled]).then(next.resolve, next.reject).finally(() => {
        queue.active--; pump();
        if (!queue.active && !queue.jobs.length) { queue.tiles.forEach(lease => lease.dispose()); queue.tiles.clear(); }
      });
    }
  };
  queue.jobs.push(job); void Promise.resolve().then(pump);
  return { ready, cancel() {
    if (job.cancelled) return; job.cancelled = true;
    const index = queue.jobs.indexOf(job); if (index >= 0) { queue.jobs.splice(index, 1); job.resolve(); }
    else job.stop?.();
    if (!queue.active && !queue.jobs.length) { queue.tiles.forEach(lease => lease.dispose()); queue.tiles.clear(); }
  } };
}
function atlasTile(cache: SurfaceMaterialCache, material: ResolvedSurfaceMaterial): Lease {
  const queue = queueFor(cache); let lease = queue.tiles.get(material.key);
  if (!lease) { lease = cache.acquire(material); queue.tiles.set(material.key, lease); } return lease;
}
interface Layer { id: string; source?: SurfaceMaterialInput; color?: string; weight: (x: number, z: number) => number }
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const smooth = (n: number) => { const t = clamp(n); return t * t * (3 - 2 * t); };
const linear = (s: number) => s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4;
const srgb = (s: number) => s <= .0031308 ? 12.92 * s : 1.055 * s ** (1 / 2.4) - .055;
const order = <T extends { id: string }>(values: T[]) => [...values].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
function regionWeight(mask: TerrainMask, blend: number, x: number, z: number): number {
  const c = Math.cos(mask.yaw ?? 0), s = Math.sin(mask.yaw ?? 0), dx = x - mask.center.x, dz = z - mask.center.z;
  const u = Math.abs(dx * c - dz * s), v = Math.abs(dx * s + dz * c);
  const a = mask.kind === 'box' ? u - mask.width / 2 : 0, b = mask.kind === 'box' ? v - mask.depth / 2 : 0;
  const distance = mask.kind === 'circle' ? Math.hypot(u, v) - mask.radius : Math.hypot(Math.max(0, a), Math.max(0, b)) + Math.min(0, Math.max(a, b));
  return distance > 0 ? 0 : blend > 0 ? smooth(-distance / blend) : 1;
}
function routeWeight(route: TerrainRoute, fallbackShoulder: number, x: number, z: number): number {
  let distance = Infinity;
  for (let i = 1; i < route.points.length; i++) {
    const a = route.points[i - 1], b = route.points[i], dx = b.x - a.x, dz = b.z - a.z;
    const t = clamp(((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz));
    distance = Math.min(distance, Math.hypot(x - a.x - t * dx, z - a.z - t * dz));
  }
  return distance <= route.width / 2 ? 1 : 1 - smooth((distance - route.width / 2) / (route.shoulder || fallbackShoulder));
}
export function hasTerrainMaterials(recipe: TerrainRecipe): boolean {
  return !!recipe.material || recipe.regions.some(region => !!region.material) || !!recipe.routes?.some(route => !!route.material)
    || !!recipe.channels?.some(channel => !!channel.material);
}
function heightRange(recipe: TerrainRecipe): [number, number] {
  let noise = 0;
  if (recipe.base?.noise) for (let i = 0; i < (recipe.base.noise.octaves ?? 3); i++) noise += recipe.base.noise.amplitude / 2 ** i;
  let low = (recipe.base?.height ?? 0) - noise, high = (recipe.base?.height ?? 0) + noise;
  for (const region of recipe.regions) { low += Math.min(0, region.elevation ?? 0); high += Math.max(0, region.elevation ?? 0); }
  if (recipe.channels?.length) for (const channel of resolveTerrainChannels(recipe.channels, createTerrainBaseHeightSampler(recipe)))
    for (const point of channel.points) low = Math.min(low, point.bedY);
  for (const route of recipe.routes ?? []) for (const point of route.points) if (point.y !== undefined) { low = Math.min(low, point.y); high = Math.max(high, point.y); }
  for (const p of [...recipe.placements ?? [], ...recipe.overrides?.pin ?? []]) if (p.foundation?.height !== undefined || p.position.y !== undefined) {
    const y = p.foundation?.height ?? p.position.y!; low = Math.min(low, y); high = Math.max(high, y);
  }
  return high - low < 1e-8 ? [low - .5, high + .5] : [low, high];
}
/** Use accepted triangles locally. A gutter can extend into an unloaded chunk;
 * reproduce only its four Float32 vertex samples on the same global grid. */
function surfaceHeight(manifest: TerrainManifest, nominal: number): (x: number, z: number) => number {
  const analytic = createTerrainHeightSampler(manifest.recipe), vertices = new Map<string, number>();
  const ownX = (manifest.origin?.x ?? 0) - manifest.bounds.width / 2, ownZ = (manifest.origin?.z ?? 0) - manifest.bounds.depth / 2;
  const width = manifest.recipe.bounds.width, depth = manifest.recipe.bounds.depth;
  const at = (x: number, z: number) => {
    const key = `${x}:${z}`; let height = vertices.get(key);
    if (height === undefined) { height = Math.fround(analytic(x, z)); vertices.set(key, height); } return height;
  };
  return (x, z) => {
    x = Math.max(-width / 2, Math.min(width / 2, x)); z = Math.max(-depth / 2, Math.min(depth / 2, z));
    if (!manifest.origin || x >= ownX && x <= ownX + manifest.bounds.width && z >= ownZ && z <= ownZ + manifest.bounds.depth) return sampleTerrain(manifest, x, z).height;
    const cx = Math.min(Math.ceil(width / 2 / nominal) - 1, Math.floor(x / nominal)), cz = Math.min(Math.ceil(depth / 2 / nominal) - 1, Math.floor(z / nominal));
    const x0 = Math.max(-width / 2, cx * nominal), z0 = Math.max(-depth / 2, cz * nominal), x1 = Math.min(width / 2, (cx + 1) * nominal), z1 = Math.min(depth / 2, (cz + 1) * nominal);
    const gx = clamp((x - x0) / (x1 - x0)) * manifest.columns, gz = clamp((z - z0) / (z1 - z0)) * manifest.rows;
    const col = Math.min(manifest.columns - 1, Math.floor(gx)), row = Math.min(manifest.rows - 1, Math.floor(gz)), u = gx - col, v = gz - row;
    const ax = x0 + col / manifest.columns * (x1 - x0), bx = x0 + (col + 1) / manifest.columns * (x1 - x0);
    const az = z0 + row / manifest.rows * (z1 - z0), bz = z0 + (row + 1) / manifest.rows * (z1 - z0);
    const a = at(ax, az), b = at(bx, az), c = at(ax, bz), d = at(bx, bz);
    return u + v <= 1 ? a + (b - a) * u + (c - a) * v : d + (c - d) * (1 - u) + (b - d) * (1 - v);
  };
}
function pixels(texture: THREE.Texture | null): TexturePixels {
  const image = texture?.image as TexturePixels | undefined;
  if (!image || !(image.data instanceof Uint8Array) || !Number.isInteger(image.width) || !Number.isInteger(image.height)) throw new Error('Terrain material requires cached RGBA8 recipe maps.');
  return image;
}
function sample(map: TexturePixels, u: number, v: number, channel: number, repeat: boolean): number {
  const wrap = (n: number, span: number) => repeat ? (n % span + span) % span : Math.max(0, Math.min(span - 1, n));
  const x = (repeat ? (u % 1 + 1) % 1 : clamp(u)) * map.width - .5, y = (repeat ? (v % 1 + 1) % 1 : clamp(v)) * map.height - .5;
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const at = (dx: number, dy: number) => map.data[(wrap(iy + dy, map.height) * map.width + wrap(ix + dx, map.width)) * 4 + channel] / 255;
  return (at(0, 0) * (1 - fx) + at(1, 0) * fx) * (1 - fy) + (at(0, 1) * (1 - fx) + at(1, 1) * fx) * fy;
}

export function createTerrainMaterialAtlas(manifest: TerrainManifest, cache: SurfaceMaterialCache, options: TerrainMaterialOptions = {}, routeOnly?: TerrainRoute): TerrainMaterialAtlas {
  const queue = queueFor(cache);
  if (queue.active + queue.jobs.length >= 128) throw new Error('Terrain material preparation exceeds its 128-atlas queue budget.');
  const requested = options.texelsPerMetre ?? 8, limit = options.maxResolution ?? 512, maxLayers = options.maxLayers ?? 32;
  if (!Number.isFinite(requested) || requested < .25 || requested > 32 || !Number.isInteger(limit) || limit < 16 || limit > 512
    || !Number.isInteger(maxLayers) || maxLayers < 1 || maxLayers > 113) throw new Error('Terrain material budget requires density .25..32, resolution16..512 and layers1..113.');
  const range = options.elevationRange ?? heightRange(manifest.recipe);
  if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite) || range[1] <= range[0]) throw new Error('Terrain elevationRange requires two increasing finite heights.');
  // Use the whole world's chunk span, never the clipped edge chunk dimensions.
  const streaming = manifest.recipe.streaming;
  const nominal = manifest.origin ? typeof streaming === 'object' ? streaming.chunkSize ?? 128 : 128 : Math.max(manifest.recipe.bounds.width, manifest.recipe.bounds.depth);
  const maximumSpan = Math.max(nominal, manifest.bounds.width, manifest.bounds.depth);
  let density = requested;
  if (maximumSpan * density + 6 > limit) density = 2 ** Math.floor(Math.log2((limit - 6) / maximumSpan));
  if (!Number.isFinite(density) || density <= 0) throw new Error('Terrain material atlas cannot fit the requested world span.');
  const minX = (manifest.origin?.x ?? 0) - manifest.bounds.width / 2, minZ = (manifest.origin?.z ?? 0) - manifest.bounds.depth / 2;
  const startX = Math.floor(minX * density) - 2, startZ = Math.floor(minZ * density) - 2;
  const size = Math.max(16, Math.ceil((minX + manifest.bounds.width) * density) - startX + 2, Math.ceil((minZ + manifest.bounds.depth) * density) - startZ + 2);
  if (size > limit) throw new Error('Terrain material atlas exceeds its reported resolution budget.');
  const span = size / density, x0 = startX / density, z0 = startZ / density;
  const layers: Layer[] = [{ id: routeOnly ? `route:${routeOnly.id}` : 'base', source: routeOnly?.material ?? manifest.recipe.material, color: routeOnly?.color ?? '#697c48', weight: () => 1 }];
  const touches = (x: number, z: number, reachX: number, reachZ = reachX) => x + reachX >= x0 && x - reachX <= x0 + span && z + reachZ >= z0 && z - reachZ <= z0 + span;
  for (const region of routeOnly ? [] : order(manifest.recipe.regions)) if (region.material || region.color) {
    const m = region.mask, reach = m.kind === 'circle' ? m.radius : Math.hypot(m.width, m.depth) / 2;
    if (touches(m.center.x, m.center.z, reach)) layers.push({ id: `region:${region.id}`, source: region.material, color: region.color, weight: (x, z) => regionWeight(m, region.blend ?? 0, x, z) });
  }
  for (const channel of routeOnly ? [] : manifest.channels ?? []) {
    const b = channel.bounds;
    if (touches((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2, (b.maxX - b.minX) / 2, (b.maxZ - b.minZ) / 2))
      layers.push({ id: `channel:${channel.id}`, source: channel.material, color: channel.color ?? (channel.kind === 'river' ? '#81715a' : '#777777'),
        weight: (x, z) => sampleTerrainChannel(channel, x, z).weight });
  }
  const cell = manifest.origin ? nominal / (typeof streaming === 'object' ? streaming.cells ?? 16 : 16) : Math.max(manifest.bounds.width / manifest.columns, manifest.bounds.depth / manifest.rows);
  for (const route of routeOnly ? [] : order(manifest.recipe.routes ?? [])) {
    const reach = route.width / 2 + (route.shoulder || cell);
    const xs = route.points.map(p => p.x), zs = route.points.map(p => p.z), lowX = Math.min(...xs), highX = Math.max(...xs), lowZ = Math.min(...zs), highZ = Math.max(...zs);
    if (touches((lowX + highX) / 2, (lowZ + highZ) / 2, (highX - lowX) / 2 + reach, (highZ - lowZ) / 2 + reach))
      layers.push({ id: `route:${route.id}`, source: route.material, color: route.color ?? '#ad9878', weight: (x, z) => routeWeight(route, cell, x, z) });
  }
  if (layers.length > maxLayers) throw new Error(`Terrain material atlas requires ${layers.length} layers; budget is ${maxLayers}.`);
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .98 });
  material.name = 'terrain-world-material';
  let status: 'loading' | 'ready' | 'error' | 'disposed' = 'loading', error: string | undefined;
  const isDisposed = () => status === 'disposed';
  const leases: Lease[] = [], owned: THREE.DataTexture[] = [];
  let cancelWork = () => {}, cancelPreparation = () => {};
  const dispose = () => { if (status === 'disposed') return; status = 'disposed'; cancelWork(); cancelPreparation(); leases.splice(0).forEach(lease => lease.dispose()); owned.forEach(map => map.dispose()); material.dispose(); };
  const preparation = enqueueAtlas(cache, async () => {
    let fields: MaterialSurfaceFields | undefined;
    const getFields = () => {
      if (fields) return fields;
      const terrain = surfaceHeight(manifest, nominal), elevation = new Float32Array(size * size), slope = new Float32Array(size * size), delta = .1;
      for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
        const x = (startX + col + .5) / density, z = (startZ + row + .5) / density, index = row * size + col;
        elevation[index] = clamp((terrain(x, z) - range[0]) / (range[1] - range[0]));
        slope[index] = Math.atan(Math.hypot((terrain(x + delta, z) - terrain(x - delta, z)) / (2 * delta), (terrain(x, z + delta) - terrain(x, z - delta)) / (2 * delta))) / (Math.PI / 2);
      }
      return fields = { width: size, height: size, elevation, slope };
    };
    const sources: { layer: Layer; resolved?: ResolvedSurfaceMaterial; lease?: Lease; world: boolean }[] = [];
    for (const layer of layers) {
      if (!layer.source) { sources.push({ layer, world: false }); continue; }
      const resolved = resolveSurfaceMaterial(layer.source, { seed: manifest.recipe.seed, key: `terrain:${layer.id}` });
      const world = resolved.texture.layers.some(item => item.mask?.field === 'surface' && item.mask.kind !== 'noise');
      const c = Math.cos(resolved.rotation), s = Math.sin(resolved.rotation), tx = resolved.tileSize[0], tz = resolved.tileSize[1];
      const coordinates = { origin: [(c * x0 + s * z0) / tx, (-s * x0 + c * z0) / tz] as [number, number],
        uAxis: [c * span / tx, -s * span / tz] as [number, number], vAxis: [s * span / tx, c * span / tz] as [number, number], metres: [span, span] as [number, number] };
      const chosen = world ? resolveSurfaceMaterial({ texture: { ...resolved.texture, resolution: size }, tileSize: resolved.tileSize, rotation: resolved.rotation, tint: resolved.tint }, { seed: manifest.recipe.seed, key: `terrain:${layer.id}:surface` }) : resolved;
      const lease = world ? cache.acquire(chosen, { surface: getFields(), coordinates }) : atlasTile(cache, chosen);
      if (world) leases.push(lease); sources.push({ layer, resolved, lease, world });
    }
    await Promise.all(sources.flatMap(source => source.lease ? [source.lease.ready] : []));
    if (isDisposed()) return;
    const count = size * size, color = new Uint8Array(count * 4), normal = new Uint8Array(count * 4), roughness = new Uint8Array(count * 4), metalness = new Uint8Array(count * 4);
    const prepared = sources.map(source => ({ ...source, tint: new THREE.Color(source.resolved?.tint ?? source.layer.color ?? '#ffffff'), maps: source.lease ? {
      color: pixels(source.lease.material.map), normal: pixels(source.lease.material.normalMap), roughness: pixels(source.lease.material.roughnessMap), metalness: pixels(source.lease.material.metalnessMap) } : undefined }));
    const baseColor = new THREE.Color(routeOnly?.color ?? '#697c48');
    for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
      const index = (row * size + col) * 4, x = (startX + col + .5) / density, z = (startZ + row + .5) / density;
      let r = baseColor.r, g = baseColor.g, b = baseColor.b, nx = 0, ny = 0, rough = .98, metal = 0;
      for (const source of prepared) {
        let weight = source.layer.weight(x, z); if (weight <= 0) continue;
        let nr = source.tint.r, ng = source.tint.g, nb = source.tint.b, nnx = 0, nny = 0, nrgh = .98, nmetal = 0;
        if (source.maps && source.resolved) {
          const { maps, resolved, world } = source, c = Math.cos(resolved.rotation), s = Math.sin(resolved.rotation);
          const u = world ? (col + .5) / size : (c * x + s * z) / resolved.tileSize[0], v = world ? (row + .5) / size : (-s * x + c * z) / resolved.tileSize[1];
          weight *= sample(maps.color, u, v, 3, !world);
          nr *= linear(sample(maps.color, u, v, 0, !world)); ng *= linear(sample(maps.color, u, v, 1, !world)); nb *= linear(sample(maps.color, u, v, 2, !world));
          const a = sample(maps.normal, u, v, 0, !world) * 2 - 1, bb = sample(maps.normal, u, v, 1, !world) * 2 - 1, n = Math.max(.01, sample(maps.normal, u, v, 2, !world) * 2 - 1);
          nnx = world ? a / n : (a * c / resolved.tileSize[0] - bb * s / resolved.tileSize[1]) / n;
          nny = world ? bb / n : (a * s / resolved.tileSize[0] + bb * c / resolved.tileSize[1]) / n;
          nrgh = sample(maps.roughness, u, v, 1, !world); nmetal = sample(maps.metalness, u, v, 2, !world);
        }
        r += (nr - r) * weight; g += (ng - g) * weight; b += (nb - b) * weight;
        nx += (nnx - nx) * weight; ny += (nny - ny) * weight; rough += (nrgh - rough) * weight; metal += (nmetal - metal) * weight;
      }
      const length = Math.hypot(nx, ny, 1);
      color.set([Math.round(clamp(srgb(r)) * 255), Math.round(clamp(srgb(g)) * 255), Math.round(clamp(srgb(b)) * 255), 255], index);
      normal.set([Math.round((nx / length * .5 + .5) * 255), Math.round((ny / length * .5 + .5) * 255), Math.round((1 / length * .5 + .5) * 255), 255], index);
      roughness.set([rough * 255, rough * 255, rough * 255, 255], index); metalness.set([metal * 255, metal * 255, metal * 255, 255], index);
    }
    const map = (data: Uint8Array, isColor = false) => {
      const result = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
      result.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      result.wrapS = result.wrapT = THREE.ClampToEdgeWrapping; result.magFilter = result.minFilter = THREE.LinearFilter; result.generateMipmaps = false;
      result.repeat.set(density / size, density / size); result.offset.set(-startX / size, -startZ / size); result.needsUpdate = true; owned.push(result); return result;
    };
    material.vertexColors = false; material.color.set('#ffffff'); material.map = map(color, true); material.normalMap = map(normal); material.roughnessMap = map(roughness); material.metalnessMap = map(metalness);
    material.roughness = material.metalness = 1; material.needsUpdate = true; status = 'ready';
    // The baked atlas no longer borrows any source maps; releasing leases allows
    // the bounded shared cache to reclaim them while retaining reusable entries.
    leases.splice(0).forEach(lease => lease.dispose());
  });
  cancelPreparation = preparation.cancel;
  const ready = preparation.ready.catch(reason => { if (status !== 'disposed') { status = 'error'; error = reason instanceof Error ? reason.message : String(reason); } leases.splice(0).forEach(lease => lease.dispose()); throw reason; });
  // The public promise still rejects for callers awaiting readiness. Rendering
  // a pending fallback without awaiting must not emit an unhandled rejection.
  void ready.catch(() => {});
  cancelWork = trackSurfaceMaterialWork(ready);
  return { material, ready, dispose, inspection: () => ({ resolution: size, texelsPerMetre: density, requestedTexelsPerMetre: requested, densityReduced: density < requested,
    layers: layers.length, status, ...(error ? { error } : {}), elevationRange: [...range] }) };
}
