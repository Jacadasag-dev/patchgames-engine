import * as THREE from 'three';
import type { FighterState } from '../shapes.ts';

export class DuelHud {
  private readonly canvas = new OffscreenCanvas(960, 540);
  private readonly ctx = this.canvas.getContext('2d')!;
  private texture = new THREE.CanvasTexture(this.canvas);
  private readonly material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
  private readonly geometry = new THREE.PlaneGeometry(2, 2);
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  constructor() { this.scene.add(new THREE.Mesh(this.geometry, this.material)); this.configure(); }
  private configure() { this.texture.colorSpace = THREE.SRGBColorSpace; this.texture.minFilter = THREE.LinearFilter; this.texture.generateMipmaps = false; }
  resize(width: number, height: number): void {
    if (width === this.canvas.width && height === this.canvas.height) return;
    this.texture.dispose(); this.canvas.width = Math.max(1, Math.round(width)); this.canvas.height = Math.max(1, Math.round(height));
    this.texture = new THREE.CanvasTexture(this.canvas); this.configure(); this.material.map = this.texture;
  }
  update(me?: FighterState, enemy?: FighterState, chargeDuration = 1000): void {
    const c = this.ctx, w = this.canvas.width, h = this.canvas.height, s = Math.min(1, w / 900, h / 500);
    c.clearRect(0, 0, w, h); this.texture.needsUpdate = true; if (!me) return;
    const x = w / 2, y = h * .60, r = 29 * s;
    const arrows = [[-r * 1.5, 0, Math.PI], [0, -r * 1.4, -Math.PI / 2], [r * 1.5, 0, 0]];
    arrows.forEach(([dx, dy, a], index) => {
      const threatened = enemy && ['light', 'heavy', 'charging'].includes(enemy.combat.attackState) && enemy.combat.attackGuard === index;
      c.save(); c.translate(x + dx, y + dy); c.rotate(a); c.beginPath(); c.moveTo(10 * s, 0); c.lineTo(-7 * s, -8 * s); c.lineTo(-3 * s, 0); c.lineTo(-7 * s, 8 * s); c.closePath();
      c.fillStyle = threatened ? '#f47151' : me.combat.guard === index ? '#f2db9b' : '#161d20b0'; c.strokeStyle = me.combat.guard === index ? '#fff4d0' : '#a39d86'; c.lineWidth = 1.5 * s; c.fill(); c.stroke(); c.restore();
    });
    c.textAlign = 'center'; c.font = `${11 * s}px sans-serif`; c.fillStyle = '#e8dec5';
    c.fillText(['LEFT', 'HIGH', 'RIGHT'][me.combat.guard] ?? 'HIGH', x, y + 35 * s);
    if (me.combat.attackState === 'charging') {
      const charge = Math.max(0, Math.min(1, me.combat.chargeMs / Math.max(1, chargeDuration)));
      c.fillStyle = '#111c21dd'; c.fillRect(x - 70 * s, y + 49 * s, 140 * s, 5 * s);
      c.fillStyle = charge >= 1 ? '#f3b14f' : '#e5cf96'; c.fillRect(x - 70 * s, y + 49 * s, 140 * s * charge, 5 * s);
      c.fillText(charge >= 1 ? 'FULL CHARGE · RELEASE' : 'CHARGING HEAVY', x, y + 70 * s);
    }
    if (me.combat.feedbackMs > 0) {
      c.font = `bold ${18 * s}px serif`; c.fillStyle = me.combat.actionFeedback === 'hit' ? '#ff957c' : '#ffe7a9';
      c.fillText(({ parry: 'PARRY', block: 'BLOCKED', hiltCounter: 'HILT COUNTER', hit: 'HIT' } as Record<string, string>)[me.combat.actionFeedback] ?? '', x, y - 76 * s);
    }
    if (me.combat.stunMs > 0) { c.font = `${14 * s}px sans-serif`; c.fillStyle = '#ffbc79'; c.fillText('STUNNED', x, y - 101 * s); }
    // Controls are not drawn here: the engine lists the declared bindings in the Games browser and the match menu.
    this.texture.needsUpdate = true;
  }
  render(renderer: THREE.WebGLRenderer): void { const auto = renderer.autoClear; renderer.autoClear = false; renderer.clearDepth(); renderer.render(this.scene, this.camera); renderer.autoClear = auto; }
  dispose(): void { this.texture.dispose(); this.material.dispose(); this.geometry.dispose(); }
}
