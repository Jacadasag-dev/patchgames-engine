import * as THREE from 'three';
import type {ActorPresentationSignals} from '../sandbox/animation.ts';
import {ActorActionTimeline} from '../sandbox/actorAnimation.ts';
import type {TerrainWorldSnapshot} from '../sandbox/terrainWorld.ts';
import {CreatureFootPlacement,type CreatureFootPlacementResult} from '../sandbox/creatureFootPlacement.ts';
import {attachEquipment,createBowModel,createSwordModel} from '../sandbox/equipmentView.ts';
import {registerEquipmentOrientation} from '../sandbox/equipmentOrientation.ts';
import {ArenaEquipmentPose,ARENA_BOW_PALM,ARENA_SWORD_PALM} from './equipmentPose.ts';
import {createActor, type buildBody} from './actorStarter.ts';
import {ARENA_STRIKE,ARENA_BOW_AIM,ARENA_SWORD_CARRY,ARENA_BANDAGE,createArenaEquipmentLayers} from './animations.ts';

/** Shared humanoid reference dimensions. The view may uniformly scale the root. */
export const ARENA_ACTOR_HEIGHT=2.08;
type Skeleton=Parameters<typeof buildBody>[0];
type ResourcePool={users:number;box:THREE.BoxGeometry;round:THREE.CylinderGeometry;head:THREE.IcosahedronGeometry;
  hands:Record<string,THREE.BufferGeometry>;
  materials:Record<string,THREE.MeshStandardMaterial>};
let resources:ResourcePool|undefined;
function gripHand(direction:number):THREE.BufferGeometry {
  const parts:THREE.BufferGeometry[]=[];
  const part=(size:[number,number,number],at:[number,number,number],roll=0)=>{
    const box=new THREE.BoxGeometry(...size);box.rotateZ(roll);box.translate(...at);parts.push(box.toNonIndexed());box.dispose();
  };
  part([.105,.12,.065],[0,-.055,-.035]);
  for(let finger=0;finger<4;finger++){
    const x=(finger-1.5)*.026;part([.023,.065,.065],[x,-.085,.014]);part([.023,.038,.022],[x,-.055,.043]);
  }
  part([.035,.075,.04],[direction*.055,-.025,.008],direction*.35);
  const geometry=new THREE.BufferGeometry();
  for(const attribute of ['position','normal'])geometry.setAttribute(attribute,new THREE.Float32BufferAttribute(
    parts.flatMap(part=>Array.from(part.getAttribute(attribute).array)),3));
  parts.forEach(part=>part.dispose());geometry.computeBoundingSphere();return geometry;
}
function acquireResources():ResourcePool {
  if(!resources){
    const paint=(color:number,metalness=0)=>new THREE.MeshStandardMaterial({color,metalness,roughness:metalness?.4:.88,flatShading:true});
    resources={users:0,box:new THREE.BoxGeometry(1,1,1),round:new THREE.CylinderGeometry(1,1,1,8),
      head:new THREE.IcosahedronGeometry(1,1),hands:{left:gripHand(-1),right:gripHand(1)},materials:{leather:paint(0x4b3425),trousers:paint(0x3c4743),
        linen:paint(0xd8cfaa),skin0:paint(0xc78f69),skin1:paint(0xe1b98c),skin2:paint(0x936345),
        hair0:paint(0x3a281f),hair1:paint(0x88603b),hair2:paint(0x292e2b),eye:paint(0x202421),
        steel:paint(0xaebdbb,.65),bronze:paint(0xb49855,.55)}};
  }
  resources.users++;return resources;
}
function releaseResources(pool:ResourcePool):void {
  if(--pool.users)return;
  pool.box.dispose();pool.round.dispose();pool.head.dispose();Object.values(pool.hands).forEach(hand=>hand.dispose());
  for(const material of Object.values(pool.materials))material.dispose();
  if(resources===pool)resources=undefined;
}
/** Visual edits stay local to this ordinary game source. All 32 contestants share
 * shape buffers and the base palette; cloth remains independently editable. */
function survivorBody(skeleton:Skeleton,color:string) {
  const pool=acquireResources(),palette=pool.materials;
  const cloth=new THREE.MeshStandardMaterial({color,roughness:.92,flatShading:true});
  const shade=new THREE.Color(color).getHex()%3,skin=palette['skin'+shade],hair=palette['hair'+shade];
  const add=(joint:string,name:string,size:[number,number,number],at:[number,number,number],
    material=cloth,shape:THREE.BufferGeometry=pool.box)=>{
    const mesh=new THREE.Mesh(shape,material);mesh.name=name;mesh.position.set(...at);mesh.scale.set(...size);
    mesh.castShadow=mesh.receiveShadow=true;skeleton.joints[joint].add(mesh);return mesh;
  };
  add('hips','trouser-seat',[.43,.20,.29],[0,.01,0],palette.trousers);
  add('hips','leather-belt',[.46,.065,.31],[0,.10,0],palette.leather);
  add('hips','belt-buckle',[.075,.07,.025],[0,.10,.168],palette.bronze);
  add('hips','side-pouch',[.11,.14,.12],[.25,.005,-.01],palette.leather);
  for(const [index,name]of ['spine-1','spine-2','spine-3','spine-4','chest'].entries()){
    add(name,'tunic-panel-'+index,[.46+index*.02,.135,.31],[0,.04,0]);
    add(name,'tunic-front-'+index,[.07,.132,.018],[0,.04,.164],palette.linen);
  }
  add('chest','neck-scarf',[.32,.13,.30],[0,.15,0],palette.linen);
  add('neck-1','neck',[.11,.12,.11],[0,.035,0],skin,pool.round);
  add('neck-2','neck-upper',[.10,.11,.10],[0,.03,0],skin,pool.round);
  add('head','face',[.185,.21,.17],[0,.045,.015],skin,pool.head);
  add('head','hair-cap',[.19,.105,.17],[0,.18,-.005],hair,pool.head);
  add('head','hair-fringe',[.28,.075,.06],[.025,.13,.135],hair).rotation.z=-.1;
  add('head','nose',[.05,.07,.06],[0,.045,.178],skin);
  for(const side of ['left','right']){
    const direction=side==='left'?-1:1;
    add('head',side+'-eye',[.032,.026,.015],[direction*.075,.085,.174],palette.eye);
    add(side+'-clavicle',side+'-shoulder-cape',[.23,.13,.34],[direction*.15,.005,-.005]);
    add(side+'-shoulder',side+'-sleeve',[.115,.30,.115],[0,-.14,0],cloth,pool.round);
    add(side+'-elbow',side+'-forearm',[.082,.28,.085],[0,-.13,0],skin,pool.round);
    add(side+'-elbow',side+'-wrist-wrap',[.09,.095,.092],[0,-.235,0],palette.leather,pool.round);
    // One shared mesh per hand includes a palm, bent fingers and thumb.
    add(side+'-hand',side+'-hand',[1,1,1],[0,0,0],skin,pool.hands[side]);
    add(side+'-hip',side+'-trousers',[.12,.40,.13],[0,-.19,0],palette.trousers,pool.round);
    add(side+'-knee',side+'-boot-shaft',[.105,.31,.115],[0,-.20,0],palette.leather,pool.round);
    add(side+'-foot',side+'-boot',[.22,.14,.30],[0,-.06,.045],palette.leather);
    add(side+'-toe',side+'-boot-toe',[.21,.085,.135],[0,-.045,.04],palette.leather);
  }
  const swordModel=createSwordModel(),bowModel=createBowModel();
  const weapon=swordModel.root,bow=bowModel.root;
  const swordGrip=attachEquipment(skeleton.joints['right-hand'],weapon,swordModel.sockets.primaryGrip,ARENA_SWORD_PALM);
  const bowGrip=attachEquipment(skeleton.joints['left-hand'],bow,bowModel.sockets.primaryGrip,ARENA_BOW_PALM);
  weapon.visible=bow.visible=false;
  const armor:Record<'face'|'chest'|'legs'|'arms',THREE.Mesh[]>={face:[],chest:[],legs:[],arms:[]};
  const plate=(slot:keyof typeof armor,joint:string,name:string,size:[number,number,number],at:[number,number,number],material=palette.steel)=>{
    const mesh=add(joint,'armor-'+name,size,at,material);mesh.visible=false;armor[slot].push(mesh);return mesh;
  };
  plate('face','head','face-brow',[.36,.085,.35],[0,.18,.015]);
  plate('face','head','face-mask',[.30,.13,.035],[0,.025,.192]);
  plate('face','head','face-nose',[.055,.21,.045],[0,.075,.215]);
  for(const [index,joint]of ['spine-1','spine-2','spine-3','spine-4','chest'].entries()){
    plate('chest',joint,'chest-front-'+index,[.48+index*.02,.12,.035],[0,.04,.18]);
    plate('chest',joint,'chest-back-'+index,[.48+index*.02,.12,.035],[0,.04,-.18]);
  }
  for(const side of ['left','right']){
    const direction=side==='left'?-1:1;
    plate('face','head',side+'-cheek',[.04,.19,.20],[direction*.17,.015,.08]);
    plate('arms',side+'-shoulder',side+'-pauldron',[.27,.17,.27],[0,-.015,0]);
    plate('arms',side+'-elbow',side+'-bracer',[.19,.18,.19],[0,-.18,0]);
    plate('legs',side+'-hip',side+'-thigh',[.23,.29,.035],[0,-.21,.125]);
    plate('legs',side+'-knee',side+'-kneecap',[.23,.13,.06],[0,-.035,.13]);
    plate('legs',side+'-knee',side+'-shin',[.21,.22,.035],[0,-.22,.125]);
  }
  const bandage=add('right-hand','bandage-roll',[.075,.085,.075],[0,-.07,.07],palette.linen,pool.round);bandage.visible=false;
  const unregisterBandage=registerEquipmentOrientation(bandage,{id:'bandage-roll',weight:'medium',motionInfluence:.15,grip:'center',
    points:[{id:'center',tags:['held-roll'],position:{x:0,y:0,z:0}},
      {id:'end',tags:['roll-end'],position:{x:0,y:.5,z:0}},
      {id:'surface',tags:['wrapping-surface'],position:{x:0,y:0,z:1}}],
    directions:[{id:'roll-axis',tags:['roll-axis'],from:'center',to:'end'},
      {id:'wrap-facing',tags:['wrapping-surface'],from:'center',to:'surface'}]});
  return {weapon,bow,armor,bandage,cloth,swordModel,bowModel,swordGrip,bowGrip,
    dispose:()=>{unregisterBandage();swordModel.dispose();bowModel.dispose();cloth.dispose();releaseResources(pool);}};
}

export interface ArenaActorOptions {
  weapon?:boolean;equipped?:number;armorFace?:boolean;armorChest?:boolean;armorLegs?:boolean;armorArms?:boolean;
  bandageMs?:number;aimPitch?:number;local?:boolean;terrain?:TerrainWorldSnapshot;
}

/** createModStarter's editable controller with an authored body and public
 * afterApply hook. No model-specific motion matcher or physics implementation. */
export function createArenaActor(color:THREE.ColorRepresentation) {
  let body!:ReturnType<typeof survivorBody>,feet!:CreatureFootPlacement,equipment!:ArenaEquipmentPose;
  let support:CreatureFootPlacementResult|undefined,options:ArenaActorOptions={};
  const swordTimeline=new ActorActionTimeline();
  let swordTiming:{id:number;startedAtMs:number;durationMs:number;phase:number}|undefined;
  let previousSwordFrame:{timeMs:number;posture:string|undefined}|undefined;
  const bowReleaseTimeline=new ActorActionTimeline();
  let bowDrawTiming:{startedAtMs:number;durationMs:number;phase:number;observedMs:number}|undefined;
  let bowReleaseTiming:{id:number;startedAtMs:number;durationMs:number;phase:number;drawPhase?:number}|undefined;
  let previousBowFrame:{id:string;epoch:ActorPresentationSignals['epoch'];timeMs:number;posture:string|undefined}|undefined;
  const actor=createActor('#'+new THREE.Color(color).getHexString(),{
    clips:{attack:ARENA_STRIKE,'bow-aim':ARENA_BOW_AIM,'sword-carry':ARENA_SWORD_CARRY,bandage:ARENA_BANDAGE},layers:createArenaEquipmentLayers(),
    buildBody(skeleton,tint){
      body=survivorBody(skeleton,tint);
      equipment=new ArenaEquipmentPose(skeleton,body.bowModel,body.swordModel);
      feet=new CreatureFootPlacement(skeleton,{rigId:skeleton.root.name,contactSource:'authored-required',warnings:[],
        legs:['left','right'].map(side=>({id:side+'-foot',upper:side+'-hip',lower:side+'-knee',end:side+'-foot',
          contactOffset:{x:0,y:-.13,z:.055}}))});
      return body.dispose;
    },
    onReset(){feet.reset();equipment.reset();support=undefined;},
    afterApply(result,context){
      const {signals}=context;
      if(signals.posture==='dead'||signals.posture==='downed'){feet.reset();equipment.reset();support=undefined;return;}
      const positions=feet.positions();
      const supports=options.terrain?.footSupports(positions,signals.timeMs)??{};
      support=feet.apply({timeMs:signals.timeMs,epoch:signals.epoch,reset:context.reset,
        frame:{up:signals.up??{x:0,y:1,z:0},forward:signals.facing??{x:0,y:0,z:1}},
        supports,contacts:result.contacts,grounded:signals.grounded,maxAdjustment:.24});
      equipment.apply(context,actor.root);
    },
  });
  actor.root.name='arena-survivor';
  return {root:actor.root,joints:actor.joints,weapon:body.weapon,sword:body.weapon,bow:body.bow,armor:body.armor,animation:actor.animation,
    update(signals:Readonly<ActorPresentationSignals>,next:ArenaActorOptions={}){
      options=next;
      const parameters={...signals.parameters};
      for(const key of ['equipped','armorFace','armorChest','armorLegs','armorArms','bandageMs','aimPitch'] as const)
        if(next[key]!==undefined)parameters[key]=next[key]!;
      const equipped=Number(parameters.equipped??(next.weapon??Boolean(parameters.weapon)?1:0));
      parameters.equipped=equipped;
      const healing=Number(parameters.bandageMs??0)>0&&signals.posture!=='dead';
      // Network countdowns repeat between game ticks. Stabilize the supplied
      // instance start once, then advance only its presentation at render time.
      // This IK action does not manufacture an AnimationPlayer clip or change hits.
      if(previousSwordFrame&&(signals.timeMs-previousSwordFrame.timeMs>1000||previousSwordFrame.posture!==signals.posture))swordTimeline.reset();
      previousSwordFrame={timeMs:signals.timeMs,posture:signals.posture};
      delete parameters.swordAttackPhase;
      const duration=Number(parameters.attackDurationMs??0),remaining=Number(parameters.attackRemainingMs??0),attackId=Number(parameters.attackId);
      const swordAttack=equipped===1&&Number(parameters.attackWeapon)===1&&remaining>0&&duration>0&&Number.isFinite(duration)
        &&Number.isFinite(remaining)&&Number.isSafeInteger(attackId)&&attackId>=0&&!healing&&parameters.active!==false
        &&signals.posture!=='dead'&&signals.posture!=='downed';
      if(swordAttack){
        const action=swordTimeline.sample({...signals,actions:[{id:`sword:${attackId}`,clip:'attack',
          startedAtMs:signals.timeMs-Math.max(0,duration-remaining)}]})[0];
        const phase=Math.max(0,Math.min(1,(signals.timeMs-action.startedAtMs)/duration));
        parameters.swordAttackPhase=phase;
        swordTiming={id:attackId,startedAtMs:action.startedAtMs,durationMs:duration,phase};
      }else{
        swordTimeline.reset();swordTiming=undefined;
      }
      // A live draw has an increasing authoritative timer; a shot has the same
      // stable gameplay attack ID used by sword presentation. Only interpolate
      // these observed phases, never create an action, projectile or extra hit.
      if(previousBowFrame&&(previousBowFrame.id!==signals.id||previousBowFrame.epoch!==signals.epoch
        ||signals.timeMs<previousBowFrame.timeMs||signals.timeMs-previousBowFrame.timeMs>1000
        ||previousBowFrame.posture!==signals.posture)){
        bowDrawTiming=undefined;bowReleaseTiming=undefined;bowReleaseTimeline.reset();
      }
      previousBowFrame={id:signals.id,epoch:signals.epoch,timeMs:signals.timeMs,posture:signals.posture};
      delete parameters.bowDrawPhase;delete parameters.bowReleasePhase;delete parameters.bowReleaseDrawPhase;
      const bowActive=equipped===2&&!healing&&parameters.active!==false&&signals.posture!=='dead'&&signals.posture!=='downed';
      const hasAttackId=Number.isSafeInteger(attackId)&&attackId>=0;
      const drawDuration=Number(parameters.bowDrawDurationMs??800),drawMs=Number(parameters.bowDrawMs??0);
      const releaseDuration=Number(parameters.bowReleaseMs??parameters.attackDurationMs??260);
      const bowRelease=bowActive&&hasAttackId&&Number(parameters.attackWeapon)===2&&remaining>0&&Number.isFinite(remaining)
        &&releaseDuration>0&&Number.isFinite(releaseDuration);
      if(bowActive&&hasAttackId&&!bowRelease&&drawMs>0&&Number.isFinite(drawMs)&&drawDuration>0&&Number.isFinite(drawDuration)){
        // A decreasing positive timer means a cancel/new press happened between
        // observed frames. Preserve exact raw poses for legacy custom adapters
        // without an authoritative attack counter.
        if(!bowDrawTiming||drawMs<bowDrawTiming.observedMs-1e-6||drawDuration!==bowDrawTiming.durationMs)
          bowDrawTiming={startedAtMs:signals.timeMs-drawMs,durationMs:drawDuration,phase:0,observedMs:drawMs};
        bowDrawTiming.phase=Math.max(0,Math.min(1,(signals.timeMs-bowDrawTiming.startedAtMs)/drawDuration));
        bowDrawTiming.observedMs=drawMs;parameters.bowDrawPhase=bowDrawTiming.phase;
      }else bowDrawTiming=undefined;
      if(bowRelease){
        const action=bowReleaseTimeline.sample({...signals,actions:[{id:`bow:${attackId}`,clip:'attack',
          startedAtMs:signals.timeMs-Math.max(0,releaseDuration-remaining)}]})[0];
        const phase=Math.max(0,Math.min(1,(signals.timeMs-action.startedAtMs)/releaseDuration));
        const shotDrawMs=Number(parameters.bowShotDrawMs),drawPhase=shotDrawMs>0&&Number.isFinite(shotDrawMs)
          &&drawDuration>0&&Number.isFinite(drawDuration)?Math.max(0,Math.min(1,shotDrawMs/drawDuration)):undefined;
        parameters.bowReleasePhase=phase;
        if(drawPhase!==undefined)parameters.bowReleaseDrawPhase=drawPhase;
        bowReleaseTiming={id:attackId,startedAtMs:action.startedAtMs,durationMs:releaseDuration,phase,
          ...(drawPhase===undefined?{}:{drawPhase})};
      }else{bowReleaseTimeline.reset();bowReleaseTiming=undefined;}
      body.weapon.visible=equipped===1&&!healing;body.bow.visible=equipped===2&&!healing;body.bandage.visible=healing;
      for(const [slot,key]of [['face','armorFace'],['chest','armorChest'],['legs','armorLegs'],['arms','armorArms']] as const)
        for(const mesh of body.armor[slot])mesh.visible=Boolean(parameters[key]);
      body.cloth.emissive.setHex(next.local?0x103830:0);body.cloth.emissiveIntensity=next.local?.18:0;
      actor.update({...signals,parameters});
    },
    inspection(){return {...actor.inspection(),starter:'player-appearance:humanoid',height:ARENA_ACTOR_HEIGHT,
      weaponRig:{...equipment.inspection(),swordTiming:swordTiming?{...swordTiming}:null,
        bowTiming:{draw:bowDrawTiming?{...bowDrawTiming}:null,release:bowReleaseTiming?{...bowReleaseTiming}:null},
        grips:{sword:body.swordGrip.inspection(),bow:body.bowGrip.inspection()}},
      equipment:{sword:body.weapon.visible,bow:body.bow.visible,bandaging:body.bandage.visible,
        armor:Object.fromEntries(Object.entries(body.armor).map(([slot,meshes])=>[slot,meshes.some(mesh=>mesh.visible)]))},
      terrain:{source:options.terrain?'accepted-terrain-manifest':'unavailable',revision:options.terrain?.revision,
        feet:support?.legs.map(leg=>({id:leg.id,support:leg.support,planted:leg.planted,error:leg.error,
          reachable:leg.reachable,warnings:leg.warnings}))??[]}};},
    dispose:actor.dispose,
  };
}
