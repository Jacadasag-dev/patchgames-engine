import type {ResolvedMaterialGenerator} from './materialGenerator.ts';
import {parseMaterialGeneratorData} from './materialGeneratorData.ts';
/** Optical recipes, not stored pixel assets. Reflection environment is scene-owned. */
export const MATERIAL_OPTICAL_PRESETS:ReadonlyArray<{id:string;recipe:ResolvedMaterialGenerator}>=[
 {id:'clear-glass',name:'Clear window glass',roughness:.025,transmission:1,tint:'#ffffff',thickness:.008},
 {id:'green-glass',name:'Green bottle glass',roughness:.06,transmission:1,tint:'#64bd91',thickness:.12},
 {id:'blue-glass',name:'Blue architectural glass',roughness:.04,transmission:.96,tint:'#62a9e0',thickness:.06},
 {id:'amber-glass',name:'Amber glass',roughness:.08,transmission:1,tint:'#d58c36',thickness:.12},
 {id:'frosted-glass',name:'Frosted privacy glass',roughness:.55,transmission:1,tint:'#e9f0f1',thickness:.025},
 {id:'silver-mirror',name:'Polished silver mirror',roughness:.005,transmission:0,tint:'#ffffff',thickness:0,mirror:true},
 {id:'bronze-mirror',name:'Bronze mirror',roughness:.035,transmission:0,tint:'#cfad83',thickness:0,mirror:true},
 {id:'aged-mirror',name:'Aged brushed mirror',roughness:.19,transmission:0,tint:'#c1c9c8',thickness:0,mirror:true},
].map((p,i)=>({id:p.id,recipe:parseMaterialGeneratorData({name:p.name,seed:3101+i,tileMeters:[1,1],color:p.mirror?p.tint:'#ffffff',secondaryColor:p.mirror?p.tint:'#ffffff',variation:0,weathering:0,roughness:p.roughness,reliefMeters:0,pattern:p.mirror?{family:'metal',metalness:1,oxidation:p.id==='aged-mirror'?.12:0,brushing:p.id==='aged-mirror'?.6:0}:{family:'plaster',grainMeters:.002,cracks:0},optics:{transmission:p.transmission,ior:1.5,thicknessMeters:p.thickness,attenuationColor:p.mirror?'#ffffff':p.tint,attenuationDistanceMeters:.25},output:{resolution:128}})}));
