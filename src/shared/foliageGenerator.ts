import {parseMaterialGeneratorData} from './materialGeneratorData.ts';
import type {MaterialGeneratorRecipe,ResolvedMaterialGenerator} from './materialGenerator.ts';
import {parseMaterialPattern,materialPatternFeaturesAtCell,materialPatternGroupedFeaturesAtCell,type MaterialPatternFeature,type PatternConcentration} from './materialPatterns.ts';
export type FoliageMaterial=MaterialGeneratorRecipe|{ref:string};
export interface FoliageRecipe {kind:'foliage';version:1;name?:string;type?:'tree'|'bush';seed?:number;heightMeters?:number;crownRadiusMeters?:number;trunkRadiusMeters?:number;crownShape?:'round'|'conical';branchLevels?:number;branches?:number;branchAngle?:number;taper?:number;density?:number;clumping?:number;groupSizeMeters?:number;placementRegularity?:number;irregularity?:number;shapeVariation?:number;sizeVariation?:number;concentration?:Partial<PatternConcentration>;leafSizeMeters?:number;quality?:'low'|'medium'|'high';materials?:{bark:FoliageMaterial;leaf:FoliageMaterial}}
export interface ResolvedFoliage extends Required<Omit<FoliageRecipe,'materials'|'concentration'>> {concentration:PatternConcentration;materials:{bark:ResolvedMaterialGenerator|{ref:string};leaf:ResolvedMaterialGenerator|{ref:string}}}
type Vec=[number,number,number];
export interface FoliageBranch {id:number;parent:number;start:Vec;end:Vec;radiusStart:number;radiusEnd:number;level:number}
export interface FoliageLeaf {id:string;anchor:Vec;direction:Vec;roll:number;sizeScale:number;branch:number;t:number}
export interface FoliageModel {recipe:ResolvedFoliage;branches:FoliageBranch[];leaves:FoliageLeaf[];bounds:{min:Vec;max:Vec};diagnostics:{branches:number;leaves:number;proposedLeaves:number;qualityThinning:boolean;warnings:string[]}}
const defaults={name:'Generated foliage',type:'tree',seed:1,heightMeters:5,crownRadiusMeters:1.8,trunkRadiusMeters:.16,crownShape:'round',branchLevels:3,branches:5,branchAngle:.85,taper:.65,density:90,clumping:.65,groupSizeMeters:.55,placementRegularity:0,irregularity:.45,shapeVariation:.45,sizeVariation:.3,concentration:{strength:0,space:'model',axes:'xyz',center:[0,0,0],radius:1,softness:.25},leafSizeMeters:.2,quality:'medium'} as const;
function plain(input:unknown,keys:string[]){if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input))||Object.keys(input).some(k=>!keys.includes(k)))throw Error('Foliage requires supported plain recipe fields.');return input as Record<string,unknown>;}
export function parseFoliageRecipe(input:unknown):ResolvedFoliage{
  const raw=plain(input,['kind','version',...Object.keys(defaults),'materials']);if(raw.kind!=='foliage'||raw.version!==1)throw Error('Use kind:foliage, version:1.');
  const r={...defaults,...(raw.type==='bush'?{heightMeters:1.3,crownRadiusMeters:.85,trunkRadiusMeters:.035,branchLevels:2,branches:4,leafSizeMeters:.18}:{}),...Object.fromEntries(Object.entries(raw).filter(([,v])=>v!==undefined))} as unknown as ResolvedFoliage;
  const number=(v:unknown,min:number,max:number,int=false)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max||int&&!Number.isInteger(v))throw Error('Foliage parameter outside finite bounds.');};
  if(typeof r.name!=='string'||!r.name.length||r.name.length>120||!['tree','bush'].includes(r.type)||!['round','conical'].includes(r.crownShape)||!['low','medium','high'].includes(r.quality))throw Error('Invalid foliage name/type/crown/quality.');
  number(r.seed,-2147483648,2147483647,true);number(r.heightMeters,.2,30);number(r.crownRadiusMeters,.1,10);number(r.trunkRadiusMeters,.005,1);number(r.branchLevels,1,4,true);number(r.branches,2,7,true);number(r.branchAngle,.15,1.5);number(r.leafSizeMeters,.02,1);number(r.groupSizeMeters,.02,20);number(r.density,0,256);number(r.taper,.35,.85);
  for(const k of ['clumping','placementRegularity','irregularity','shapeVariation','sizeVariation'] as const)number(r[k],0,1);
  if(r.trunkRadiusMeters>Math.min(r.heightMeters*.2,r.crownRadiusMeters*.5))throw Error('Trunk radius must fit the height and crown.');
  r.concentration=parseMaterialPattern({type:'clusters',concentration:{space:'model',axes:'xyz',radius:1,softness:.25,...(raw.concentration===undefined?{}:plain(raw.concentration,['strength','space','axes','center','radius','softness']))}}).concentration;if(r.concentration.space!=='model')throw Error('Foliage distribution requires model space.');
  const materials=raw.materials===undefined?{bark:{pattern:{family:'bark',ridgeMeters:.018,fissures:.45,knots:.15,peeling:.1},tileMeters:[.4,.8],color:'#716454',secondaryColor:'#4b443b',reliefMeters:.004},leaf:{pattern:{family:'leaf',lengthMeters:.18,widthMeters:.075,outline:'lobed'},tileMeters:[.12,.22],color:'#608f39',secondaryColor:'#233f17',reliefMeters:.001}}:plain(raw.materials,['bark','leaf']);
  function slot(value:unknown){if(value&&typeof value==='object'&&'ref'in value){const v=plain(value,['ref']);if(typeof v.ref!=='string'||!/^[a-z][a-z0-9._-]{0,119}$/i.test(v.ref))throw Error('Invalid foliage material reference.');return{ref:v.ref};}return parseMaterialGeneratorData(value);}
  r.materials={bark:slot(materials.bark),leaf:slot(materials.leaf)};return r;
}
const add=(a:Vec,b:Vec):Vec=>a.map((n,i)=>n+b[i]) as Vec;
const scale=(a:Vec,n:number):Vec=>a.map(v=>v*n) as Vec;
const sub=(a:Vec,b:Vec):Vec=>a.map((n,i)=>n-b[i]) as Vec;
const normalize=(a:Vec):Vec=>scale(a,1/(Math.hypot(...a)||1));
function random(a:number,b:number,seed:number){let n=Math.imul(a^seed,374761393)^Math.imul(b,668265263);n=Math.imul(n^(n>>>13),1274126177);return((n^(n>>>16))>>>0)/4294967295;}
/** Pure authoring compiler. Every woody segment has an explicit parent connection;
 * shared distribution proposals are projected onto terminal twigs, never floated. */
export function compileFoliage(input:FoliageRecipe):FoliageModel{
  const r=parseFoliageRecipe(input),branches:FoliageBranch[]=[],leaves:FoliageLeaf[]=[];let pathId=0;
  function grow(start:Vec,direction:Vec,length:number,radius:number,level:number,parent:number){
    const id=pathId++,steps=4;let a=start,last=parent,dir=normalize(direction);
    for(let i=0;i<steps;i++){
      dir=normalize(add(dir,[(random(id,i*3,r.seed)-.5)*r.irregularity*.22,.025,(random(id,i*3+1,r.seed)-.5)*r.irregularity*.22]));
      const end=add(a,scale(dir,length/steps)),index=branches.length;if(index>=8192)throw Error('Foliage branch budget exceeded. Reduce levels or branches.');branches.push({id:index,parent:last,start:a,end,radiusStart:radius*(1-i/steps*(1-(level===0?.08:r.taper))),radiusEnd:radius*(1-(i+1)/steps*(1-(level===0?.08:r.taper))),level});a=end;last=index;
    }
    if(level>=r.branchLevels)return;
    const count=level===0?r.branches+2:r.branches;
    for(let i=0;i<count;i++){
      const fraction=level===0?.28+i/count*.68:.42+i/count*.55,segment=branches[last-steps+1+Math.min(steps-1,Math.floor(fraction*steps))];
      const t=fraction*steps%1,start=add(segment.start,scale(sub(segment.end,segment.start),t));
      const angle=i*2.399963+random(id,101,r.seed)*Math.PI*2+random(id,i,r.seed+17)*r.irregularity,spread=r.branchAngle+(random(id,i,r.seed+19)-.5)*r.shapeVariation*.45;
      const conical=r.crownShape==='conical'?Math.max(.15,1-start[1]/r.heightMeters):1;
      const reach=level===0?r.crownRadiusMeters*(.48+random(id,i,r.seed+23)*.2)*conical:length*(.48+random(id,i,r.seed+29)*.18);
      const parentDirection=normalize(sub(segment.end,segment.start)),radial:Vec=[Math.cos(angle),.12,Math.sin(angle)],growth=normalize(add(scale(parentDirection,Math.cos(spread)),scale(radial,Math.sin(spread))));
      grow(start,growth,reach,(segment.radiusStart*(1-t)+segment.radiusEnd*t)*(level===0?.5:.4),level+1,segment.id);
    }
  }
  const stems=r.type==='bush'?5:1;
  for(let i=0;i<stems;i++){const angle=i*2.399963;grow([0,0,0],normalize([r.type==='bush'?Math.cos(angle)*.38:0,1,r.type==='bush'?Math.sin(angle)*.38:0]),r.heightMeters*(r.type==='bush'?.55:.7),r.trunkRadiusMeters*(r.type==='bush'?.55:1),0,-1);}
  const actualHeight=Math.max(...branches.map(b=>b.end[1])),actualRadius=Math.max(...branches.map(b=>Math.hypot(b.end[0],b.end[2]))),vertical=r.heightMeters/actualHeight,horizontal=r.crownRadiusMeters/Math.max(.001,actualRadius);
  for(const b of branches){b.start=[b.start[0]*horizontal,b.start[1]*vertical,b.start[2]*horizontal];b.end=[b.end[0]*horizontal,b.end[1]*vertical,b.end[2]*horizontal];}
  if(branches.length>8192)throw Error('Foliage branch budget exceeded. Reduce levels or branches.');
  const twigs=branches.filter(b=>b.level===r.branchLevels),crownHeight=r.heightMeters*(r.type==='bush'?.95:.75),centerY=r.heightMeters*(r.type==='bush'?.52:.68),meters:Vec=[r.crownRadiusMeters*2,crownHeight,r.crownRadiusMeters*2];
  const expected=r.density*meters.reduce((n,v)=>n*v,1);if(expected>20000)throw Error('Foliage proposal budget exceeds 20000. Reduce density or crown dimensions.');
  const pattern=parseMaterialPattern({type:'clusters',density:r.density,clumping:r.clumping,groupSizeMeters:r.groupSizeMeters,placementRegularity:r.placementRegularity,sizeVariation:r.sizeVariation,seed:r.seed,concentration:r.concentration}),frame={modelMeters:meters};
  const candidates:MaterialPatternFeature[]=[];
  function visit(grouped:boolean){
    if(!r.density||grouped&&(!r.clumping||r.placementRegularity===1))return;
    const spacing=Math.pow(r.density,-1/3),counts=meters.map(v=>Math.ceil(v/r.groupSizeMeters));
    const low=grouped?[0,0,0]:meters.map(v=>Math.floor(-v/2/spacing)),high=grouped?counts.map(v=>v-1):meters.map(v=>Math.floor(v/2/spacing));
    if(high.reduce((n,v,i)=>n*(v-low[i]+1),1)>32768)throw Error('Foliage distribution region budget exceeded. Increase group size or reduce density/crown dimensions.');
    for(let z=low[2];z<=high[2];z++)for(let y=low[1];y<=high[1];y++)for(let x=low[0];x<=high[0];x++)for(const f of (grouped?materialPatternGroupedFeaturesAtCell(pattern,[x,y,z],frame,20000):materialPatternFeaturesAtCell(pattern,[x,y,z],frame)))if(f.accepted)candidates.push(f);
  }
  visit(false);visit(true);if(candidates.length>22000)throw Error('Foliage generated more than 22000 proposals. Reduce density.');
  const budget={low:1800,medium:6500,high:16000}[r.quality],ordered=candidates.map((f,i)=>({f,rank:random(i,701,r.seed)})).sort((a,b)=>a.rank-b.rank).slice(0,budget);
  for(const {f}of ordered){const target=add(f.center,[0,centerY,0]);let nearest=Infinity,twig=twigs[0],t=0;
    for(const b of twigs){const axis=sub(b.end,b.start),delta=sub(target,b.start),length=axis.reduce((n,v)=>n+v*v,0),at=Math.max(0,Math.min(1,axis.reduce((n,v,i)=>n+v*delta[i],0)/(length||1))),p=add(b.start,scale(axis,at)),distance=Math.hypot(...sub(target,p));if(distance<nearest){nearest=distance;twig=b;t=at;}}
    const pathStart=twig.id-twig.id%4,along=.15+random(Math.floor(f.center[0]*100000),Math.floor(f.center[2]*100000),r.seed+Math.floor(f.center[1]*10000))*.85;twig=branches[pathStart+Math.min(3,Math.floor(along*4))];t=along*4%1;
    const anchor=add(twig.start,scale(sub(twig.end,twig.start),t)),toward=sub(target,anchor),i=leaves.length;
    // A leaf grows away from its attached base; the renderer keeps its cutout
    // silhouette's base on this exact anchor even when leaf size changes.
    const direction=normalize(add(normalize(toward),[(random(i,2,r.seed)-.5)*.5,.35,(random(i,3,r.seed)-.5)*.5]));
    leaves.push({id:f.id,anchor,direction,roll:(random(i,5,r.seed)-.5)*Math.PI*2,sizeScale:f.sizeScale,branch:twig.id,t});
  }
  const points=[...branches.flatMap(b=>[b.start,b.end]),...leaves.flatMap(l=>[l.anchor,add(l.anchor,scale(l.direction,r.leafSizeMeters*l.sizeScale))])];
  const pad=r.leafSizeMeters*.65+r.trunkRadiusMeters,min=[0,0,0].map((_,i)=>Math.min(...points.map(p=>p[i]))-pad) as Vec,max=[0,0,0].map((_,i)=>Math.max(...points.map(p=>p[i]))+pad) as Vec;
  return{recipe:r,branches,leaves,bounds:{min,max},diagnostics:{branches:branches.length,leaves:leaves.length,proposedLeaves:candidates.length,qualityThinning:candidates.length>budget,warnings:candidates.length>budget?['Quality budget thinned the leaf proposals deterministically.']:[]}};
}
/** Coarse authoritative trunk/major-branch capsules. Leaf cards never collide. */
export function foliageColliders(model:FoliageModel,options:{maxLevel?:number;maxColliders?:number}={}){
  const maxLevel=options.maxLevel??0,maxColliders=options.maxColliders??64;
  if(!Number.isInteger(maxLevel)||maxLevel<0||maxLevel>4||!Number.isInteger(maxColliders)||maxColliders<1||maxColliders>256)throw Error('Invalid foliage collider budget/level.');
  const chosen=model.branches.filter(b=>b.level<=maxLevel);if(chosen.length>maxColliders)throw Error('Foliage collider budget exceeded. Reduce maxLevel.');
  return chosen.map(b=>{const d=sub(b.end,b.start),length=Math.hypot(...d),axis=normalize(d),q=[axis[2],0,-axis[0],1+axis[1]],n=Math.hypot(...q)||1;
    return{id:'foliage-branch-'+b.id,shape:{kind:'capsule' as const,radius:Math.max(b.radiusStart,b.radiusEnd),halfHeight:length/2},position:{x:(b.start[0]+b.end[0])/2,y:(b.start[1]+b.end[1])/2,z:(b.start[2]+b.end[2])/2},rotation:{x:q[0]/n,y:q[1]/n,z:q[2]/n,w:q[3]/n}};
  });
}
