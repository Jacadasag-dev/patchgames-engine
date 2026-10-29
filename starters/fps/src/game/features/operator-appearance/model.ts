import {createFirearmModel} from '../../../sandbox/firearmModels.ts';
import {GUNS} from './weapons.ts';
import {BoxGeometry, SphereGeometry, Group, Mesh, MeshStandardMaterial, CylinderGeometry} from 'three';
import {HumanoidFirearmPose} from '../../../sandbox/firearmPose.ts';
import {ActorAnimationController, type ActorAnimationOptions} from '../../../sandbox/actorAnimation.ts';
import {ActorHeading, HumanoidLocomotionDriver} from '../../../sandbox/actorLocomotion.ts';
import {createHumanoidSkeleton} from '../../../sandbox/animationView.ts';
import {defineAnimationClip, quaternionFromEuler, type ActorPresentationSignals, type AnimationPose} from '../../../sandbox/animation.ts';

const rotate = (x = 0, y = 0, z = 0) => ({rotation: quaternionFromEuler({x, y, z})});
// Editable rest-relative actions. Reuse these names or add your own semantic clips.
export const clips = {
 rifle:defineAnimationClip({durationMs:1000,loop:true,sample:()=>({'right-shoulder':rotate(-1.3,0,-.12),'left-shoulder':rotate(-1.15,0,.32),'right-elbow':rotate(-.2),'left-elbow':rotate(-.65)})}),
  attack: defineAnimationClip({durationMs: 550, sample: ({phase}) => ({
    'right-shoulder': rotate(-Math.sin(phase * Math.PI) * 1.6), 'right-elbow': rotate(-.3),
  })}),
  skill: defineAnimationClip({durationMs: 700, sample: ({phase}) => ({
    'left-shoulder': rotate(-Math.sin(phase * Math.PI) * 1.7), 'right-shoulder': rotate(-Math.sin(phase * Math.PI) * 1.7),
  })}),
  posture: defineAnimationClip({durationMs: 1000, loop: true, sample: ({signals}): AnimationPose => {
    if (signals?.posture === 'sitting') return {
      hips: {position: {x: 0, y: -.82, z: 0}},
      'left-hip': rotate(-Math.PI / 2), 'right-hip': rotate(-Math.PI / 2),
      'left-knee': rotate(Math.PI / 2), 'right-knee': rotate(Math.PI / 2),
      'left-shoulder': rotate(-.45), 'right-shoulder': rotate(-.45),
      'spine-1': rotate(0, Number(signals.parameters?.torsoLookYaw ?? 0)),
    };
    if (signals?.posture === 'downed' || signals?.posture === 'dead') return {
      hips: {position: {x: 0, y: -.74, z: 0}, ...rotate(0, 0, Math.PI / 2)},
    };
    if (signals?.posture === 'reviving') return {
      hips: {position: {x: 0, y: -.34, z: 0}}, 'left-hip': rotate(-1.1), 'right-hip': rotate(-.6),
      'left-knee': rotate(1.6), 'right-knee': rotate(1.8), 'spine-1': rotate(.4),
    };
    if (signals?.posture === 'blocking') return {'left-shoulder': rotate(-1), 'left-elbow': rotate(-1.2)};
    return {};
  }}),
};

// This is the editable visual design, separate from rig and locomotion. Attach custom
// meshes/skinned geometry to any of the 25 joints; keep +Y up, +Z forward, feet at y=0.
export function buildBody(actor: ReturnType<typeof createHumanoidSkeleton>, color: string) {
 const boxGeo=new BoxGeometry(1,1,1),sphere=new SphereGeometry(1,14,10),limbGeo=new CylinderGeometry(1,1,1,12);
 const armor=new MeshStandardMaterial({color,roughness:.6,metalness:.22});
 const cloth=new MeshStandardMaterial({color:'#182932',roughness:.95});
 const skin=new MeshStandardMaterial({color:color==='#c68ee5'?'#b87758':color==='#e5b747'?'#9b6449':'#d69e78',roughness:.82});
 const hair=new MeshStandardMaterial({color:color==='#46cfc1'?'#2d2231':color==='#eb7956'?'#50362e':'#17232b',roughness:.9});
 const shine=new MeshStandardMaterial({color:'#a7faf4',emissive:'#2b918a',emissiveIntensity:.35,metalness:.5});
 function part(j:string,size:number[],at:number[],mat=armor,round=false){const n=new Mesh(round?sphere:boxGeo,mat);n.scale.set(size[0],size[1],size[2]);n.position.set(at[0],at[1],at[2]);n.castShadow=n.receiveShadow=true;if(['hips','spine-1','spine-2','spine-3','spine-4','chest','left-clavicle','right-clavicle','left-shoulder','right-shoulder'].includes(j))n.userData.firstPersonHidden=true;actor.joints[j].add(n);return n;}
 function limb(j:string,radius:number,length:number,atY:number,mat=cloth){const n=new Mesh(limbGeo,mat);n.scale.set(radius,length,radius*.95);n.position.y=atY;n.castShadow=n.receiveShadow=true;if(j.endsWith('shoulder'))n.userData.firstPersonHidden=true;actor.joints[j].add(n);return n;}
 // The jacket, collar and sleeves overlap joint boundaries to preserve a clothed silhouette.
 part('hips',[.43,.24,.31],[0,.02,0],cloth);
 for(const j of ['spine-1','spine-2','spine-3','spine-4'])part(j,[.47,.15,.31],[0,.035,0],armor);
 part('chest',[.49,.37,.33],[0,-.075,0],armor);
 part('chest',[.38,.27,.055],[0,-.065,.187],cloth);
 part('chest',[.022,.30,.016],[0,-.06,.223],shine);
 part('chest',[.33,.34,.12],[0,-.06,-.205],cloth);
 part('chest',[.115,.135,.065],[.175,.035,.19],cloth);
 part('chest',[.016,.19,.02],[.19,.17,.20],cloth);
 limb('neck-1',.084,.34,-.08,skin);
 part('chest',[.29,.11,.31],[0,.15,0],cloth);
 part('hips',[.47,.075,.35],[0,.045,0],cloth);
 for(const x of [-.16,.16])part('hips',[.12,.14,.09],[x,-.045,.20],armor);
 part('head',[.155,.19,.145],[0,.085,0],skin,true);
 part('head',[.163,.075,.15],[0,.23,-.01],hair,true);
 part('head',[.115,.021,.023],[0,.14,.14],cloth);
 part('head',[.095,.008,.027],[0,.145,.15],shine);
 part('head',[.04,.06,.045],[0,.085,.14],skin,true);
 for(const side of ['left','right']){
 const sign=side==='left'?-1:1;
 part(side+'-clavicle',[.33,.19,.27],[sign*.14,0,0],armor);
 limb(side+'-shoulder',.107,.355,-.153,armor);
 part(side+'-elbow',[.092,.092,.092],[0,0,0],cloth,true);
 limb(side+'-elbow',.083,.335,-.143,cloth);
 part(side+'-hand',[.09,.07,.09],[0,.008,0],cloth);
 part(side+'-hand',[.145,.135,.155],[0,-.054,.015],skin);
 part(side+'-hand',[.15,.07,.16],[0,-.018,.018],cloth);
 part(side+'-hip',[.12,.12,.12],[0,.005,0],cloth,true);
 limb(side+'-hip',.123,.455,-.205,cloth);
 part(side+'-knee',[.115,.115,.115],[0,.012,0],cloth,true);
 limb(side+'-knee',.104,.44,-.19,cloth);
 part(side+'-knee',[.20,.18,.07],[0,-.035,.105],armor);
 part(side+'-foot',[.215,.19,.32],[0,-.045,.055],cloth);
 part(side+'-toe',[.22,.13,.19],[0,-.016,.065],cloth);
 }
 if(color==='#e5b747')part('head',[.2,.02,.19],[0,.21,0],armor);
 if(color==='#729de5'){part('left-shoulder',[.22,.12,.23],[0,-.02,0]);part('right-shoulder',[.22,.12,.23],[0,-.02,0]);}
 if(color==='#c68ee5')part('chest',[.5,.08,.32],[0,.14,0],cloth);
 let selected=-1,held:ReturnType<typeof createFirearmModel>|undefined,pose:HumanoidFirearmPose|undefined,unregister:(()=>void)|undefined;
 const choose=(index:number)=>{if(index===selected)return;pose?.dispose();unregister?.();held?.dispose();selected=index;const spec=GUNS[index]??GUNS[0];held=createFirearmModel(spec.kind,Number.parseInt(spec.color.slice(1),16));

 pose=new HumanoidFirearmPose(actor,held.root,held.sockets);actor.root.userData.firearmPose=pose;actor.root.userData.weapon=held.root;};
 actor.root.userData.updateWeapon=(index:number,remaining:number,cooldown:number,pitch:number)=>{choose(index);const spec=GUNS[index]??GUNS[0],progress=remaining>0?1-remaining/spec.reload:0;held!.animate(progress,spec.style,cooldown/spec.interval);pose!.apply({pitch,reload:remaining>0?1:0,reloadProgress:progress,reloadStyle:spec.style,recoil:Math.min(.045,cooldown/3500)});};choose(0);
 return()=>{pose?.dispose();unregister?.();held?.dispose();boxGeo.dispose();sphere.dispose();limbGeo.dispose();armor.dispose();cloth.dispose();skin.dispose();hair.dispose();shine.dispose();};
}

type ActorOptions = Pick<ActorAnimationOptions, 'clips' | 'locomotion' | 'layers' | 'adaptPose' | 'afterApply' | 'onReset' | 'equipmentMotion' | 'equipmentLoads'> & {
  buildBody?: typeof buildBody;
  /** Visual turn response in 1/seconds; 20 matches RPG, 0 opts into instant turns. */
  turnResponse?: number;
};
/** One actor/controller per player, one shared immutable motion database. */
export function createActor(color: string, options: ActorOptions = {}) {
  const actor = createHumanoidSkeleton(), root = new Group(), presentation = new Group();
  presentation.name = 'actor-presentation'; root.add(presentation); presentation.add(actor.root);

  const heading = new ActorHeading({response: options.turnResponse??0});
  let direction: ReturnType<ActorHeading['sample']> | undefined;
  const disposeBody = (options.buildBody ?? buildBody)(actor, color);
  const locomotion = new HumanoidLocomotionDriver(), availableClips = {...clips, ...options.clips};
  const stationary = (posture?: string) => ['sitting', 'downed', 'dead', 'reviving'].includes(posture ?? '');
  const animation = new ActorAnimationController({...options, rig: actor.animationRig, clips: availableClips,
    afterApply:(result,context)=>{actor.root.userData.updateWeapon?.(Number(context.signals.parameters?.weapon??0),Number(context.signals.parameters?.reload??0),Number(context.signals.parameters?.cooldown??0),Number(context.signals.parameters?.aimPitch??0));root.userData.firearmPose=actor.root.userData.firearmPose;options.afterApply?.(result,context);},
    locomotion: options.locomotion ?? {
      reset: () => locomotion.reset(),
      sample: context => stationary(context.signals.posture)
        ? {pose: {}, diagnostics: {source: 'authored:posture', state: context.signals.posture}} : locomotion.sample(context),
    },
    layers: context => {
      const {signals} = context;
      const layers: {clip: string; timeMs?: number}[] = [{clip: 'posture'}, {clip:'rifle'}];
      // Continuous observations are a fallback only; authoritative action IDs take priority.
      if (signals.parameters?.attacking && !signals.actions?.some(action => action.clip === 'attack')) {
        const duration = Number(signals.parameters.attackDurationMs ?? 0), remaining = Number(signals.parameters.attackRemainingMs ?? 0);
        layers.push({clip: 'attack', timeMs: duration > 0
          ? Math.max(0, Math.min(1, 1 - remaining / duration)) * availableClips.attack.durationMs : signals.timeMs % availableClips.attack.durationMs});
      }
      return [...layers, ...options.layers?.(context) ?? []];
    },
  });
  root.userData.firearmPose=actor.root.userData.firearmPose;
  let last: ReturnType<ActorAnimationController['sample']> | undefined, previousPosture: string | undefined;
  let unsupported: string[] = [], disposed = false;
  return {root, joints: actor.joints,
    update(signals: Readonly<ActorPresentationSignals>) {
      if (disposed) return;
      root.userData.inspectionActorId = signals.id;
      const changed = previousPosture !== undefined && previousPosture !== signals.posture;
      previousPosture = signals.posture;
      // The host positions root and applies raw gameplay facing. Counter-rotate
      // only the body; matching and foot support use that same visual heading.
      direction = heading.sample(signals, changed);
      presentation.rotation.y = direction.offsetYaw;
      unsupported = [...new Set((signals.actions ?? []).filter(action => !Object.hasOwn(availableClips, action.clip)).map(action => action.clip))];
      last = animation.sample({signals: {...signals, facing: direction.forward}, reset: changed,
        actions: signals.actions?.filter(action => Object.hasOwn(availableClips, action.clip)) ?? []});

    },
    inspection() { return {rigId: 'humanoid-v1', joints: Object.keys(actor.joints).length, posture: previousPosture ?? 'standing',
      heading: direction ? {yaw: direction.yaw, targetYaw: direction.targetYaw, offsetYaw: direction.offsetYaw} : null,
      locomotion: last?.diagnostics.locomotion ?? null, rig: last?.diagnostics.rig ?? null,
      equipmentMotion: last?.diagnostics.equipmentMotion ?? null,handPlacement:(actor.root.userData.firearmPose as HumanoidFirearmPose)?.inspection(),
      actions: last?.diagnostics.animation.actions ?? [], warnings: [...last?.diagnostics.warnings ?? [],
        ...unsupported.map(name => 'No authored clip for action ' + name)]}; },
    dispose() { if (disposed) return; disposed = true; animation.reset(); root.removeFromParent(); actor.skeleton.dispose(); disposeBody(); },
  };
}


