import * as THREE from 'three';
import type { TerrainInstance, TerrainRecipe } from './terrain.ts';
import { sampleTerrainAssetEnvironment, sampleTerrainEnvironment, type TerrainAssetEnvironment } from './terrainEnvironment.ts';

export interface TerrainWindInterest { x: number; y?: number; z: number }
export interface TerrainWindPart { mesh: THREE.InstancedMesh; local: THREE.Matrix4 }
export interface TerrainWindGroup {
  asset: string;
  profile: TerrainAssetEnvironment;
  /** Bounds measured in prototype/root space, before the generated instance scale. */
  height: number;
  radius: number;
  instances: readonly TerrainInstance[];
  parts: TerrainWindPart[];
}
interface Candidate { group: TerrainWindGroup; index: number; instance: TerrainInstance }
const MAX_ANIMATED = 512;
const round = (value: number) => Math.round(value * 10000) / 10000;

/** Lightweight presentation sway for static instanced art. Every mesh part uses
 * the same ground-level pivot, so imported transforms, normals and shadow passes
 * agree without requiring custom shaders or one skeleton per plant. Authoritative
 * colliders stay still; this deliberately does not simulate branch deformation. */
export class TerrainWindView {
  private readonly candidates: Candidate[] = [];
  private ordered: Candidate[] = [];
  private active = new Set<Candidate>();
  private rankedAt = -Infinity;
  private rankedInterest: TerrainWindInterest | undefined;
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly yaw = new THREE.Quaternion();
  private readonly sway = new THREE.Quaternion();
  private readonly rotation = new THREE.Euler(0, 0, 0, 'XYZ');
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly rootMatrix = new THREE.Matrix4();
  private readonly partMatrix = new THREE.Matrix4();
  private samples: Record<string, unknown>[] = [];
  private distance = Infinity;
  private distanceInterest: TerrainWindInterest | undefined;
  private readonly recipe: TerrainRecipe;

  constructor(recipe: TerrainRecipe) { this.recipe = recipe; }

  add(group: TerrainWindGroup): void {
    if (!group.profile.wind) return;
    for (let index = 0; index < group.instances.length; index++) this.candidates.push({ group, index, instance: group.instances[index] });
    // The bound includes every possible root rotation, so swaying crowns cannot
    // vanish at the frustum edge. It is computed once, never per animation frame.
    const reach = group.radius * Math.max(0, ...group.instances.map(instance => instance.scale));
    for (const part of group.parts) {
      part.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (part.mesh.boundingSphere) part.mesh.boundingSphere.radius += reach * 2;
    }
    this.rankedAt = -Infinity;
  }

  private rank(now: number, interest?: TerrainWindInterest): void {
    const moved = !!interest !== !!this.rankedInterest || !!interest && !!this.rankedInterest
      && Math.hypot(interest.x - this.rankedInterest.x, interest.z - this.rankedInterest.z) > 5;
    if (!moved && now >= this.rankedAt && now - this.rankedAt < .25) return;
    this.ordered = [...this.candidates];
    const distance = (candidate: Candidate) => interest
      ? (candidate.instance.position.x - interest.x) ** 2 + (candidate.instance.position.z - interest.z) ** 2 : 0;
    this.ordered.sort((a, b) => distance(a) - distance(b) || a.instance.id.localeCompare(b.instance.id));
    this.distance = this.ordered.length ? Math.sqrt(distance(this.ordered[0])) : Infinity;
    this.distanceInterest = interest ? { ...interest } : undefined;
    this.rankedAt = now; this.rankedInterest = interest ? { ...interest } : undefined;
  }

  /** Used by the shared frame scheduler to give nearby resident chunks priority. */
  interestDistance(interest?: TerrainWindInterest): number {
    if (!this.candidates.length) return Infinity;
    if (!interest) return 0;
    // Only run the exact scan when the cached listener neighborhood changes.
    if (this.distanceInterest && Math.hypot(interest.x - this.distanceInterest.x, interest.z - this.distanceInterest.z) < 5) return this.distance;
    let distance = Infinity;
    for (const candidate of this.candidates) distance = Math.min(distance,
      Math.hypot(candidate.instance.position.x - interest.x, candidate.instance.position.z - interest.z));
    this.distanceInterest = { ...interest }; this.distance = distance; return distance;
  }

  private apply(candidate: Candidate, bendX = 0, bendZ = 0): void {
    const { instance, group, index } = candidate;
    this.position.set(instance.position.x, instance.position.y, instance.position.z);
    this.scale.setScalar(instance.scale); this.yaw.setFromAxisAngle(this.up, instance.yaw);
    this.rotation.set(bendX, 0, bendZ);
    this.sway.setFromEuler(this.rotation).multiply(this.yaw);
    this.rootMatrix.compose(this.position, this.sway, this.scale);
    for (const part of group.parts) {
      this.partMatrix.multiplyMatrices(this.rootMatrix, part.local);
      part.mesh.setMatrixAt(index, this.partMatrix); part.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** Updates only nearby selected instances. A zero budget restores previously
   * animated instances to rest; removal/revision disposal owns their GPU data. */
  step(nowSeconds: number, interest?: TerrainWindInterest, budget = MAX_ANIMATED): number {
    if (!Number.isFinite(nowSeconds)) return this.active.size;
    const limit = Math.max(0, Math.min(MAX_ANIMATED, Number.isFinite(budget) ? Math.floor(budget) : MAX_ANIMATED));
    if (limit === 0) {
      for (const candidate of this.active) this.apply(candidate);
      this.active.clear(); this.samples = []; return 0;
    }
    this.rank(nowSeconds, interest);
    const next = new Set(this.ordered.slice(0, limit));
    for (const candidate of this.active) if (!next.has(candidate)) this.apply(candidate);
    this.samples = [];
    for (const candidate of next) {
      const { instance, group } = candidate;
      const environment = sampleTerrainEnvironment(this.recipe, instance.position, nowSeconds);
      const sampled = sampleTerrainAssetEnvironment(group.profile, { id: instance.id,
        height: group.height * instance.scale, position: instance.position, timeSeconds: nowSeconds, wind: environment.wind });
      this.apply(candidate, sampled.bend.x, sampled.bend.z);
      if (this.samples.length < 3) this.samples.push({ id: instance.id, asset: group.asset,
        height: round(sampled.height), frequency: round(sampled.frequency), bend: { x: round(sampled.bend.x), z: round(sampled.bend.z) }, soundGain: round(sampled.soundGain) });
    }
    this.active = next;
    return next.size;
  }

  inspection(): Record<string, unknown> {
    return { available: this.candidates.length, animated: this.active.size,
      deferred: Math.max(0, this.candidates.length - this.active.size), maxAnimated: MAX_ANIMATED,
      method: 'anchored-root-sway', collisions: 'static-authoritative', samples: this.samples };
  }
}
