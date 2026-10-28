import { Color, Object3D, PCFShadowMap, SpotLight, Vector3, type ColorRepresentation, type WebGLRenderer } from 'three';
import { configureRenderPerformance } from './renderPerformance.ts';

export interface LightingRigOptions {
  /** Maximum simultaneous shadow maps in this rig; 0–8, default 4. */
  maxShadowLights?: number;
  /** Per-light map size. Default 1024; use 512 for lighter scenes/devices. */
  shadowMapSize?: 512 | 1024 | 2048;
}

export interface SpotLightOptions {
  id: string;
  /** Fixture and aim coordinates in the rig parent's local space. */
  position: readonly [number, number, number];
  target: readonly [number, number, number];
  color?: ColorRepresentation;
  /** Three.js intensity in candela; default 25. */
  intensity?: number;
  /** Finite reach in world units; must exceed the 0.1 shadow near plane. */
  range?: number;
  /** Half-angle in radians, greater than 0 and at most PI / 2. */
  angle?: number;
  /** Soft edge of the light cone, 0–1; independent of shadow softness. */
  penumbra?: number;
  /** Eligible for a budgeted shadow map, default true. */
  castShadow?: boolean;
}

interface RigLight { light: SpotLight; requested: boolean }
const SHADOW_NEAR = 0.1;
// An incumbent's distance is discounted by 10%, preventing repeated map
// destruction/reallocation when the camera hovers between two fixtures.
const INCUMBENT_DISTANCE_SQUARED = 0.9 ** 2;

/** Enable filtered shadows once on the base view's renderer. A mod only needs
 * LightingRig: it can attach a Group through its feature host. */
export function configureShadowRenderer(renderer: Pick<WebGLRenderer, 'shadowMap'>): void {
  // Direct previews use the same engine defaults as sandboxed game workers.
  if ('render' in renderer) configureRenderPerformance(renderer as WebGLRenderer);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.shadowMap.needsUpdate = true;
}

/** View-only indoor fixtures with bounded shadow cost. Unselected fixtures
 * still illuminate the room. Call update with a world-space camera/player
 * position before rendering, including when the rig parent moves. Meshes must
 * use a lit material and opt into castShadow / receiveShadow themselves. */
export class LightingRig {
  private readonly parent: Object3D;
  private readonly maxShadowLights: number;
  private readonly shadowMapSize: number;
  private readonly lights = new Map<string, RigLight>();
  private readonly position = new Vector3();
  private disposed = false;

  constructor(parent: Object3D, options: LightingRigOptions = {}) {
    const budget = options.maxShadowLights ?? 4, size = options.shadowMapSize ?? 1024;
    if (!(parent instanceof Object3D)) throw new Error('LightingRig requires a Three.js parent.');
    if (!Number.isInteger(budget) || budget < 0 || budget > 8) throw new Error('LightingRig shadow budget must be an integer from 0 to 8.');
    if (![512, 1024, 2048].includes(size)) throw new Error('LightingRig shadow map size must be 512, 1024 or 2048.');
    this.parent = parent; this.maxShadowLights = budget; this.shadowMapSize = size;
  }

  addSpot(options: SpotLightOptions): SpotLight {
    if (this.disposed) throw new Error('LightingRig has been disposed.');
    if (this.lights.size >= 64) throw new Error('LightingRig supports at most 64 fixtures.');
    if (typeof options.id !== 'string' || !options.id.trim() || options.id.length > 128 || this.lights.has(options.id)) {
      throw new Error('LightingRig requires a unique, nonempty light ID of at most 128 characters.');
    }
    const point = (value: readonly number[]) => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
    if (!point(options.position) || !point(options.target)) throw new Error('Light position and target must contain three finite coordinates.');
    if (options.position.every((value, index) => value === options.target[index])) throw new Error('Light position and target must differ.');
    const intensity = options.intensity ?? 25, range = options.range ?? 18;
    const angle = options.angle ?? Math.PI / 3, penumbra = options.penumbra ?? 0.65;
    if (!Number.isFinite(intensity) || intensity < 0) throw new Error('Light intensity must be finite and nonnegative.');
    if (!Number.isFinite(range) || range <= SHADOW_NEAR) throw new Error('Light range must exceed the 0.1 shadow near plane.');
    if (!Number.isFinite(angle) || angle <= 0 || angle > Math.PI / 2) throw new Error('Light angle must be greater than 0 and at most PI / 2.');
    if (!Number.isFinite(penumbra) || penumbra < 0 || penumbra > 1) throw new Error('Light penumbra must be between 0 and 1.');
    if (options.castShadow !== undefined && typeof options.castShadow !== 'boolean') throw new Error('Light castShadow must be a boolean.');
    if (typeof options.color === 'number' && !Number.isFinite(options.color)) throw new Error('Light color must be finite.');
    const color = new Color(options.color ?? 0xffe3bc);
    if (![color.r, color.g, color.b].every(value => Number.isFinite(value) && value >= 0)) throw new Error('Light color components must be finite and nonnegative.');
    const light = new SpotLight(color, intensity, range, angle, penumbra, 2);
    light.name = options.id;
    light.position.fromArray(options.position);
    light.target.position.fromArray(options.target);
    light.target.name = `${options.id}:target`;
    light.shadow.mapSize.set(this.shadowMapSize, this.shadowMapSize);
    light.shadow.camera.near = SHADOW_NEAR;
    light.shadow.camera.far = range;
    light.shadow.camera.updateProjectionMatrix();
    light.shadow.bias = -0.00008;
    light.shadow.normalBias = 0.025;
    light.shadow.radius = 2;
    // update() is the only place that enables shadows, so even a scene with
    // many fixtures never temporarily exceeds its chosen shadow budget.
    light.castShadow = false;
    this.lights.set(options.id, { light, requested: options.castShadow ?? true });
    this.parent.add(light, light.target);
    return light;
  }

  update(focus: Readonly<{ x: number; y: number; z: number }>): void {
    if (this.disposed) return;
    if (![focus.x, focus.y, focus.z].every(Number.isFinite)) throw new Error('Lighting focus must contain finite world coordinates.');
    const visible = (light: Object3D) => {
      for (let ancestor: Object3D | null = light; ancestor; ancestor = ancestor.parent) if (!ancestor.visible) return false;
      return true;
    };
    const ranked = [...this.lights.entries()].filter(([, item]) => item.requested && item.light.intensity > 0 && visible(item.light)).map(([id, { light }]) => {
      // Only update a fixture's ancestors, not every mesh in a large room.
      light.updateWorldMatrix(true, false);
      this.position.setFromMatrixPosition(light.matrixWorld);
      const distance = (this.position.x - focus.x) ** 2 + (this.position.y - focus.y) ** 2 + (this.position.z - focus.z) ** 2;
      return { id, distance: distance * (light.castShadow ? INCUMBENT_DISTANCE_SQUARED : 1) };
    });
    ranked.sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const selected = new Set(ranked.slice(0, this.maxShadowLights).map(item => item.id));
    for (const [id, { light }] of this.lights) {
      const enabled = selected.has(id);
      if (light.castShadow && !enabled) this.releaseShadow(light);
      if (enabled && !light.castShadow) light.shadow.needsUpdate = true;
      light.castShadow = enabled;
    }
  }

  remove(id: string): void {
    const item = this.lights.get(id);
    if (!item) return;
    this.releaseShadow(item.light);
    item.light.castShadow = false;
    item.light.removeFromParent(); item.light.target.removeFromParent();
    item.light.dispose();
    this.lights.delete(id);
  }

  dispose(): void {
    for (const id of this.lights.keys()) this.remove(id);
    this.disposed = true;
  }

  private releaseShadow(light: SpotLight): void {
    light.shadow.dispose();
    light.shadow.map = null;
    light.shadow.mapPass = null;
  }
}
