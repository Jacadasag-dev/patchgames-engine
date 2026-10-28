import { Material, Object3D, type Camera } from 'three';
import type { FeaturePlayerPose } from '../shared/gameFeatures.ts';
import { withInspectionCameraMask } from './inspectionCamera.ts';

// Only these engine-owned hooks are confined to camera masking. A wrapper
// around an authored callback remains untrusted because it can mutate siblings.
const cameraMaskCallbacks = new WeakSet<Function>();
export function isEngineCameraMaskCallback(callback: Function): boolean {
  return cameraMaskCallbacks.has(callback);
}

/** Shared avatar attachment contract. Gameplay poses never depend on a stock rig. */
export class PlayerAppearanceHost {
  private readonly appearances = new Map<string, Object3D>();
  private readonly originals = new Map<string, { avatar: Object3D; visible: boolean }>();
  private readonly parent: Object3D;

  constructor(parent: Object3D) { this.parent = parent; }

  /** The selected rendered body, including mod replacements. Inspection owns
   * temporary camera visibility; this accessor never changes the avatar. */
  inspectionTarget(playerId: string): Object3D | undefined {
    return this.appearances.get(playerId) ?? this.originals.get(playerId)?.avatar;
  }

  setPlayerAppearance(playerId: string, object: unknown | null): void {
    if (typeof playerId !== 'string' || !playerId || playerId.length > 128) throw new Error('Invalid player appearance ID.');
    if (object !== null && !(object instanceof Object3D)) throw new Error('Player appearances must be Three.js objects.');
    for (let ancestor: Object3D | null = this.parent; ancestor; ancestor = ancestor.parent) {
      if (object === ancestor) throw new Error('Player appearances cannot replace their scene parent.');
    }
    if (object && [...this.appearances].some(([id, existing]) => id !== playerId && existing === object)) {
      throw new Error('Each player appearance requires its own object.');
    }
    const previous = this.appearances.get(playerId);
    if (previous === object) return;
    previous?.removeFromParent();
    if (object) {
      this.appearances.set(playerId, object);
      object.visible = false;
      this.parent.add(object);
    } else {
      this.appearances.delete(playerId);
      const original = this.originals.get(playerId);
      if (original) original.avatar.visible = original.visible;
    }
  }

  /** Call after stock-avatar animation and before rendering. First-person views
   * may independently hide the replacement without changing gameplay state. */
  update(playerId: string, avatar: Object3D, pose: Readonly<FeaturePlayerPose>,
    visible = true, showAppearance = visible): void {
    this.originals.set(playerId, { avatar, visible });
    const appearance = this.appearances.get(playerId);
    avatar.visible = visible && !appearance;
    if (!appearance) return;
    appearance.position.set(pose.x, pose.y, pose.z);
    appearance.rotation.set(0, pose.facing, 0);
    appearance.visible = showAppearance;
  }

  /** Render a first-person player's selected body in a mirror without exposing
   * it to their main camera. Visibility is restored even if rendering fails. */
  withVisible<T>(playerId: string, render: () => T): T {
    const original = this.originals.get(playerId)?.avatar;
    const appearance = this.appearances.get(playerId);
    const originalVisible = original?.visible, appearanceVisible = appearance?.visible;
    if (original) original.visible = !appearance;
    if (appearance) appearance.visible = true;
    try { return render(); }
    finally {
      if (original) original.visible = originalVisible!;
      if (appearance) appearance.visible = appearanceVisible!;
    }
  }

  /** Keep a selected body in the shadow pass and reflections while omitting its
   * color/depth draw for one camera. Unlike visibility or camera layers, this
   * does not remove the body from Three's shadow traversal. All hooks and shared
   * material state are restored, including when rendering throws. */
  withHiddenFromCamera<T>(playerId: string, camera: Camera, render: () => T,
    hide: (object: Object3D) => boolean = () => true): T {
    const body = this.appearances.get(playerId) ?? this.originals.get(playerId)?.avatar;
    if (!body) return render();
    const objects = new Map<Object3D, Object3D['onAfterRender']>();
    const materials = new Map<Material, Material['onBeforeRender']>();
    const masked = new Map<Material, { colorWrite: boolean; depthWrite: boolean; stencilWrite: boolean }>();
    const restore = (material: Material): void => {
      const flags = masked.get(material);
      if (flags) { Object.assign(material, flags); masked.delete(material); }
    };
    body.traverse(object => {
      if (!('material' in object) || !hide(object)) return;
      const values: unknown[] = Array.isArray(object.material) ? object.material : [object.material];
      for (const value of values) if (value instanceof Material && !materials.has(value)) materials.set(value, value.onBeforeRender);
      objects.set(object, object.onAfterRender);
    });
    for (const [material, before] of materials) {
      material.onBeforeRender = function (...args) {
        // Material callbacks run after object callbacks, so a creator's custom
        // draw setup is preserved before applying the camera-only mask.
        before.apply(this, args);
        if (args[2] !== camera || !objects.has(args[4])) return;
        if (!masked.has(this)) masked.set(this, { colorWrite: this.colorWrite, depthWrite: this.depthWrite, stencilWrite: this.stencilWrite });
        this.colorWrite = false; this.depthWrite = false; this.stencilWrite = false;
      };
      if (before === Material.prototype.onBeforeRender || cameraMaskCallbacks.has(before))
        cameraMaskCallbacks.add(material.onBeforeRender);
    }
    for (const [object, after] of objects) {
      object.onAfterRender = function (...args) {
        restore(args[4]);
        after.apply(this, args);
      };
      if (after === Object3D.prototype.onAfterRender || cameraMaskCallbacks.has(after))
        cameraMaskCallbacks.add(object.onAfterRender);
    }
    try { return withInspectionCameraMask(camera, objects.keys(), render); }
    finally {
      for (const material of masked.keys()) restore(material);
      for (const [material, before] of materials) material.onBeforeRender = before;
      for (const [object, after] of objects) object.onAfterRender = after;
    }
  }

  /** Render the selected avatar's real arms/body. Shared humanoid head/neck
   * branches are masked only for the eye camera, keeping full shadows and
   * inspection views. Custom models may tag any branch with
   * userData.firstPersonHidden=true. An indivisible/unknown model falls back to
   * hiding its whole body; replacement avatars never reveal stock-model arms. */
  withFirstPersonBody<T>(playerId: string, camera: Camera, render: () => T): T {
    const body = this.inspectionTarget(playerId);
    if (!body) return render();
    const hidden = new Set<Object3D>();
    body.traverse(object => {
      if (object.userData.firstPersonHidden === true || ['head', 'neck-1', 'neck-2'].includes(object.name))
        object.traverse(child => hidden.add(child));
    });
    const hasSeparableHead = [...hidden].some(object => 'material' in object);
    return this.withHiddenFromCamera(playerId, camera, render, object => !hasSeparableHead || hidden.has(object));
  }

  remove(playerId: string): void {
    this.setPlayerAppearance(playerId, null);
    this.originals.delete(playerId);
  }

  dispose(): void {
    for (const id of this.appearances.keys()) this.setPlayerAppearance(id, null);
    this.originals.clear();
  }
}
