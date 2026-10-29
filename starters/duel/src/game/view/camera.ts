import * as THREE from 'three';
import type { ViewFrame } from '../../shared/gameApi.ts';
import type { WorldState, FighterState } from '../shapes.ts';
import type { GameTuning } from '../tuning.ts';

/** A close shoulder camera keeps the held sword and opponent readable. */
export class FightCamera {
  readonly camera = new THREE.PerspectiveCamera(63, 1, .05, 160);
  private readonly target = new THREE.Vector3();
  private ready = false;
  private actor = '';
  update(frame: ViewFrame<WorldState, FighterState, GameTuning>): void {
    const followed = frame.world ? frame.players.find(p => p.isLocal && p.active !== false) ?? frame.players.find(p => p.active !== false) : undefined;
    let position: THREE.Vector3, target: THREE.Vector3;
    if (followed) {
      const s = followed.state, forward = new THREE.Vector3(Math.sin(s.facing), 0, Math.cos(s.facing));
      const right = new THREE.Vector3(-forward.z, 0, forward.x);
      position = new THREE.Vector3(s.x, s.y + 1.95 - Math.sin(s.aimPitch) * 1.2, s.z).addScaledVector(forward, s.combat.sprint ? -3.35 : -2.85).addScaledVector(right, 1.05);
      target = new THREE.Vector3(s.x, s.y + 1.35 + Math.sin(s.aimPitch) * 2, s.z).addScaledVector(forward, 3.6).addScaledVector(right, .18);
      const radius = Math.hypot(position.x, position.z), limit = frame.tuning.arenaRadius + .55;
      if (radius > limit) { position.x *= limit / radius; position.z *= limit / radius; }
      position.y = Math.max(.50, position.y);
    } else {
      const angle = .6 + frame.now * .000035;
      position = new THREE.Vector3(Math.sin(angle) * 14, 8.4, Math.cos(angle) * 14); target = new THREE.Vector3(0, 1, 0);
    }
    const id = followed?.id ?? 'menu', blend = !this.ready || this.actor !== id ? 1 : 1 - Math.exp(-Math.max(0, frame.dt) * 16);
    this.camera.position.lerp(position, blend); this.target.lerp(target, blend); this.camera.lookAt(this.target); this.ready = true; this.actor = id;
  }
  forward(): { x: number; z: number } { const v = this.camera.getWorldDirection(new THREE.Vector3()), n = Math.hypot(v.x, v.z) || 1; return { x: v.x / n, z: v.z / n }; }
  resize(width: number, height: number): void { this.camera.aspect = width / Math.max(1, height); this.camera.updateProjectionMatrix(); }
}
