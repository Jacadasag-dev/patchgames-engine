import { BufferGeometry, Color, DoubleSide, DynamicDrawUsage, Float32BufferAttribute, Group, Mesh, MeshPhysicalMaterial, type Texture } from 'three';
import { locateWater, sampleWaterWave, waterAppearance, type WaterAppearance, type WaterConditions, type WaterLocation, type WaterManifest, type WaterPoint, type WaterWavePhase } from './water.ts';

export interface WaterViewOptions {
  /** Spatial resolution; bounded to 8–128. Updates do not change topology. */
  segments?: number; updateHz?: number; transitionSeconds?: number;
  /** Terrain query in world metres, sampled only while constructing the view. */
  sampleGround?: (x: number, z: number) => number;
  /** Borrowed textures from the existing texture/material system; never disposed here. */
  map?: Texture; normalMap?: Texture; envMap?: Texture; opacity?: number;
}
interface Vertex { point: WaterPoint; location: WaterLocation; wet: boolean }
const option = (value: number | undefined, fallback: number, min: number, max: number, name: string) => {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < min || result > max) throw new Error(`WaterView ${name} must be between ${min} and ${max}.`);
  return result;
};
/** One ordinary physical material and a bounded animated mesh. No offscreen
 * reflection render, physics registration, particles or per-frame terrain query. */
export class WaterView {
  readonly water: WaterManifest;
  readonly root = new Group();
  readonly geometry = new BufferGeometry();
  readonly material: MeshPhysicalMaterial;
  private readonly vertices: Vertex[] = [];
  private readonly interval: number;
  private readonly transitionSeconds: number;
  private appearance: WaterAppearance;
  private phases: WaterWavePhase = { temporal: [0, 0, 0], currentX: [0, 0, 0], currentZ: [0, 0, 0] };
  private lastTime: number | undefined;
  private disposed = false;
  private updates = 0;
  private resolutionLimited = false;
  constructor(water: WaterManifest, options: WaterViewOptions = {}) {
    this.water = water;
    const segments = option(options.segments, 48, 8, 128, 'segments');
    if (!Number.isInteger(segments)) throw new Error('WaterView segments must be an integer.');
    this.interval = 1 / option(options.updateHz, 20, 1, 60, 'updateHz');
    this.transitionSeconds = option(options.transitionSeconds, .6, 0, 10, 'transitionSeconds');
    this.appearance = waterAppearance(water);
    this.material = new MeshPhysicalMaterial({ color: 0xffffff, vertexColors: true, roughness: this.appearance.roughness,
      metalness: 0, ior: 1.333, specularIntensity: 1, clearcoat: .6, clearcoatRoughness: .12,
      transparent: true, opacity: option(options.opacity, .92, .1, 1, 'opacity'), side: DoubleSide,
      map: options.map ?? null, normalMap: options.normalMap ?? null, envMap: options.envMap ?? null });
    this.material.name = `${water.id}:water`;
    const indices: number[] = [];
    const add = (x: number, z: number) => {
      const point = { x, z }, location = locateWater(water, point);
      if (options.sampleGround) {
        const ground = options.sampleGround(x, z);
        if (!Number.isFinite(ground)) throw new Error('WaterView sampleGround must return finite heights.');
        location.depth = Math.max(0, location.level - ground);
      }
      this.vertices.push({ point, location, wet: location.inside && location.depth > 0 });
      return this.vertices.length - 1;
    };
    const face = (a: number, b: number, c: number) => {
      if (this.vertices[a].wet || this.vertices[b].wet || this.vertices[c].wet) indices.push(a, b, c);
    };
    if (water.kind === 'lake') {
      const center = add(water.center.x, water.center.z), rings = Math.max(4, Math.floor(segments / 2)), sides = segments * 2;
      for (let ring = 1; ring <= rings; ring++) for (let side = 0; side < sides; side++) {
        const angle = side / sides * Math.PI * 2, radius = ring / rings;
        add(water.center.x + Math.cos(angle) * water.size.width / 2 * radius, water.center.z + Math.sin(angle) * water.size.depth / 2 * radius);
      }
      for (let side = 0; side < sides; side++) face(center, 1 + (side + 1) % sides, 1 + side);
      for (let ring = 1; ring < rings; ring++) for (let side = 0; side < sides; side++) {
        const a = 1 + (ring - 1) * sides + side, b = 1 + (ring - 1) * sides + (side + 1) % sides;
        const c = 1 + ring * sides + side, d = 1 + ring * sides + (side + 1) % sides;
        face(a, b, c); face(b, d, c);
      }
    } else if (water.kind === 'river') {
      // Clip a shared grid to the union of the variable-width segments. Offset
      // ribbons overlap on inner bends; this construction emits each cell once.
      const minX = Math.min(...water.path.map(p => p.x - p.width / 2)), maxX = Math.max(...water.path.map(p => p.x + p.width / 2));
      const minZ = Math.min(...water.path.map(p => p.z - p.width / 2)), maxZ = Math.max(...water.path.map(p => p.z + p.width / 2));
      const spanX = maxX - minX, spanZ = maxZ - minZ, longest = Math.max(spanX, spanZ);
      const minWidth = Math.min(...water.path.map(p => p.width)), desired = Math.max(segments, Math.ceil(longest / (minWidth / 3)));
      const riverSegments = Math.min(128, desired); this.resolutionLimited = desired > 128;
      const cols = Math.max(8, Math.ceil(riverSegments * spanX / longest)), rows = Math.max(8, Math.ceil(riverSegments * spanZ / longest));
      const grid: number[][] = [], crossings = new Map<string, number>();
      for (let row = 0; row <= rows; row++) {
        const line: number[] = [];
        for (let col = 0; col <= cols; col++) line.push(add(minX + col / cols * spanX, minZ + row / rows * spanZ));
        grid.push(line);
      }
      const cross = (a: number, b: number) => {
        const key = `${Math.min(a, b)}:${Math.max(a, b)}`, existing = crossings.get(key); if (existing !== undefined) return existing;
        const p = this.vertices[a], q = this.vertices[b], t = p.location.edgeDistance / (p.location.edgeDistance - q.location.edgeDistance);
        const at = add(p.point.x + (q.point.x - p.point.x) * t, p.point.z + (q.point.z - p.point.z) * t);
        crossings.set(key, at); return at;
      };
      const clip = (triangle: number[]) => {
        const polygon: number[] = [];
        for (let i = 0; i < 3; i++) {
          const a = triangle[i], b = triangle[(i + 1) % 3], insideA = this.vertices[a].location.inside, insideB = this.vertices[b].location.inside;
          if (insideA) polygon.push(a); if (insideA !== insideB) polygon.push(cross(a, b));
        }
        for (let i = 1; i + 1 < polygon.length; i++) face(polygon[0], polygon[i], polygon[i + 1]);
      };
      for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
        clip([grid[row][col], grid[row + 1][col], grid[row][col + 1]]);
        clip([grid[row][col + 1], grid[row + 1][col], grid[row + 1][col + 1]]);
      }
    } else {
      for (let row = 0; row <= segments; row++) for (let col = 0; col <= segments; col++)
        add(water.center.x + (col / segments - .5) * water.size.width, water.center.z + (row / segments - .5) * water.size.depth);
      for (let row = 0; row < segments; row++) for (let col = 0; col < segments; col++) {
        const a = row * (segments + 1) + col, b = a + 1, c = a + segments + 1, d = c + 1;
        face(a, c, b); face(b, c, d);
      }
    }
    const count = this.vertices.length;
    this.geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(count * 3), 3).setUsage(DynamicDrawUsage));
    this.geometry.setAttribute('normal', new Float32BufferAttribute(new Float32Array(count * 3), 3).setUsage(DynamicDrawUsage));
    this.geometry.setAttribute('color', new Float32BufferAttribute(new Float32Array(count * 3), 3).setUsage(DynamicDrawUsage));
    this.geometry.setAttribute('uv', new Float32BufferAttribute(this.vertices.flatMap(v => [v.point.x / 4, v.point.z / 4]), 2));
    this.geometry.setIndex(indices);
    const mesh = new Mesh(this.geometry, this.material); mesh.name = water.id; mesh.receiveShadow = true; mesh.frustumCulled = false;
    this.root.name = water.id; this.root.add(mesh); this.update(0);
  }
  update(time: number, conditions: WaterConditions = {}): void {
    if (this.disposed) return;
    const target = waterAppearance(this.water, conditions);
    if (!Number.isFinite(time) || Math.abs(time) > 1e9) throw new Error('WaterView time must be finite and within ±1000000000s.');
    const dt = this.lastTime === undefined ? Infinity : Math.max(0, time - this.lastTime);
    if (dt < this.interval && this.lastTime !== undefined && time >= this.lastTime) return;
    const alpha = this.transitionSeconds === 0 ? 1 : 1 - Math.exp(-dt / this.transitionSeconds);
    for (const key of ['amplitude', 'wavelength', 'speed', 'roughness', 'foam', 'shoreFoam', 'windSpeed', 'currentSpeed'] as const)
      this.appearance[key] += (target[key] - this.appearance[key]) * alpha;
    const angle = Math.atan2(Math.sin(target.windDirection - this.appearance.windDirection), Math.cos(target.windDirection - this.appearance.windDirection));
    this.appearance.windDirection += angle * alpha;
    for (let i = 0; i < 3; i++) this.appearance.color[i] += (target.color[i] - this.appearance.color[i]) * alpha;
    if (this.lastTime !== undefined && time < this.lastTime) this.phases = { temporal: [0, 0, 0], currentX: [0, 0, 0], currentZ: [0, 0, 0] };
    const phaseDt = this.lastTime === undefined || time < this.lastTime ? time : dt;
    for (let i = 0; i < 3; i++) {
      const k = Math.PI * 2 / (this.appearance.wavelength / (1 + i * .8)), direction = this.appearance.windDirection + i * 1.13;
      this.phases.temporal[i] -= phaseDt * k * this.appearance.speed / (1 + i * .3);
      this.phases.currentX[i] += phaseDt * k * this.appearance.currentSpeed * Math.cos(direction);
      this.phases.currentZ[i] += phaseDt * k * this.appearance.currentSpeed * Math.sin(direction);
    }
    const positions = this.geometry.getAttribute('position'), normals = this.geometry.getAttribute('normal'), colors = this.geometry.getAttribute('color');
    const foamColor = new Color('#e6f6ed');
    for (let i = 0; i < this.vertices.length; i++) {
      const vertex = this.vertices[i], sample = sampleWaterWave(this.water, vertex.point, time, this.appearance, vertex.location, this.phases);
      positions.setXYZ(i, vertex.point.x, sample.height, vertex.point.z); normals.setXYZ(i, sample.normal.x, sample.normal.y, sample.normal.z);
      const depthTint = .65 + .35 * Math.min(1, vertex.location.depth / 3), foam = sample.foam;
      colors.setXYZ(i, sample.color[0] * depthTint * (1 - foam) + foamColor.r * foam,
        sample.color[1] * depthTint * (1 - foam) + foamColor.g * foam, sample.color[2] * depthTint * (1 - foam) + foamColor.b * foam);
    }
    positions.needsUpdate = normals.needsUpdate = colors.needsUpdate = true;
    this.material.roughness = this.appearance.roughness; this.material.clearcoatRoughness = this.appearance.roughness * .7;
    this.lastTime = time; this.updates++;
  }
  inspection() { return { kind: this.water.kind, vertices: this.vertices.length, triangles: (this.geometry.index?.count ?? 0) / 3,
    updates: this.updates, disposed: this.disposed, particles: 0, physicsBodies: 0, roughness: this.appearance.roughness, resolutionLimited: this.resolutionLimited }; }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.geometry.dispose(); this.material.dispose(); this.root.clear(); this.root.removeFromParent(); }
}
