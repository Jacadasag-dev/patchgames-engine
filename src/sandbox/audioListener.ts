import { Camera, Vector3, Vector4, WebGLRenderer } from 'three';
import { setAutomaticSoundListener } from './audio.ts';

type Pose = { position: [number, number, number]; forward: [number, number, number]; up: [number, number, number] };
let current: { review: boolean; subject?: string; candidate?: Pose; priority: number; area: number } | undefined;
let canonicalView: { camera: Camera } | undefined;
let lastCamera: Camera | undefined;
let lastSubject: string | undefined;
let selectedCamera: Camera | undefined;
let installed = false;
const position = new Vector3(), forward = new Vector3(), up = new Vector3(), viewport = new Vector4();
const depths = new WeakMap<object, number>();

function pose(camera: Camera): Pose | undefined {
  camera.updateWorldMatrix(true, false);
  camera.getWorldPosition(position); camera.getWorldDirection(forward);
  // Camera-local +Y transformed by matrixWorld preserves parent rotation and roll.
  up.set(0, 1, 0).transformDirection(camera.matrixWorld);
  const values = [...position.toArray(), ...forward.toArray(), ...up.toArray()];
  if (!values.every(Number.isFinite) || forward.lengthSq() < 1e-10 || up.lengthSq() < 1e-10
    || Math.max(...position.toArray().map(Math.abs)) > 1_000_000) return;
  return { position: position.toArray(), forward: forward.toArray(), up: up.toArray() };
}

function consider(camera: Camera, priority: number, area = 0): void {
  if (!current || !(camera instanceof Camera) || priority < current.priority || priority === current.priority && area <= current.area) return;
  let value: Pose | undefined;
  try { value = pose(camera); } catch { return; }
  if (!value) return;
  current.candidate = value; current.priority = priority; current.area = area; selectedCamera = camera;
}

/** Register the conventional game-camera field before feature composition hides it.
 * This fallback is only needed when an inspection review camera replaces every draw. */
export function registerSoundViewCamera(view: unknown): void {
  try {
    if (view && typeof view === 'object' && 'camera' in view && view.camera instanceof Camera) canonicalView = view as { camera: Camera };
  } catch { /* Custom views can explicitly setSoundListener instead. */ }
}

export function resetSoundCameraTracking(): void { current = undefined; canonicalView = undefined; lastCamera = undefined; lastSubject = undefined; selectedCamera = undefined; }
/** Subject identity changes are camera cuts even when a view reuses one Camera. */
export function beginSoundCameraFrame(review = false, subject?: string): void { current = { review, subject, priority: -1, area: -1 }; selectedCamera = undefined; }
export function endSoundCameraFrame(): void {
  if (!current) return;
  if ((!current.candidate || current.review) && current.priority < 3 && canonicalView) {
    try { consider(canonicalView.camera, 2); } catch { /* Invalid custom camera getters cannot stop rendering. */ }
  }
  const value = current.candidate;
  if (value) {
    const cut = lastCamera && (lastCamera !== selectedCamera || lastSubject !== current.subject);
    setAutomaticSoundListener(value.position, value.forward, value.up, { ...(cut ? { teleport: true } : {}) });
    lastCamera = selectedCamera;
    lastSubject = current.subject;
  }
  current = undefined;
}

/** Actual gameplay captures outrank focus/review, minimap, reflection and HUD cameras. */
export function recordSoundGameplayCamera(camera: Camera, actualGameplay = false): void {
  if (!current || current.review && !actualGameplay) return;
  consider(camera, actualGameplay ? 3 : 2);
}

/** Capture only top-level screen draws. The largest viewport wins; equal-size
 * later HUD passes retain the first world camera. Offscreen and nested mirror
 * draws never become listeners. Exotic split-screen views can override explicitly. */
function trackedRender(renderer: WebGLRenderer, draw: WebGLRenderer['render']): WebGLRenderer['render'] {
  return function (scene, camera) {
    const depth = depths.get(renderer) ?? 0;
    try {
      if (current && !current.review && depth === 0 && renderer.getRenderTarget() === null) {
        renderer.getViewport(viewport);
        const area = Math.max(0, viewport.z) * Math.max(0, viewport.w);
        consider(camera, 1, area);
      }
    } catch { /* Audio observation must never prevent the actual draw. */ }
    depths.set(renderer, depth + 1);
    try { return draw.call(renderer, scene, camera); }
    finally { depths.set(renderer, depth); }
  };
}

/** Three assigns render on each renderer instance. Intercept that assignment
 * before createView so arbitrary authored Three views get automatic listeners. */
export function installSoundCameraTracking(): void {
  if (installed) return;
  const prototype = WebGLRenderer.prototype;
  const existing = Object.getOwnPropertyDescriptor(prototype, 'render');
  if (existing && !existing.configurable) return;
  Object.defineProperty(prototype, 'render', { configurable: true,
    set(this: WebGLRenderer, draw: WebGLRenderer['render']) {
      Object.defineProperty(this, 'render', { value: trackedRender(this, draw), writable: true, configurable: true });
    },
  });
  installed = true;
}
