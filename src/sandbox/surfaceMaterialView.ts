/** View-owned, bounded procedural materials. Geometry supplies UVs in metres.
 * Leases borrow immutable maps/materials; release the lease, never their maps. */
import { MeshStandardMaterial, type Side } from 'three';
import { createRecipeMaterial, type RecipeMaterial } from './materialRecipes.ts';
import type { MaterialRecipeOptions, MaterialSourceResolver, MaterialSurfaceFields } from '../shared/materialRecipeRenderer.ts';
import { validateResolvedSurfaceMaterial, type ResolvedSurfaceMaterial } from './surfaceMaterials.ts';

export interface SurfaceMaterialCacheOptions {
  resolveSource?: MaterialSourceResolver;
  maxMaterials?: number; maxTextureBytes?: number; maxConcurrent?: number; maxPending?: number;
}
export interface SurfaceMaterialAcquireOptions {
  emissive?: string; emissiveIntensity?: number; vertexColors?: boolean; side?: Side;
  surface?: MaterialSurfaceFields;
  coordinates?: MaterialRecipeOptions['coordinates'];
}
export interface SurfaceMaterialHandle { material: MeshStandardMaterial; ready: Promise<void>; dispose(): void }
interface TrackedWork { done: Promise<void>; cancel(): void }
const work = new Set<TrackedWork>();
let globalErrors = 0;
/** Track asynchronous atlas work too. The returned cancellation releases global
 * readiness immediately when its owner is disposed, without retaining that owner. */
export function trackSurfaceMaterialWork(promise: Promise<unknown>): () => void {
  let finish!: () => void, active = true;
  const entry: TrackedWork = { done: new Promise<void>(resolve => { finish = resolve; }), cancel() {
    if (!active) return; active = false; work.delete(entry); finish();
  } };
  work.add(entry);
  void promise.then(() => entry.cancel(), () => { if (active) globalErrors++; entry.cancel(); });
  return () => entry.cancel();
}
export function surfaceMaterialLoadingInfo(): { pending: number; errors: number } { return { pending: work.size, errors: globalErrors }; }
/** Includes material/atlas continuations created by work already in flight. */
export async function settleSurfaceMaterials(): Promise<void> {
  do { await Promise.all([...work].map(entry => entry.done)); await Promise.resolve(); } while (work.size);
}

type Maps = RecipeMaterial['maps'];
interface TextureEntry {
  key: string; references: number; bytes: number; state: 'queued' | 'loading' | 'ready' | 'failed' | 'released';
  recipe: ResolvedSurfaceMaterial['texture']; options: MaterialRecipeOptions; value?: RecipeMaterial;
  ready: Promise<RecipeMaterial>; resolve(value: RecipeMaterial): void; reject(error: Error): void; untrack(): void;
}
interface MaterialEntry { unsubscribe?:()=>void; key: string; material: MeshStandardMaterial; maps?: Maps; texture: TextureEntry; references: number; released: boolean; ready: Promise<void> }
const plain = (value: unknown): boolean => !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const color = (value: unknown) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
const names = (value: object, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
function integer(value: unknown, fallback: number, min: number, max: number, label: string): number {
  const n = value ?? fallback; if (!Number.isInteger(n) || (n as number) < min || (n as number) > max) throw new Error(`${label} must be an integer in ${min}–${max}.`); return n as number;
}
function fields(input: MaterialSurfaceFields | undefined): { surface?: MaterialSurfaceFields; key: string } {
  if (input === undefined) return { key: '' };
  if (!plain(input) || !names(input, ['width', 'height', 'elevation', 'slope']) || !Number.isInteger(input.width) || !Number.isInteger(input.height)
    || input.width < 1 || input.height < 1 || input.width > 2048 || input.height > 2048) throw new Error('Surface fields require dimensions from 1 to 2048.');
  const surface: MaterialSurfaceFields = { width: input.width, height: input.height }, keys: string[] = [`${input.width}:${input.height}`];
  for (const name of ['elevation', 'slope'] as const) {
    const source = input[name]; if (source === undefined) continue;
    if (!source || source.length !== input.width * input.height) throw new Error('Surface field length does not match its dimensions.');
    const copy = new Float32Array(source.length);
    for (let i = 0; i < source.length; i++) { const value = source[i]; if (!finite(value) || value < 0 || value > 1) throw new Error('Surface fields must contain normalized finite values.'); copy[i] = value; }
    let a = 2166136261, b = 0x6d2b79f5;
    for (const value of new Uint32Array(copy.buffer)) { a = Math.imul(a ^ value, 16777619); b = Math.imul(b ^ value, 2246822519); }
    surface[name] = copy; keys.push(`${name}:${a >>> 0}:${b >>> 0}`);
  }
  return { surface, key: keys.join(':') };
}
function coordinates(input: MaterialRecipeOptions['coordinates']): MaterialRecipeOptions['coordinates'] {
  if (input === undefined) return undefined;
  if (!plain(input) || !names(input, ['origin', 'uAxis', 'vAxis', 'metres'])) throw new Error('Material coordinates require origin, uAxis and vAxis pairs.');
  for (const pair of [input.origin, input.uAxis, input.vAxis]) if (!Array.isArray(pair) || pair.length !== 2 || Array.from(pair).some(v => !finite(v) || Math.abs(v) > 1e6)) throw new Error('Material coordinate pairs must be finite and bounded by ±1000000.');
  if (Math.abs(input.uAxis[0] * input.vAxis[1] - input.uAxis[1] * input.vAxis[0]) < 1e-12) throw new Error('Material coordinate axes must be nonsingular.');
  if (input.metres !== undefined && (!Array.isArray(input.metres) || input.metres.length !== 2 || Array.from(input.metres).some(v => !finite(v) || v <= 0 || v > 20002))) throw new Error('Material physical spans must be positive and at most 20002m.');
  return { origin: [...input.origin], uAxis: [...input.uAxis], vAxis: [...input.vAxis], ...(input.metres ? { metres: [...input.metres] as [number, number] } : {}) };
}

/** One cache belongs to a view/world. Concurrent requests share one CPU render
 * and image/source storage; mapping/emission variants borrow cloned texture
 * transforms. No mesh or renderer is held by the cache. Maps release when the
 * last live material lease releases, and late completion cannot resurrect it. */
export class SurfaceMaterialCache {
  private readonly materials = new Map<string, MaterialEntry>();
  private readonly textures = new Map<string, TextureEntry>();
  private readonly queue: TextureEntry[] = [];
  private readonly handles = new Set<SurfaceMaterialHandle>();
  private readonly maxMaterials: number;
  private readonly maxTextureBytes: number;
  private readonly maxConcurrent: number;
  private readonly maxPending: number;
  private readonly resolveSource?: MaterialSourceResolver;
  private bytes = 0;
  private active = 0;
  private disposed = false;
  private readonly errors: string[] = [];
  private generated = 0;
  constructor(options: SurfaceMaterialCacheOptions = {}) {
    if (!plain(options) || !names(options, ['resolveSource', 'maxMaterials', 'maxTextureBytes', 'maxConcurrent', 'maxPending'])
      || options.resolveSource !== undefined && typeof options.resolveSource !== 'function') throw new Error('Invalid surface material cache options.');
    this.maxMaterials = integer(options.maxMaterials, 128, 1, 4096, 'maxMaterials');
    this.maxTextureBytes = integer(options.maxTextureBytes, 32 * 1024 * 1024, 1024, 256 * 1024 * 1024, 'maxTextureBytes');
    this.maxConcurrent = integer(options.maxConcurrent, 2, 1, 8, 'maxConcurrent');
    this.maxPending = integer(options.maxPending, 64, 1, 512, 'maxPending');
    this.resolveSource = options.resolveSource;
  }
  acquire(input: ResolvedSurfaceMaterial, options: SurfaceMaterialAcquireOptions = {}): SurfaceMaterialHandle {
    if (this.disposed) throw new Error('SurfaceMaterialCache has been disposed.');
    const surface = validateResolvedSurfaceMaterial(input);
    if (!plain(options) || !names(options, ['emissive', 'emissiveIntensity', 'vertexColors', 'side', 'surface', 'coordinates'])
      || options.emissive !== undefined && !color(options.emissive) || options.emissiveIntensity !== undefined && (!finite(options.emissiveIntensity) || options.emissiveIntensity < 0 || options.emissiveIntensity > 10)
      || options.vertexColors !== undefined && typeof options.vertexColors !== 'boolean' || options.side !== undefined && ![0, 1, 2].includes(options.side)) throw new Error('Invalid surface material rendering options.');
    const sampled = fields(options.surface), coords = coordinates(options.coordinates);
    const textureKey = JSON.stringify([surface.texture, sampled.key, coords ?? null]);
    const materialKey = JSON.stringify([surface.key, textureKey, options.emissive?.toLowerCase() ?? null, options.emissiveIntensity ?? 1, options.vertexColors ?? false, options.side ?? 0]);
    let entry = this.materials.get(materialKey);
    if (!entry) {
      if (this.materials.size >= this.maxMaterials) throw new Error('Surface material cache exceeds its live material budget.');
      let source = this.textures.get(textureKey);
      if (!source) source = this.enqueue(textureKey, surface.texture, { ...(sampled.surface ? { surface: sampled.surface } : {}), ...(coords ? { coordinates: coords } : {}) });
      source.references++;
      const material = new MeshStandardMaterial({ color: surface.tint, roughness: .85, metalness: 0, vertexColors: options.vertexColors ?? false,
        side: options.side ?? 0, ...(options.emissive ? { emissive: options.emissive, emissiveIntensity: options.emissiveIntensity ?? 1 } : {}) });
      entry = { key: materialKey, material, texture: source, references: 0, released: false, ready: Promise.resolve() };
      const owner = entry;
      owner.ready = source.ready.then(value => {
        if (owner.released || this.disposed) return;
        const maps = Object.fromEntries(Object.entries(value.maps).map(([name, map]) => {
          const copy = map.clone(); copy.repeat.set(1 / surface.tileSize[0], 1 / surface.tileSize[1]); copy.rotation = surface.rotation; copy.needsUpdate = true; return [name, copy];
        })) as Maps;
        owner.maps = maps; owner.unsubscribe=value.onUpdate(()=>{
          if(owner.released)return;for(const name of Object.keys(maps) as (keyof Maps)[]){maps[name].image=value.maps[name].image;maps[name].needsUpdate=true;}material.userData.materialRecipe=value.material.userData.materialRecipe;
        }); Object.assign(material, { map: maps.color, normalMap: maps.normal, roughnessMap: maps.roughness, metalnessMap: maps.metalness,
          roughness: 1, metalness: 1, transparent: value.material.transparent });
        material.name = surface.texture.name; material.userData.surfaceMaterial = { key: surface.key, ...value.diagnostics }; material.needsUpdate = true;
      });
      // The public promise still rejects for callers; observing it here prevents
      // a synchronous view factory from producing an unhandled rejection.
      void owner.ready.catch(() => undefined);
      this.materials.set(materialKey, owner);
    }
    entry.references++; const owner = entry; let released = false;
    const handle: SurfaceMaterialHandle = { material: owner.material, ready: owner.ready, dispose: () => {
      if (released) return; released = true; this.handles.delete(handle);
      if (--owner.references === 0) this.releaseMaterial(owner);
    } };
    this.handles.add(handle); return handle;
  }
  private enqueue(key: string, recipe: ResolvedSurfaceMaterial['texture'], options: MaterialRecipeOptions): TextureEntry {
    const pending = [...this.textures.values()].filter(entry => entry.state === 'queued' || entry.state === 'loading').length;
    if (pending >= this.maxPending) throw new Error('Surface material cache exceeds its pending render budget.');
    // Five RGBA8 channels plus their mip chains. Source media lives in the
    // existing bounded media transport and is not duplicated by this cache.
    const bytes = Math.ceil(recipe.resolution * recipe.resolution * 4 * 5 * 4 / 3);
    if (this.bytes + bytes > this.maxTextureBytes) throw new Error('Surface material cache exceeds its texture byte budget.');
    let resolve!: (value: RecipeMaterial) => void, reject!: (error: Error) => void;
    const ready = new Promise<RecipeMaterial>((yes, no) => { resolve = yes; reject = no; });
    const entry: TextureEntry = { key, recipe, options, references: 0, bytes, state: 'queued', ready, resolve, reject, untrack: trackSurfaceMaterialWork(ready) };
    void ready.catch(() => undefined); this.textures.set(key, entry); this.bytes += bytes; this.queue.push(entry);
    // Defer until acquire has registered its owner and reference count.
    void Promise.resolve().then(() => this.pump()); return entry;
  }
  private pump(): void {
    while (!this.disposed && this.active < this.maxConcurrent && this.queue.length) {
      const entry = this.queue.shift()!; if (entry.state !== 'queued') continue;
      entry.state = 'loading'; this.active++;
      void createRecipeMaterial(entry.recipe, { ...entry.options, ...(this.resolveSource ? { resolveSource: this.resolveSource } : {}) }).then(value => {
        this.generated++;
        if (this.disposed || !entry.references || entry.state === 'released') { value.dispose(); this.releaseTexture(entry); entry.resolve(value); }
        else { entry.state = 'ready'; entry.value = value; entry.resolve(value); }
      }, reason => {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        if (entry.state !== 'released') {
          if (!this.disposed && entry.references) { if (this.errors.length < 32) this.errors.push(error.message); }
          entry.state = 'failed'; this.releaseTexture(entry);
        }
        entry.reject(error);
      }).finally(() => { this.active--; this.pump(); });
    }
  }
  private releaseMaterial(entry: MaterialEntry): void {
    if (entry.released) return; entry.released = true; this.materials.delete(entry.key);
    entry.unsubscribe?.();entry.material.dispose(); if (entry.maps) for (const map of Object.values(entry.maps)) map.dispose();
    if (--entry.texture.references === 0) this.releaseTexture(entry.texture);
  }
  private releaseTexture(entry: TextureEntry): void {
    if (entry.state === 'released') return;
    const state = entry.state; entry.state = 'released'; this.textures.delete(entry.key); this.bytes -= entry.bytes;
    if (state !== 'failed') entry.untrack(); entry.value?.dispose(); entry.value = undefined;
    if (state === 'queued' || state === 'loading') {
      const index = this.queue.indexOf(entry); if (index >= 0) this.queue.splice(index, 1);
      entry.reject(new Error('Surface material released before loading completed.'));
    }
  }
  /** Waits for current live material leases, rejecting if any build failed. */
  async ready(): Promise<void> { await Promise.all([...this.materials.values()].map(entry => entry.ready)); }
  inspection(): { materials: number; textures: number; references: number; pending: number; active: number; textureBytes: number; generated: number; errors: string[]; disposed: boolean } {
    return { materials: this.materials.size, textures: this.textures.size, references: this.handles.size,
      pending: [...this.textures.values()].filter(entry => entry.state === 'queued' || entry.state === 'loading').length,
      active: this.active, textureBytes: this.bytes, generated: this.generated, errors: [...this.errors], disposed: this.disposed };
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    for (const handle of this.handles) handle.dispose();
    for (const entry of this.textures.values()) this.releaseTexture(entry);
    this.queue.length = 0;
  }
}
