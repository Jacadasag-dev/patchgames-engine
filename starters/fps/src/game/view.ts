import {installStarterMedia} from '../sandbox/starterMedia.ts';
installStarterMedia();
import {createMapVisuals} from './mapVisuals.ts';
import {FirearmShotEffects} from '../sandbox/firearmView.ts';
import * as THREE from 'three';
import type { CreateView, GameView, InspectionFocus, ReviewCamera, ViewFrame } from '../shared/gameApi.ts';
import { PlayerAppearanceHost } from '../sandbox/playerAppearance.ts';
import { InspectionFocusController, type InspectionTarget } from '../sandbox/inspectionFocus.ts';
import { isInspectionCameraFrameActive, recordInspectionGameplayCamera } from '../sandbox/inspectionCamera.ts';
import { configureShadowRenderer } from '../sandbox/lighting.ts';
import { GROUND, WALLS, MAP_NAME } from './ground.ts';
import type { PlayerState, WorldState } from './shapes.ts';
import type { GameTuning } from './tuning.ts';

import {playSound,setSoundEpoch} from '../sandbox/audio.ts';
import {SHOT,BEEP,KILL,HEAD_KILL,weaponShot,weaponReload} from './sounds.ts';
import {GUNS} from './catalog.ts';
import {createFpsUi} from './ui.ts';

const FOOT_SURFACES=WALLS.filter(q=>q.kind==='step'||q.kind==='platform');
const GUN_SOUNDS=GUNS.map(g=>weaponShot(g.kind)),RELOAD_SOUNDS=GUNS.map(g=>weaponReload(g.style));
type Frame = ViewFrame<WorldState, PlayerState, GameTuning>;
interface Avatar { root: THREE.Group; body: THREE.Mesh; nose: THREE.Mesh; geometryKey: string }
const PLAYER_COLORS = [0x3b8b95, 0xbd6744, 0x7a76a0, 0xa38a42, 0x568064, 0xa65e72, 0x647caa, 0xa08970];


/** Shared FPS renderer with authored monastery geometry and rigged appearances. */
export class BlankView implements GameView<WorldState, PlayerState, GameTuning> {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly actors = new THREE.Group();
  private readonly appearances = new PlayerAppearanceHost(this.actors);
  private readonly focus = new InspectionFocusController();
  private readonly camera = new THREE.PerspectiveCamera(60, 1, .05, 400);
  private readonly inspectionCamera = new THREE.PerspectiveCamera(55, 1, .05, 1000);
  private readonly sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
  private readonly target = new THREE.Vector3();
  private readonly avatars = new Map<string, Avatar>();
  private readonly geometries = new Map<string, THREE.BufferGeometry>();
  private readonly materials = new Map<number, THREE.MeshStandardMaterial>();
  private readonly map:ReturnType<typeof createMapVisuals>;
  private reviewCamera: ReviewCamera | null = null;
  private facing = 0;
  private width = 960;
  private height = 540;
  private disposed = false;
  private readonly fx=new THREE.Group();
  private readonly bullets=new FirearmShotEffects();
  private bulletRound=0;
  private soundRound=0;
  private readonly soundReload=new Map<string,number>();
  actorSignals(frame:Frame){return Object.fromEntries(frame.players.map(p=>{
    const s=p.state,yaw=s.facing+s.recoil.yaw;
    const support=(side:number)=>{const x=s.x+Math.cos(yaw)*side*.12,z=s.z-Math.sin(yaw)*side*.12;let y=0;for(const q of FOOT_SURFACES){const top=(q.y??0)+q.h;if(top<=s.y+.4&&Math.abs(x-q.x)<=q.w/2&&Math.abs(z-q.z)<=q.d/2)y=Math.max(y,top);}return{position:{x,y,z},normal:{x:0,y:1,z:0},observedAtMs:frame.now};};
    return[p.id,{id:p.id,timeMs:frame.now,epoch:frame.world?.round.number,position:{x:s.x,y:s.y,z:s.z},velocity:{x:s.velocityX,y:s.velocityY,z:s.velocityZ},facing:{x:Math.sin(yaw),y:0,z:Math.cos(yaw)},grounded:!!s.grounded,posture:p.hp<=0?'dead':'standing',intendedVelocity:{x:s.velocityX,y:0,z:s.velocityZ},supports:{left:support(-1),right:support(1)},parameters:{aimPitch:s.aimPitch+s.recoil.pitch,reload:s.reload,weapon:s.weapon,cooldown:s.cooldown,aim:s.aim?1:0},actions:[]}];
  }));}


  readonly featureHost = {
    add: (object: unknown) => {
      if (!(object instanceof THREE.Object3D)) throw new Error('Feature visuals must be Three.js objects.');
      this.actors.add(object);
    },
    remove: (object: unknown) => { if (object instanceof THREE.Object3D) object.removeFromParent(); },
    setPlayerAppearance: (id: string, object: unknown | null) => this.appearances.setPlayerAppearance(id, object),
    setInspectionTarget: (id: string, object: unknown | null, label?: string, relatedTargets?: readonly string[]) => this.focus.setTarget(id, object, label, relatedTargets),
  };

  constructor(canvas: OffscreenCanvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    configureShadowRenderer(this.renderer);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene.background = new THREE.Color(0xaed8df);
    this.scene.fog = new THREE.Fog(0xaed8df, 85, 200);
    this.scene.add(new THREE.HemisphereLight(0xe3ecfa, 0x8c8477, 1.4));
    this.sun.position.set(18, 30, 12);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1; this.sun.shadow.camera.far = 150;
    const span = GROUND.halfExtent + 4;
    this.sun.shadow.camera.left = -span; this.sun.shadow.camera.right = span;
    this.sun.shadow.camera.top = span; this.sun.shadow.camera.bottom = -span;
    this.sun.shadow.bias = -.0002; this.sun.shadow.normalBias = .03;
    this.scene.add(this.sun,this.sun.target,this.actors,this.fx,this.bullets.root);
    this.map=createMapVisuals(this.scene);
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.width = Math.max(1, width); this.height = Math.max(1, height);
    this.renderer.setPixelRatio(Math.min(pixelRatio, 2));
    this.renderer.setSize(width, height, false);
    for (const camera of [this.camera, this.inspectionCamera]) { camera.aspect = this.width / this.height; camera.updateProjectionMatrix(); }
  }
  setReviewCamera(camera: ReviewCamera | null): void { this.reviewCamera = camera; }
  setInspectionFocus(focus: InspectionFocus | null): void { this.focus.setFocus(focus); }
  inspectionFocus(): Record<string, unknown> { return this.focus.inspection(); }
  info(): Record<string, number> { return { forwardX: Math.sin(this.facing), forwardZ: Math.cos(this.facing), width: this.width, height: this.height }; }
  ui(frame: Frame) { return this.disposed ? null : createFpsUi(frame); }
  inspection(): Record<string, unknown> {
    return { content:'Kestrel Protocol — '+MAP_NAME,map:this.map.inspection(), ground: { halfExtent: GROUND.halfExtent }, actors: this.avatars.size, shotEffects:this.bullets.inspection(),
      camera: { type: 'first-person / optional third-person', fov: this.camera.fov, position: this.camera.position.toArray() } };
  }

  private geometry(key: string, create: () => THREE.BufferGeometry): THREE.BufferGeometry {
    let geometry = this.geometries.get(key);
    if (!geometry) { geometry = create(); this.geometries.set(key, geometry); }
    return geometry;
  }
  private material(color: number): THREE.MeshStandardMaterial {
    let material = this.materials.get(color);
    if (!material) { material = new THREE.MeshStandardMaterial({ color, roughness: .6 }); this.materials.set(color, material); }
    return material;
  }
  /** Capsule bodies follow live tuning so radius and height edits show immediately. */
  private shapeAvatar(avatar: Avatar, tuning: GameTuning): void {
    const key = `${tuning.fighterRadius}:${tuning.fighterHeight}`;
    if (avatar.geometryKey === key) return;
    const radius = Math.max(.05, tuning.fighterRadius), height = Math.max(radius * 2.01, tuning.fighterHeight);
    avatar.body.geometry = this.geometry(`capsule:${key}`, () => new THREE.CapsuleGeometry(radius, height - radius * 2, 4, 16));
    avatar.body.position.y = height / 2;
    avatar.nose.position.set(0, height * .82, radius);
    avatar.geometryKey = key;
  }
  private makeAvatar(index: number): Avatar {
    const root = new THREE.Group(), color = PLAYER_COLORS[index % PLAYER_COLORS.length];
    const body = new THREE.Mesh(undefined, this.material(color));
    const nose = new THREE.Mesh(this.geometry('nose', () => new THREE.BoxGeometry(.12, .12, .16)), this.material(0x2a2d33));
    body.castShadow = body.receiveShadow = true; nose.castShadow = true;
    root.add(body, nose); this.actors.add(root);
    return { root, body, nose, geometryKey: '' };
  }
  private removeAvatar(id: string, avatar: Avatar): void {
    avatar.root.removeFromParent();
    this.appearances.setPlayerAppearance(id, null);
    this.avatars.delete(id);
  }

  update(frame: Frame): void {
    const mapFocus=frame.players.find(p=>p.isLocal)?.state;this.map.update(mapFocus?{x:mapFocus.x,y:mapFocus.y,z:mapFocus.z}:{x:0,y:0,z:0});
    if (this.disposed) return;
    for (const [id, avatar] of this.avatars) if (!frame.players.some(player => player.id === id && player.active !== false)) this.removeAvatar(id, avatar);
    frame.players.forEach((player, index) => {
      if (player.active === false) return;
      let avatar = this.avatars.get(player.id);
      if (!avatar) { avatar = this.makeAvatar(index); this.avatars.set(player.id, avatar); }
      this.shapeAvatar(avatar, frame.tuning);
      const state = player.state, alive = player.hp > 0;
      avatar.root.position.set(state.x, state.y, state.z);
      avatar.root.rotation.y = state.facing;
      this.appearances.update(player.id, avatar.body, {...state,facing:state.facing+state.recoil.yaw}, alive, alive);
      avatar.nose.visible = false;
    });
    const local = frame.players.find(player => player.isLocal && player.active !== false), state = local?.state;
    if (state) {
      this.facing = state.facing;
      const eye = frame.tuning.fighterHeight * .9;
      this.target.set(state.x, state.y + eye, state.z);
      const facing=state.facing+state.recoil.yaw;const forwardX = Math.sin(facing), forwardZ = Math.cos(facing), pitch = state.aimPitch+state.recoil.pitch;
      if(state.third){const back=Math.cos(pitch)*4.5,rise=-Math.sin(pitch)*4.5;this.camera.position.set(this.target.x-forwardX*back,this.target.y+rise,this.target.z-forwardZ*back);this.camera.lookAt(this.target);}
      else {this.camera.position.copy(this.target);this.camera.lookAt(this.target.x+forwardX*Math.cos(pitch),this.target.y+Math.sin(pitch),this.target.z+forwardZ*Math.cos(pitch));}
      this.camera.fov=state.aim?(GUNS[state.weapon].kind.startsWith('sniper')?24:52):78;this.camera.updateProjectionMatrix();
    } else {
      const distance = this.width < this.height ? 30 * this.height / this.width : 30;
      this.camera.position.set(0, distance * .7, distance * .8); this.camera.lookAt(0, 0, 0);
    }
    if (this.reviewCamera) {
      const review = this.reviewCamera;
      this.inspectionCamera.position.set(review.x, review.y, review.z);
      this.inspectionCamera.rotation.set(review.pitch, review.yaw, 0, 'YXZ');
      this.inspectionCamera.fov = review.fov; this.inspectionCamera.updateProjectionMatrix();
    }
    const camera = this.reviewCamera ? this.inspectionCamera : this.camera;
    const targets: InspectionTarget[] = frame.players.flatMap((player, index) => {
      const object = player.active !== false && player.hp > 0 ? this.appearances.inspectionTarget(player.id) : undefined;
      return object ? [{ id: `player:${player.id}`, label: player.name, player: index, object }] : [];
    });
    if(isInspectionCameraFrameActive()){const measure=()=>recordInspectionGameplayCamera(this.scene,this.camera,true,local?.id);if(local&&!local.state.third)this.appearances.withFirstPersonBody(local.id,this.camera,measure);else measure();}
    this.updateEffects(frame);
    if(frame.world){if(this.soundRound!==frame.world.round.number){this.soundRound=frame.world.round.number;setSoundEpoch('kestrel-'+this.soundRound);}
    for(const shot of frame.world.shots)playSound('shot-'+shot.group,GUN_SOUNDS[shot.weapon],{position:[shot.x,shot.y,shot.z],gain:.65});
    for(const kill of frame.world.kills)if(frame.players[kill.owner]?.id===local?.id)playSound('kill-'+kill.id,kill.head?HEAD_KILL:KILL,{gain:.8});
    for(const p of frame.players){const prev=this.soundReload.get(p.id)??0;if(p.state.reload>prev)playSound('reload-'+p.id+'-'+Math.floor(frame.world.elapsedMs/100),RELOAD_SOUNDS[p.state.weapon],{position:[p.state.x,p.state.y+1,p.state.z],gain:.35});this.soundReload.set(p.id,p.state.reload);
    const obj=this.appearances.inspectionTarget(p.id);if(obj&&local&&p.team!==local.team&&p.state.cloak>0&&p.state.reveal<=0&&Math.hypot(p.state.x-local.state.x,p.state.z-local.state.z)>7)obj.visible=false;}
    for(const e of frame.world.effects)if(e.kind===8)playSound('lure-'+e.id+'-'+Math.floor(e.life/2000),SHOT,{position:[e.x,1.4,e.z],gain:.45});
    if(frame.world.bomb.state===1)playSound('beep-'+Math.floor(frame.world.bomb.timer/1000),BEEP,{position:[frame.world.bomb.x,.5,frame.world.bomb.z],gain:.4});}
    const draw=()=>this.focus.render(this.renderer,this.scene,camera,targets);
    if(local&&!local.state.third&&!this.reviewCamera)this.appearances.withFirstPersonBody(local.id,camera,draw);else draw();
  }

 private updateEffects(frame:Frame){while(this.fx.children.length){const c=this.fx.children[0] as THREE.Mesh;this.fx.remove(c);c.geometry?.dispose();if(c.material&&!Array.isArray(c.material))c.material.dispose();}
 const w=frame.world;if(!w)return;
 const local=frame.players.find(p=>p.isLocal);if(local)for(const p of frame.players){if(p.isLocal||p.hp<=0||p.active===false)continue;const dx=p.state.x-local.state.x,dz=p.state.z-local.state.z,d=Math.hypot(dx,dz),hostile=p.team!==local.team;let hidden=hostile&&p.state.cloak>0&&p.state.reveal<=0&&d>7;if(hostile)for(const e of w.effects)if(e.kind===0&&d>0){const t=Math.max(0,Math.min(1,((e.x-local.state.x)*dx+(e.z-local.state.z)*dz)/(d*d)));if(Math.hypot(local.state.x+t*dx-e.x,local.state.z+t*dz-e.z)<e.radius)hidden=true;}if(hidden)continue;const marker=new THREE.Mesh(new THREE.ConeGeometry(.13,.23,4),new THREE.MeshBasicMaterial({color:hostile?0xf46c63:0x68f2d5,depthTest:true}));marker.rotation.z=Math.PI;marker.position.set(p.state.x,p.state.y+2.03,p.state.z);this.fx.add(marker);}
 for(const e of w.effects){if(e.kind===8){const mat=new THREE.MeshStandardMaterial({color:0xc28ff5,emissive:0x784cba,emissiveIntensity:.6,transparent:true,opacity:.55});for(const q of [{x:0,y:1.25,w:.46,h:.55,d:.24},{x:0,y:1.72,w:.27,h:.3,d:.25},{x:-.16,y:.55,w:.16,h:.8,d:.16},{x:.16,y:.55,w:.16,h:.8,d:.16},{x:-.34,y:1.25,w:.16,h:.48,d:.16},{x:.34,y:1.25,w:.16,h:.48,d:.16}]){const ghost=new THREE.Mesh(new THREE.BoxGeometry(q.w,q.h,q.d),mat.clone());ghost.position.set(e.x+q.x,q.y,e.z);this.fx.add(ghost);}continue;}const colors=[0x6ebdb9,0x4affdf,0xffdc76,0xc0a7ff,0xff6333,0xffb371,0x53d5ec,0x638fff,0xc48bec,0xbf90ee,0xffe6a6];
 let geo:THREE.BufferGeometry=e.kind===6?new THREE.BoxGeometry(e.radius*2,3,.35):new THREE.SphereGeometry(e.radius,20,12);
 const n=new THREE.Mesh(geo,new THREE.MeshStandardMaterial({color:colors[e.kind],transparent:true,opacity:e.kind===0?.8:e.kind===6?.72:.3,emissive:colors[e.kind],emissiveIntensity:.2,depthWrite:false}));
 n.position.set(e.x,e.kind===4?.12:e.kind===0?2:1.2,e.z);if(e.kind===4||e.kind===2)n.scale.y=.08;this.fx.add(n);
 }
 if(this.bulletRound!==w.round.number){this.bullets.reset();this.bulletRound=w.round.number;}
 this.bullets.update(w.shots.map(sh=>{const owner=frame.players[sh.owner],pose=owner?this.appearances.inspectionTarget(owner.id)?.userData.firearmPose:undefined,muzzle=pose?.muzzle()?.position;return {id:sh.id,timeMs:sh.timeMs,from:muzzle?{x:muzzle.x,y:muzzle.y,z:muzzle.z}:{x:sh.x,y:sh.y,z:sh.z},to:{x:sh.ex,y:sh.ey,z:sh.ez},normal:{x:sh.nx,y:sh.ny,z:sh.nz},surface:sh.surface};}),w.elapsedMs);
 if(w.bomb.state===1||w.bomb.carrier<0){const n=new THREE.Mesh(new THREE.BoxGeometry(.36,.24,.55),new THREE.MeshStandardMaterial({color:0x243645,emissive:w.bomb.state===1?0xb4462f:0x136b75,emissiveIntensity:.7}));n.position.set(w.bomb.x,.2,w.bomb.z);this.fx.add(n);}
 }
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    for (const [id, avatar] of this.avatars) this.removeAvatar(id, avatar);
    this.appearances.dispose();this.bullets.dispose();
    this.geometries.forEach(geometry => geometry.dispose()); this.materials.forEach(material => material.dispose());
    this.map.dispose();
    this.scene.clear(); this.renderer.dispose();
  }
}
const createView: CreateView<WorldState, PlayerState, GameTuning> = canvas => new BlankView(canvas);
export default createView;


