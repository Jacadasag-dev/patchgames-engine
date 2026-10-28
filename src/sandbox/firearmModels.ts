import {BoxGeometry,CylinderGeometry,Group,Mesh,MeshStandardMaterial,TorusGeometry,Vector3} from 'three';
import {sampleFirearmReload,FIREARM_LENGTHS,type FirearmModelKind,type FirearmReloadStyle} from './firearms.ts';
import type {FirearmSockets} from './firearmPose.ts';
import {registerEquipmentOrientation} from './equipmentOrientation.ts';

export type {FirearmModelKind} from './firearms.ts';
/** Editable procedural silhouettes. Geometry/materials are allocated per held
 * weapon, never per frame; all mechanism motion uses shared reload phases. */
export function createFirearmModel(kind:FirearmModelKind,color=0x47565e){
  const root=new Group();root.name=kind;
  const box=new BoxGeometry(1,1,1),tube=new CylinderGeometry(1,1,1,12),ring=new TorusGeometry(.033,.006,6,12);
  const steel=new MeshStandardMaterial({color:0x26313a,metalness:.82,roughness:.3});
  const body=new MeshStandardMaterial({color,metalness:.55,roughness:.4});
  const grip=new MeshStandardMaterial({color:0x151e25,metalness:.12,roughness:.9});
  const brass=new MeshStandardMaterial({color:0xc39943,metalness:.72,roughness:.28});
  const glass=new MeshStandardMaterial({color:0x28597b,metalness:.7,roughness:.12});
  const pistol=['glock','revolver','short-shotgun'].includes(kind),sniper=kind.startsWith('sniper'),shotgun=kind.includes('shotgun');
  const length=FIREARM_LENGTHS[kind];
  function part(size:number[],at:number[],material=body,parent=root){const mesh=new Mesh(box,material);mesh.scale.set(size[0],size[1],size[2]);mesh.position.set(at[0],at[1],at[2]);mesh.castShadow=mesh.receiveShadow=true;parent.add(mesh);return mesh;}
  function cylinder(radius:number,length:number,at:number[],material=steel,parent=root){const mesh=new Mesh(tube,material);mesh.scale.set(radius,length,radius);mesh.rotation.x=Math.PI/2;mesh.position.set(at[0],at[1],at[2]);mesh.castShadow=true;parent.add(mesh);return mesh;}
  part([pistol?.075:.095,pistol?.08:.1,pistol?.16:.3],[0,.025,pistol?.075:.16]);
  part([.065,.145,.07],[0,-.085,.015],grip);
  const barrelStart=pistol?.13:.29;if(kind!=='short-shotgun')cylinder(shotgun?.027:kind==='sniper-heavy'?.025:.018,length-barrelStart,[0,.043,(length+barrelStart)/2]);
  const slide=new Group();root.add(slide);
  if(kind==='glock')part([.078,.045,.22],[0,.077,.09],steel,slide);
  const magazine=new Group();root.add(magazine);part([kind==='lmg'?.14:.054,pistol?.085:kind==='lmg'?.17:.2,pistol?.055:.09],[0,pistol?-.14:-.1,pistol?.02:.15],grip,magazine);
  if(!pistol){part([.065,.085,.2],[0,.01,-.13],grip);part([.075,.15,.045],[0,-.025,-.235],grip);part([.08,.07,.23],[0,.015,.34],grip);}
  const cylinderGroup=new Group();root.add(cylinderGroup);
  if(kind==='revolver'){cylinder(.057,.09,[0,.026,.065],steel,cylinderGroup);for(let i=0;i<6;i++)cylinder(.009,.095,[Math.cos(i*Math.PI/3)*.038,.026+Math.sin(i*Math.PI/3)*.038,.065],brass,cylinderGroup);}
  if(kind==='short-shotgun'){cylinder(.026,.25,[-.03,.04,.16]);cylinder(.026,.25,[.03,.04,.16]);}
  const pump=new Group();root.add(pump);
  if(shotgun&&!pistol){cylinder(.025,.46,[0,-.017,.46]);part([.09,.07,.19],[0,-.01,.44],grip,pump);}
  if(sniper){cylinder(.038,.26,[0,.16,.2]);cylinder(.045,.01,[0,.16,.335],glass);part([.045,.08,.09],[0,.1,.2],steel);}
  else if(!pistol){const sight=new Mesh(ring,steel);sight.position.set(0,.12,.32);root.add(sight);}
  if(kind==='rifle-fast')part([.055,.06,.12],[0,.075,.49],body);
  if(kind==='rifle-heavy')part([.07,.035,.25],[0,.083,.36],body);
  if(kind==='smg')part([.1,.065,.16],[0,.07,.25],body);
  if(kind==='lmg'){for(let i=0;i<6;i++)cylinder(.011,.05,[.07+i*.016,-.01,.16],brass);part([.16,.055,.15],[.02,.093,.16],steel);}
  const bolt=new Group();root.add(bolt);part([.04,.025,.045],[.061,.055,.1],steel,bolt);
  const lid=new Group();lid.position.set(0,.09,.1);root.add(lid);if(kind==='lmg')part([.1,.018,.23],[0,0,.07],steel,lid);
  const sockets:FirearmSockets={trigger:{position:{x:0,y:-.055,z:.015}},support:{position:{x:0,y:pistol?-.09:0,z:pistol?.07:shotgun?.44:.34}},muzzle:{position:{x:0,y:.043,z:length}},reload:{position:{x:0,y:0,z:.1}}};
  const unregister=registerEquipmentOrientation(root,{id:kind,weight:kind==='lmg'||kind==='sniper-heavy'?'heavy':'medium',motionInfluence:0,grip:'grip',points:[{id:'grip',tags:['grip'],position:sockets.trigger.position!},{id:'breech',tags:['breech'],position:{x:0,y:.043,z:0}},{id:'muzzle',tags:['muzzle'],position:sockets.muzzle.position!},{id:'top',tags:['top'],position:{x:0,y:.17,z:0}}],directions:[{id:'bore',tags:['aim'],from:'breech',to:'muzzle'},{id:'up',tags:['surface'],from:'breech',to:'top'}]});
  return {root,sockets,kind,animate(progress:number,style:FirearmReloadStyle,cycle=0){const m=sampleFirearmReload(progress,style);magazine.position.y=-m.magazine*.25;magazine.rotation.x=m.magazine*.12;slide.position.z=-Math.max(m.bolt,cycle*.025);bolt.position.z=-Math.max(m.bolt,cycle*.03);cylinderGroup.position.x=m.cylinder*.09;cylinderGroup.rotation.z=m.cylinder*.35;pump.position.z=-Math.max(Math.abs(m.shell)*.035,cycle*.12);lid.rotation.x=-m.lid*.9;
      const mechanism=style==='revolver'?cylinderGroup.children[0]:style==='bolt'?bolt.children[0]:style==='belt'?lid.children[0]:style==='shell'?undefined:magazine.children[0];
      if(mechanism){root.updateWorldMatrix(true,true);const point=root.worldToLocal(mechanism.getWorldPosition(new Vector3()));sockets.reload!.position={x:point.x,y:point.y,z:point.z};}
      else sockets.reload!.position={x:.04,y:-.025,z:pistol?.1:.19};},
    dispose(){unregister();root.removeFromParent();for(const g of [box,tube,ring])g.dispose();for(const m of [steel,body,grip,brass,glass])m.dispose();}};
}
