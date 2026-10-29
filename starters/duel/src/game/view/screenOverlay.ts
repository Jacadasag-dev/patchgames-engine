import * as THREE from 'three';

/** Empty screen-space canvas layer for game-created graphics, below host HTML UI.
 * Add objects to root; coordinates are CSS pixels, origin at viewport center,
 * +x right, +y up, z=0. Use unlit materials for flat graphics. Resize with the view.
 * The game owns object appearance, visibility and disposal; no mechanics live here.
 */
export class ScreenOverlay {
  readonly root = new THREE.Group();
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 2);

  constructor() {
    this.camera.position.z = 1;
    this.scene.add(this.root);
  }

  resize(width: number, height: number): void {
    const w = Math.max(1, width), h = Math.max(1, height);
    this.camera.left = -w / 2; this.camera.right = w / 2;
    this.camera.top = h / 2; this.camera.bottom = -h / 2;
    this.camera.updateProjectionMatrix();
  }

  /** Call AFTER the final world/postprocessing pass on the intended output target.
   * A separate scene prevents later world draws, fog and lights from covering UI.
   * Fresh depth prevents world occlusion even for ordinary depth-tested materials.
   * Empty/hidden layers cost no additional GPU pass. Never renders above host menus.
   */
  render(renderer: THREE.WebGLRenderer, visible = true): void {
    if (!visible || !this.root.visible || this.root.children.length === 0) return;
    const { autoClear, clippingPlanes, localClippingEnabled, toneMapping } = renderer;
    try {
      renderer.autoClear = false; // Keep the world's color buffer.
      renderer.clippingPlanes = [];
      renderer.localClippingEnabled = false;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.clearDepth();
      renderer.render(this.scene, this.camera);
    } finally {
      renderer.autoClear = autoClear;
      renderer.clippingPlanes = clippingPlanes;
      renderer.localClippingEnabled = localClippingEnabled;
      renderer.toneMapping = toneMapping;
    }
  }
}
