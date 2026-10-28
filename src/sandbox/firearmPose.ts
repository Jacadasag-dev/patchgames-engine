import {Object3D,Quaternion,Vector3} from 'three';
import {attachEquipment,HumanoidHandPlacement,socketWorld,type SocketFrame} from './equipmentView.ts';
import type {createHumanoidSkeleton} from './animationView.ts';
import {sampleFirearmReload,type FirearmReloadStyle} from './firearms.ts';

export interface FirearmSockets {trigger:SocketFrame;support:SocketFrame;muzzle:SocketFrame;reload?:SocketFrame}
/** Two-handed aiming from actual model sockets. Existing humanoid-v1 labels use
 * +X for the named right chain, while +Z forward has screen-right at -X. Select
 * by the rest shoulder positions so handedness means anatomical/display side,
 * without breaking old rigs, animations, or joint names. */
export class HumanoidFirearmPose {
  readonly primaryHand:'left'|'right';
  readonly supportHand:'left'|'right';
  readonly handedness:'left'|'right';
  private readonly hands:HumanoidHandPlacement;
  private readonly attachment:ReturnType<typeof attachEquipment>;
  private readonly rig:ReturnType<typeof createHumanoidSkeleton>;
  private readonly model:Object3D;
  private readonly sockets:FirearmSockets;
  private readonly stanceYaw:number;
  private readonly spineBase=new Quaternion();
  private spineApplied:Quaternion|undefined;
  private readonly neckBase=new Quaternion();
  private neckApplied:Quaternion|undefined;
  private last={hands:[],warnings:[]} as ReturnType<HumanoidHandPlacement['inspection']>;
  constructor(rig:ReturnType<typeof createHumanoidSkeleton>,model:Object3D,sockets:FirearmSockets,options:{handedness?:'right'|'left';stanceYaw?:number}={}){
    this.rig=rig;this.model=model;this.sockets=sockets;this.hands=new HumanoidHandPlacement(rig);
    this.handedness=options.handedness??'right';
    this.stanceYaw=options.stanceYaw??(this.handedness==='right'?-.9:.9);
    rig.root.updateWorldMatrix(true,true);
    const inverse=rig.root.matrixWorld.clone().invert();
    const left=rig.joints['left-shoulder'].getWorldPosition(new Vector3()).applyMatrix4(inverse).x;
    const right=rig.joints['right-shoulder'].getWorldPosition(new Vector3()).applyMatrix4(inverse).x;
    const screenRight=left<right?'left':'right';this.primaryHand=options.handedness==='left'?(screenRight==='left'?'right':'left'):screenRight;
    this.supportHand=this.primaryHand==='left'?'right':'left';
    this.attachment=attachEquipment(rig.joints[`${this.primaryHand}-hand`],model,sockets.trigger,{position:{x:0,y:-.055,z:0}});
  }
  apply(options:{pitch?:number;recoil?:number;reload?:number;reloadProgress?:number;reloadStyle?:FirearmReloadStyle}={}):void{
    const {rig}=this;
    const spine=rig.joints['spine-2'];
    if(this.spineApplied&&spine.quaternion.angleTo(this.spineApplied)<1e-8)spine.quaternion.copy(this.spineBase);
    this.spineBase.copy(spine.quaternion);
    spine.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(0,1,0),this.stanceYaw));
    this.spineApplied=spine.quaternion.clone();
    const neck=rig.joints['neck-1'];
    if(this.neckApplied&&neck.quaternion.angleTo(this.neckApplied)<1e-8)neck.quaternion.copy(this.neckBase);
    this.neckBase.copy(neck.quaternion);neck.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(0,1,0),-this.stanceYaw))
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(1,0,0),-(options.pitch??0)*.65));this.neckApplied=neck.quaternion.clone();
    rig.root.updateWorldMatrix(true,true);
    const sign=this.primaryHand==='left'?-1:1,reload=options.reloadProgress===undefined?Math.max(0,Math.min(1,options.reload??0)):Math.sin(Math.PI*Math.max(0,Math.min(1,options.reloadProgress)));
    const reloadMotion=sampleFirearmReload(options.reloadProgress??0,options.reloadStyle??'magazine');
    const supportSocket=this.sockets.reload?{...this.sockets.support,position:{x:(this.sockets.support.position?.x??0)*(1-reloadMotion.contact)+(this.sockets.reload.position?.x??0)*reloadMotion.contact,y:(this.sockets.support.position?.y??0)*(1-reloadMotion.contact)+(this.sockets.reload.position?.y??0)*reloadMotion.contact,z:(this.sockets.support.position?.z??0)*(1-reloadMotion.contact)+(this.sockets.reload.position?.z??0)*reloadMotion.contact}}:this.sockets.support;
    const orientation=rig.root.getWorldQuaternion(new Quaternion()).multiply(new Quaternion().setFromAxisAngle(new Vector3(1,0,0),-(options.pitch??0)+reloadMotion.pitch)).multiply(new Quaternion().setFromAxisAngle(new Vector3(0,0,1),reloadMotion.roll));
    // The trigger sits on the dominant shoulder side, the other palm follows
    // the actual foregrip. No arbitrary independent hand offsets or gun turns.
    const target=rig.root.localToWorld(new Vector3(sign*.24,1.43-.17*reload,.31-Math.min(.07,options.recoil??0)));
    const pole=rig.root.localToWorld(new Vector3(sign*.62,1.12,.18));
    const primaryNode=rig.joints[`${this.primaryHand}-hand`];
    const turn=orientation.clone().multiply(primaryNode.getWorldQuaternion(new Quaternion()).invert());
    const delta=socketWorld(this.model,supportSocket).position.sub(socketWorld(this.model,this.sockets.trigger).position).applyQuaternion(turn);
    if(!this.sockets.reload)delta.add(new Vector3(reloadMotion.hand.x,reloadMotion.hand.y,reloadMotion.hand.z).applyQuaternion(orientation));
    const reach=(hand:'left'|'right')=>rig.joints[`${hand}-shoulder`].getWorldPosition(new Vector3()).distanceTo(rig.joints[`${hand}-elbow`].getWorldPosition(new Vector3()))
      +rig.joints[`${hand}-elbow`].getWorldPosition(new Vector3()).distanceTo(rig.joints[`${hand}-hand`].getWorldPosition(new Vector3()));
    const centers=[rig.joints[`${this.primaryHand}-shoulder`].getWorldPosition(new Vector3()),rig.joints[`${this.supportHand}-shoulder`].getWorldPosition(new Vector3()).sub(delta)];
    const radii=[reach(this.primaryHand)*.93,reach(this.supportHand)*.93];
    // Fit the rigid two-grip assembly to both arms before solving either arm.
    // This prevents a long foregrip from pulling the support arm into a T-pose.
    for(let pass=0;pass<12;pass++)for(let i=0;i<2;i++){const offset=target.clone().sub(centers[i]),distance=offset.length();if(distance>radii[i])target.copy(centers[i]).addScaledVector(offset,radii[i]/distance);}
    const primary=this.hands.apply({[this.primaryHand]:{position:target,rotation:orientation,pole,socket:{position:{x:0,y:-.055,z:0}}}});
    const support=socketWorld(this.model,supportSocket),otherPole=rig.root.localToWorld(new Vector3(-sign*.58,1.04,.3));
    if(!this.sockets.reload)support.position.add(new Vector3(reloadMotion.hand.x,reloadMotion.hand.y,reloadMotion.hand.z).applyQuaternion(orientation));
    this.last=this.hands.apply({[this.supportHand]:{position:support.position,rotation:support.rotation,pole:otherPole,socket:{position:{x:0,y:-.055,z:0}}}});
    this.last={hands:[...primary.hands,...this.last.hands],warnings:[...primary.warnings,...this.last.warnings]};
  }
  muzzle(){return socketWorld(this.model,this.sockets.muzzle);}
  inspection(){const muzzle=this.muzzle().position;return {handedness:this.handedness,primaryJoint:`${this.primaryHand}-hand`,supportJoint:`${this.supportHand}-hand`,attachment:this.attachment.inspection(),support:this.last,muzzle:{x:muzzle.x,y:muzzle.y,z:muzzle.z}};}
  dispose(){this.attachment.detach();}
}
