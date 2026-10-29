import {Group,type Scene} from 'three';
import {MapAssemblyView} from '../sandbox/mapAssemblyView.ts';
import {mapAssemblyInspection} from '../sandbox/mapAssembly.ts';
import {LightingRig} from '../sandbox/lighting.ts';
import {MAP_ASSEMBLY,MAP_LANTERNS} from './mapArchitecture.ts';
import {MAP_NAME,SITES} from './mapLayout.ts';

/** All architectural triangles, signs and collision originate in the same
 * compiled engine manifest. This view only supplies the shared light budget. */
export function createMapVisuals(scene:Scene){
 const view=new MapAssemblyView(MAP_ASSEMBLY),root=new Group();
 root.name=MAP_NAME;root.add(view.root);scene.add(root);
 const rig=new LightingRig(root,{maxShadowLights:1,shadowMapSize:512});
 for(const id of MAP_LANTERNS){
  const lamp=MAP_ASSEMBLY.parts.find(part=>part.id===id+'-base');
  if(!lamp)throw new Error('Missing compiled lantern '+id);
  const x=(lamp.bounds.min.x+lamp.bounds.max.x)/2,z=(lamp.bounds.min.z+lamp.bounds.max.z)/2,y=lamp.bounds.min.y-.035;
  rig.addSpot({id,position:[x,y,z],target:[x,0,z],color:0xffdfa5,intensity:id==='garage-ceiling-lantern'?32:14,
   range:9,angle:.88,penumbra:.8,castShadow:id==='garage-ceiling-lantern'});
 }
 let disposed=false;
 return{root,ready:()=>view.readyMaterials(),update:(focus:{x:number;y:number;z:number})=>rig.update(focus),
  inspection:()=>({name:MAP_NAME,sites:SITES.length,assembly:mapAssemblyInspection(MAP_ASSEMBLY),rendering:view.inspection(),inspectionViews:MAP_ASSEMBLY.views.map(v=>v.id)}),
  dispose(){if(disposed)return;disposed=true;rig.dispose();view.dispose();root.removeFromParent();},
 };
}

