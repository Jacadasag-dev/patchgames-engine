import type {GenerationMapRecipe} from '../src/shared/generationMaps.ts';
import {compileGenerationMaps} from '../src/shared/generationMaps.ts';
import type {GenerationBinding} from '../src/shared/generationBindings.ts';
import type {FoliageRecipe} from '../src/shared/foliageGenerator.ts';
import type {ObjectSurfaceDocument} from '../src/shared/objectSurface.ts';
import type {TerrainRecipe,TerrainElevationMaps} from '../src/sandbox/terrain.ts';
export type GenerationLabMode='terrain'|'trees'|'wall';
export interface GenerationLabRecipe {kind:'generation-lab';version:1;name:string;graph:GenerationMapRecipe;terrain:{width:number;layers:TerrainElevationMaps['layers']};foliage:{recipe:FoliageRecipe;bindings:GenerationBinding[]};wall:Omit<ObjectSurfaceDocument,'generation'>;wallBindings:GenerationBinding[]}
export function defaultGenerationLabRecipe():GenerationLabRecipe{return{
 kind:'generation-lab',version:1,name:'Layered world proof',graph:{kind:'generation-maps',version:1,seed:42,maps:{
  mountainRegion:{type:'noise',space:'world',scaleMeters:80,octaves:1},mountainMask:{type:'remap',input:'mountainRegion',from:[.1,.24],to:[0,1],unit:'normalized'},
  plainsMask:{type:'remap',input:'mountainMask',from:[0,1],to:[1,0],unit:'normalized'},
  ridges:{type:'noise',space:'world',scaleMeters:20,octaves:3,ridged:true},mountainHeight:{type:'remap',input:'ridges',from:[0,1],to:[-1,8],unit:'metres'},
  hills:{type:'noise',space:'world',scaleMeters:8,octaves:2},hillHeight:{type:'remap',input:'hills',from:[0,1],to:[-1.5,1.5],unit:'metres'},
  fine:{type:'noise',space:'world',scaleMeters:1.8,octaves:2},detailHeight:{type:'remap',input:'fine',from:[0,1],to:[-.18,.18],unit:'metres'},
  treeVariation:{type:'random',scope:'object',channel:'shape'},branchVariation:{type:'random',scope:'object',channel:'branch'},barkVariation:{type:'random',scope:'object',channel:'bark'},
  wallExposure:{type:'gradient',space:'object',axis:'x',from:-4,to:4},wallNoise:{type:'noise',space:'object',scaleMeters:.4,octaves:2},wallWeathering:{type:'mix',inputs:[{map:'wallExposure',weight:.9},{map:'wallNoise',weight:.1}]},
 }},terrain:{width:48,layers:[{id:'mountain-range',map:'mountainHeight',weight:1,mask:'mountainMask'},{id:'plain-hills',map:'hillHeight',weight:1,mask:'plainsMask'},{id:'local-detail',map:'detailHeight',weight:1}]},
 foliage:{recipe:{kind:'foliage',version:1,name:'Mapped woodland tree',seed:113,heightMeters:3.2,crownRadiusMeters:1.2,trunkRadiusMeters:.12,branchLevels:2,branches:3,branchSegments:6,density:80,leafSizeMeters:.2,quality:'low'},bindings:[
  {id:'height',target:'foliage.heightMeters',map:'treeVariation',range:[.85,1.15],operation:'multiply'},
  {id:'leaf-size',target:'foliage.leafSizeMeters',map:'treeVariation',range:[.8,1.2],operation:'multiply'},
  {id:'leaf-count',target:'foliage.density',map:'branchVariation',range:[.75,1.25],operation:'multiply'},
  {id:'branch-pitch',target:'foliage.branchPitchVariation',map:'branchVariation',range:[.1,.55]},
  {id:'bark-finish',target:'bark.roughness',map:'barkVariation',range:[.45,.9]},
  {id:'bark-variation',target:'bark.variation',map:'barkVariation',range:[.1,.55]},
 ]},wall:{kind:'object-surface',version:2,name:'Directional castle stone',sizeMeters:[8,3,.5],seed:55,base:{pattern:{family:'masonry',shape:'rectangle',blockMeters:[.45,.25],mortarMeters:.018,chipping:.25},tileMeters:[1.8,1],color:'#a8a193',secondaryColor:'#514d45',roughness:.45,variation:.3},layers:[{id:'weathering',material:{pattern:{family:'plaster',grainMeters:.02,cracks:0},tileMeters:[1,1],color:'#3f4f32',secondaryColor:'#202c1e',roughness:.95},coverage:{pattern:{type:'patches',mode:'solid'}}}],output:{resolution:256,style:'realistic',paletteSteps:8}},wallBindings:[
  {id:'stone-roughness',target:'base.roughness',map:'wallWeathering',range:[.35,.95]},
  {id:'surface-wear',target:'base.weathering',map:'wallWeathering',range:[.02,.8]},
  {id:'weathered-color',target:'layer:weathering.opacity',map:'wallWeathering',range:[0,.85]},
 ]};}
export function parseGenerationLabRecipe(input:unknown):GenerationLabRecipe{
 if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))throw Error('Lab recipe must be a plain object.');
 const raw=input as Record<string,unknown>;if(Object.keys(raw).some(k=>!['kind','version','name','graph','terrain','foliage','wall','wallBindings'].includes(k))||raw.kind!=='generation-lab'||raw.version!==1||typeof raw.name!=='string'||raw.name.length>120)throw Error('Use the generation-lab version 1 recipe fields.');
 const r=structuredClone(raw) as unknown as GenerationLabRecipe;r.graph=structuredClone(compileGenerationMaps(r.graph).recipe);if(!r.terrain||!Number.isFinite(r.terrain.width)||r.terrain.width<24||r.terrain.width>128||!Array.isArray(r.terrain.layers)||!r.foliage||!Array.isArray(r.foliage.bindings)||!r.wall||!Array.isArray(r.wallBindings))throw Error('Lab requires a 24–128 metre terrain, foliage bindings and wall bindings.');return r;
}
/** Terrain uses an unsigned seed; preserve the signed master seed's 32-bit identity. */
export function generationLabTerrain(r:GenerationLabRecipe):TerrainRecipe{return{version:1,seed:r.graph.seed>>>0,bounds:{width:r.terrain.width,depth:r.terrain.width,cells:32},streaming:false,base:{height:0,maps:{graph:r.graph,layers:r.terrain.layers}},assets:[{id:'tree',footprint:{kind:'circle',radius:4}}],regions:[{id:'woodland',mask:{kind:'box',width:r.terrain.width,depth:r.terrain.width,center:{x:0,z:0}},color:'#526746',layers:[{id:'four-trees',assets:['tree'],spacing:12,density:1,count:4,scale:[1,1]}]}]};}
