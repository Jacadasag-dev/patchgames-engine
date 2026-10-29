import {voxelUi} from './ui.ts';
import * as THREE from 'three';
import type {CreateView,ReviewCamera,InspectionFocus} from '../shared/gameApi.ts';
import {VoxelWorldView} from './world/voxelView.ts';
import {InspectionFocusController} from '../sandbox/inspectionFocus.ts';
import {recordInspectionGameplayCamera,isInspectionCameraFrameActive} from '../sandbox/inspectionCamera.ts';
import {configureShadowRenderer} from '../sandbox/lighting.ts';
import {playSound} from '../sandbox/audio.ts';
import {registerEquipmentOrientation} from '../sandbox/equipmentOrientation.ts';
import {world,terrainWorld} from './world.ts';
import type {World,Player,Tuning} from './shapes.ts';
import {hash} from './generation.ts';
const colors=[0,0x77a949,0x8b623f,0x929394,0x80603b,0x487f37,0x494c4d,0xab8d77,0xd9cb92,0x427eae,0xb38b50];
const create:CreateView<World,Player,Tuning>=canvas=>{
 const renderer=new THREE.WebGLRenderer({canvas,antialias:true});configureShadowRenderer(renderer);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;
 const scene=new THREE.Scene();scene.background=new THREE.Color(0xa8d5ec);scene.fog=new THREE.Fog(0xa8d5ec,24,58);
 const camera=new THREE.PerspectiveCamera(75,1,.045,250),review=new THREE.PerspectiveCamera(60,1,.05,500),focus=new InspectionFocusController();let reviewPose:ReviewCamera|null=null;
 const ambient=new THREE.HemisphereLight(0xcbe5ff,0x866949,2),sun=new THREE.DirectionalLight(0xffe6b2,3.2);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);sun.shadow.camera.left=sun.shadow.camera.bottom=-40;sun.shadow.camera.right=sun.shadow.camera.top=40;sun.shadow.camera.near=.1;sun.shadow.camera.far=110;sun.shadow.normalBias=.04;scene.add(ambient,sun,sun.target);
 const textures:THREE.DataTexture[]=[];
 const materials=colors.map((color,id)=>{
  const c=new THREE.Color(color).convertLinearToSRGB(),pixels=new Uint8Array(16*16*4);
  for(let y=0;y<16;y++)for(let x=0;x<16;x++){let v=.83+hash(x,y,id+19)*.28;
   if(id===4)v*=x%4===0?.68:1;if(id===10)v*=y%5===0?.65:1;
   if(id===6&&hash(x,y,44)>.78)v=.3;if(id===7&&hash(x,y,9)>.8)v=1.3;
   const p=(y*16+x)*4;pixels[p]=Math.min(255,c.r*255*v);pixels[p+1]=Math.min(255,c.g*255*v);pixels[p+2]=Math.min(255,c.b*255*v);pixels[p+3]=255;}
  const map=new THREE.DataTexture(pixels,16,16);map.colorSpace=THREE.SRGBColorSpace;map.magFilter=THREE.NearestFilter;map.minFilter=THREE.NearestMipmapLinearFilter;map.wrapS=map.wrapT=THREE.RepeatWrapping;map.generateMipmaps=true;map.needsUpdate=true;textures.push(map);
  return new THREE.MeshStandardMaterial({map,roughness:1,transparent:id===9,opacity:id===9?.64:1,depthWrite:id!==9});
 });
 const terrainView=new VoxelWorldView(materials,49);scene.add(terrainView.root);
 const unit=new THREE.BoxGeometry(1,1,1),cloudMaterial=new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:.86});
 const clouds=new THREE.Group();for(let i=0;i<22;i++){const cloud=new THREE.Mesh(unit,cloudMaterial);cloud.scale.set(8+hash(i,2,3)*10,1.2,4+hash(i,3,5)*5);cloud.position.set(hash(i,1,5)*190-95,27+hash(i,4,9)*10,hash(i,7,5)*190-95);clouds.add(cloud);}scene.add(clouds);
 const border=new THREE.LineSegments(new THREE.EdgesGeometry(unit),new THREE.LineBasicMaterial({color:0xffefbe}));border.scale.setScalar(1.008);scene.add(border);
 const bodyMaterials=[0xe4b28b,0x3c8293,0x374967,0x342e2a].map(color=>new THREE.MeshStandardMaterial({color,roughness:1}));
 const actors=new Map<string,{root:THREE.Group;head:THREE.Mesh;arms:THREE.Group[];legs:THREE.Mesh[];tool:THREE.Group;action:number}>();
 function box(parent:THREE.Object3D,w:number,h:number,d:number,x:number,y:number,z:number,material:THREE.Material){const m=new THREE.Mesh(unit,material);m.scale.set(w,h,d);m.position.set(x,y,z);m.castShadow=m.receiveShadow=true;parent.add(m);return m;}
 function avatar(id:string){const root=new THREE.Group(),head=box(root,.48,.48,.48,0,1.52,0,bodyMaterials[0]);box(root,.5,.68,.28,0,.95,0,bodyMaterials[1]);box(head,.85,.18,1.01,0,.4,0,bodyMaterials[3]);
  const arms=[-1,1].map(side=>{const a=new THREE.Group();a.position.set(side*.36,1.25,0);box(a,.22,.65,.25,0,-.28,0,bodyMaterials[0]);root.add(a);return a;});
  const legs=[-1,1].map(side=>box(root,.23,.6,.26,side*.13,.3,0,bodyMaterials[2]));
  const tool=new THREE.Group();tool.position.set(0,-.55,.18);box(tool,.07,.55,.07,0,.15,0,materials[4]);box(tool,.5,.12,.09,0,.43,0,materials[3]);arms[0].add(tool);
  registerEquipmentOrientation(tool,{id:'pickaxe',weight:'medium',grip:'grip',points:[{id:'grip',tags:['grip'],position:{x:0,y:0,z:0}},{id:'head',tags:['mining-head'],position:{x:0,y:.43,z:0}},{id:'tip',tags:['mining-tip'],position:{x:.25,y:.43,z:0}}],directions:[{id:'handle',tags:['handle-axis'],from:'grip',to:'head'},{id:'edge',tags:['cutting-axis'],from:'head',to:'tip'}]});
  scene.add(root);const a={root,head,arms,legs,tool,action:0};actors.set(id,a);return a;
 }
 const hand=new THREE.Group();hand.position.set(.38,-.34,-.62);box(hand,.15,.3,.17,0,-.08,0,bodyMaterials[0]);
 const heldTool=new THREE.Group();box(heldTool,.055,.48,.055,0,.16,0,materials[4]);box(heldTool,.42,.1,.075,0,.38,0,materials[3]);hand.add(heldTool);camera.add(hand);scene.add(camera);
 let width=960,height=540;
 return{terrainWorld,ui:voxelUi,resize(w,h,dpr){width=w;height=h;renderer.setPixelRatio(Math.min(2,dpr));renderer.setSize(w,h,false);camera.aspect=review.aspect=w/h;camera.updateProjectionMatrix();review.updateProjectionMatrix();},
 setReviewCamera(p){reviewPose=p;},setInspectionFocus(p:InspectionFocus|null){focus.setFocus(p);},inspectionFocus:()=>focus.inspection(),info:()=>({width,height}),
 update(frame){const local=frame.players.find(p=>p.isLocal&&p.active!==false),s=local?.state,t=frame.tuning,f=world.field(t);if(frame.world)f.setEdits(frame.world.edits);
  const snapshot=terrainWorld.read(t);if(frame.world?.terrainRevision)snapshot.assertRevision(frame.world.terrainRevision);
  const cx=Math.floor((s?.x??0)/32),cz=Math.floor((s?.z??0)/32),coords:{x:number;z:number}[]=[];
  for(let dx=-1;dx<=1;dx++)for(let dz=-1;dz<=1;dz++)if(Math.abs((cx+dx)*32+16)<129&&Math.abs((cz+dz)*32+16)<129)coords.push({x:cx+dx,z:cz+dz});terrainView.update(f,coords);
  for(const [id,a] of actors)if(!frame.players.some(p=>p.id===id&&p.active!==false)){a.root.removeFromParent();actors.delete(id);}
  for(const p of frame.players){if(p.active===false)continue;const a=actors.get(p.id)??avatar(p.id),v=p.state,speed=Math.hypot(v.velocityX,v.velocityZ),walk=Math.sin(frame.now*.009)*Math.min(1,speed/5)*.5;a.root.visible=p.hp>0;a.root.position.set(v.x,v.y,v.z);a.root.rotation.y=v.facing;a.head.visible=!p.isLocal||!!reviewPose;a.arms[0].rotation.x=v.mineTime>0?-.7-Math.sin(frame.now*.024)*.5:walk;a.arms[1].rotation.x=-walk;a.legs[0].rotation.x=-walk;a.legs[1].rotation.x=walk;a.tool.visible=v.pickaxe>0;
   if(v.action!==a.action){if(v.actionKind<3){const kind=v.actionKind;playSound('block:'+p.id+':'+v.action,{kind:'sound',version:1,duration:.16,layers:[{id:'impact',source:{kind:'noise',color:'brown',seed:31+kind},gain:kind===1?.24:.14,fadeIn:.005,fadeOut:.12,lowpass:kind===1?1500:800}]},{position:[v.actionX,v.actionY,v.actionZ]});}a.action=v.action;}
  }
  const day=frame.now/240000*Math.PI*2,light=.8+Math.cos(day)*.2;sun.intensity=3.2*light;ambient.intensity=1.7*light;sun.position.set((s?.x??0)+30,45,(s?.z??0)+18);sun.target.position.set(s?.x??0,0,s?.z??0);
  clouds.position.x=Math.sin(frame.now/200000)*12;
  if(s){camera.position.set(s.x+Math.sin(s.facing)*.26,s.y+1.6,s.z+Math.cos(s.facing)*.26);camera.lookAt(camera.position.x+Math.sin(s.facing)*Math.cos(s.aimPitch),camera.position.y+Math.sin(s.aimPitch),camera.position.z+Math.cos(s.facing)*Math.cos(s.aimPitch));
   const hit=f.raycast({x:s.x+Math.sin(s.facing)*.26,y:s.y+1.6,z:s.z+Math.cos(s.facing)*.26},{x:Math.sin(s.facing)*Math.cos(s.aimPitch),y:Math.sin(s.aimPitch),z:Math.cos(s.facing)*Math.cos(s.aimPitch)},6);border.visible=!!hit;if(hit)border.position.set(hit.block.x+.5,hit.block.y+.5,hit.block.z+.5);
  }
  if(reviewPose){review.position.set(reviewPose.x,reviewPose.y,reviewPose.z);review.rotation.set(reviewPose.pitch,reviewPose.yaw,0,'YXZ');review.fov=reviewPose.fov;review.updateProjectionMatrix();}
  const showActors=(firstPerson:boolean)=>{for(const p of frame.players){const a=actors.get(p.id);if(a)a.root.visible=p.hp>0&&(!p.isLocal||!firstPerson);}hand.visible=firstPerson&&!!s;};
  if(s){heldTool.visible=s.pickaxe>0;hand.rotation.x=s.mineTime>0?-.35-Math.sin(frame.now*.024)*.3:0;}
  showActors(!reviewPose);
  if(isInspectionCameraFrameActive())recordInspectionGameplayCamera(scene,camera,true,local?.id);
  focus.render(renderer,scene,reviewPose?review:camera,frame.players.flatMap((p,index)=>{const a=actors.get(p.id);return a?[{id:'player:'+p.id,player:index,label:p.name,object:a.root}]:[];}),activeCamera=>showActors(activeCamera===camera&&!reviewPose));
 },inspection(){return{...terrainView.inspection(),camera:'first-person',nativeCollision:true};},
 dispose(){terrainView.dispose();unit.dispose();textures.forEach(t=>t.dispose());materials.forEach(m=>m.dispose());bodyMaterials.forEach(m=>m.dispose());cloudMaterial.dispose();border.geometry.dispose();(border.material as THREE.Material).dispose();renderer.dispose();}};
};export default create;

