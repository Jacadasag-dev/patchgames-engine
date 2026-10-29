import {parseMaterialGeneratorData} from './materialGeneratorData.ts';
import type {MaterialGeneratorRecipe,ResolvedMaterialGenerator} from './materialGenerator.ts';
import {parseMaterialPattern,materialPatternFeaturesAtCell,materialPatternGroupedFeaturesAtCell,type MaterialPatternFeature,type PatternConcentration} from './materialPatterns.ts';
export interface FoliageFlowers {density:number;sizeMeters:number;petals:number}
export type FoliageMaterial=MaterialGeneratorRecipe|{ref:string};
export interface FoliageRecipe {kind:'foliage';version:1;name?:string;type?:'tree'|'bush';seed?:number;heightMeters?:number;crownRadiusMeters?:number;trunkRadiusMeters?:number;crownTaper?:number;tipLeafScale?:number;crownShape?:'round'|'conical';branchLevels?:number;branches?:number;branchWhorls?:number;tierSpacingBias?:number;branchAngle?:number;taper?:number;density?:number;clumping?:number;groupSizeMeters?:number;placementRegularity?:number;irregularity?:number;shapeVariation?:number;sizeVariation?:number;concentration?:Partial<PatternConcentration>;leafSizeMeters?:number;quality?:'low'|'medium'|'high';crownStart?:number;trunkTaper?:number;trunkLean?:number;trunkCurve?:number;rootFlare?:number;branchRadiusRatio?:number;branchSegments?:number;winding?:number;branchDroop?:number;terminalDroop?:number;terminalLength?:number;leafDroop?:number;leafArrangement?:'scattered'|'pinnate'|'fan';flowers?:Partial<FoliageFlowers>;materials?:{bark:FoliageMaterial;leaf:FoliageMaterial;flower?:FoliageMaterial}}
export interface ResolvedFoliage extends Required<Omit<FoliageRecipe,'materials'|'concentration'|'flowers'>> {concentration:PatternConcentration;flowers:FoliageFlowers;materials:{bark:ResolvedMaterialGenerator|{ref:string};leaf:ResolvedMaterialGenerator|{ref:string};flower:ResolvedMaterialGenerator|{ref:string}}}
type Vec=[number,number,number];
export interface FoliageBranch {id:number;parent:number;start:Vec;end:Vec;radiusStart:number;radiusEnd:number;level:number;path:number;step:number}
export interface FoliageLeaf {id:string;anchor:Vec;direction:Vec;roll:number;sizeScale:number;branch:number;t:number}
export interface FoliageFlower {anchor:Vec;normal:Vec;sizeScale:number;branch:number;t:number}
export interface FoliageModel {recipe:ResolvedFoliage;branches:FoliageBranch[];leaves:FoliageLeaf[];flowers:FoliageFlower[];bounds:{min:Vec;max:Vec};diagnostics:{branches:number;leaves:number;proposedLeaves:number;flowers:number;proposedFlowers:number;qualityThinning:boolean;warnings:string[]}}
const defaults={name:'Generated foliage',type:'tree',seed:1,heightMeters:5,crownRadiusMeters:1.8,trunkRadiusMeters:.16,crownShape:'round',crownTaper:1,tipLeafScale:1,branchLevels:3,branches:5,branchWhorls:1,tierSpacingBias:0,branchAngle:.85,taper:.65,density:90,clumping:.65,groupSizeMeters:.55,placementRegularity:0,irregularity:.45,shapeVariation:.45,sizeVariation:.3,concentration:{strength:0,space:'model',axes:'xyz',center:[0,0,0],radius:1,softness:.25},leafSizeMeters:.2,quality:'medium',crownStart:.28,trunkTaper:.08,trunkLean:0,trunkCurve:0,rootFlare:0,branchRadiusRatio:.5,branchSegments:4,winding:0,branchDroop:0,terminalDroop:0,terminalLength:1,leafDroop:0,leafArrangement:'scattered',flowers:{density:0,sizeMeters:.2,petals:8}} as const;
function plain(input:unknown,keys:string[]){if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input))||Object.keys(input).some(k=>!keys.includes(k)))throw Error('Foliage requires supported plain recipe fields.');return input as Record<string,unknown>;}
export function parseFoliageRecipe(input:unknown):ResolvedFoliage{
  const raw=plain(input,['kind','version',...Object.keys(defaults),'materials']);if(raw.kind!=='foliage'||raw.version!==1)throw Error('Use kind:foliage, version:1.');
  const r={...defaults,...(raw.type==='bush'?{heightMeters:1.3,crownRadiusMeters:.85,trunkRadiusMeters:.035,branchLevels:2,branches:4,leafSizeMeters:.18}:{}),...Object.fromEntries(Object.entries(raw).filter(([,v])=>v!==undefined))} as unknown as ResolvedFoliage;
  const number=(v:unknown,min:number,max:number,int=false)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max||int&&!Number.isInteger(v))throw Error('Foliage parameter outside finite bounds.');};
  if(typeof r.name!=='string'||!r.name.length||r.name.length>120||!['tree','bush'].includes(r.type)||!['round','conical'].includes(r.crownShape)||!['low','medium','high'].includes(r.quality))throw Error('Invalid foliage name/type/crown/quality.');
  number(r.seed,-2147483648,2147483647,true);number(r.heightMeters,.2,30);number(r.crownRadiusMeters,.1,10);number(r.trunkRadiusMeters,.005,1);number(r.branchLevels,1,4,true);number(r.branches,2,12,true);number(r.branchWhorls,1,4,true);number(r.tierSpacingBias,-1,1);number(r.branchAngle,.15,1.5);number(r.crownStart,.05,.98);number(r.crownTaper,.25,3);number(r.tipLeafScale,.1,1);number(r.trunkTaper,.04,1);number(r.trunkLean,0,1);number(r.trunkCurve,0,1);number(r.terminalLength,.25,3);number(r.rootFlare,0,1);number(r.branchRadiusRatio,.1,.75);number(r.branchSegments,4,16,true);if(!['scattered','pinnate','fan'].includes(r.leafArrangement))throw Error('Invalid leaf arrangement.');
  const blooms=raw.flowers===undefined?{}:plain(raw.flowers,['density','sizeMeters','petals']);r.flowers={density:0,sizeMeters:.2,petals:8,...blooms} as FoliageFlowers;number(r.flowers.density,0,32);number(r.flowers.sizeMeters,.03,.6);number(r.flowers.petals,3,12,true);number(r.leafSizeMeters,.02,1);number(r.groupSizeMeters,.02,20);number(r.density,0,256);number(r.taper,.35,.85);
  for(const k of ['clumping','placementRegularity','irregularity','shapeVariation','sizeVariation','winding','branchDroop','terminalDroop','leafDroop'] as const)number(r[k],0,1);
  if(r.trunkRadiusMeters>Math.min(r.heightMeters*.2,r.crownRadiusMeters*.5))throw Error('Trunk radius must fit the height and crown.');
  r.concentration=parseMaterialPattern({type:'clusters',concentration:{space:'model',axes:'xyz',radius:1,softness:.25,...(raw.concentration===undefined?{}:plain(raw.concentration,['strength','space','axes','center','radius','softness']))}}).concentration;if(r.concentration.space!=='model')throw Error('Foliage distribution requires model space.');
  const materials=raw.materials===undefined?{bark:{pattern:{family:'bark',ridgeMeters:.018,fissures:.45,knots:.15,peeling:.1},tileMeters:[.4,.8],color:'#716454',secondaryColor:'#4b443b',reliefMeters:.004},leaf:{pattern:{family:'leaf',lengthMeters:.18,widthMeters:.075,outline:'lobed'},tileMeters:[.12,.22],color:'#608f39',secondaryColor:'#233f17',reliefMeters:.001}}:plain(raw.materials,['bark','leaf','flower']);
  function slot(value:unknown){if(value&&typeof value==='object'&&'ref'in value){const v=plain(value,['ref']);if(typeof v.ref!=='string'||!/^[a-z][a-z0-9._-]{0,119}$/i.test(v.ref))throw Error('Invalid foliage material reference.');return{ref:v.ref};}return parseMaterialGeneratorData(value);}
  r.materials={bark:slot(materials.bark),leaf:slot(materials.leaf),flower:slot(materials.flower===undefined?{pattern:{family:'leaf',lengthMeters:.09,widthMeters:.065,outline:'oval',veins:.08,edgeSerration:0,damage:0},tileMeters:[.09,.12],color:'#f4e5dc',secondaryColor:'#d4a6b5',roughness:.5,reliefMeters:.0003}:materials.flower)};return r;
}
const add=(a:Vec,b:Vec):Vec=>a.map((n,i)=>n+b[i]) as Vec;
const scale=(a:Vec,n:number):Vec=>a.map(v=>v*n) as Vec;
const sub=(a:Vec,b:Vec):Vec=>a.map((n,i)=>n-b[i]) as Vec;
const normalize=(a:Vec):Vec=>scale(a,1/(Math.hypot(...a)||1));
function random(a:number,b:number,seed:number){let n=Math.imul(a^seed,374761393)^Math.imul(b,668265263);n=Math.imul(n^(n>>>13),1274126177);return((n^(n>>>16))>>>0)/4294967295;}
/** Pure authoring compiler. Every woody segment has an explicit parent connection;
 * shared distribution proposals are projected onto terminal twigs, never floated. */
export function compileFoliage(input:FoliageRecipe):FoliageModel{
  const r=parseFoliageRecipe(input),branches:FoliageBranch[]=[],leaves:FoliageLeaf[]=[],flowers:FoliageFlower[]=[];let pathId=0;
  function grow(start:Vec,direction:Vec,length:number,radius:number,level:number,parent:number){
    const id=pathId++,steps=r.branchSegments;let a=start,last=parent,dir=normalize(direction);
    for(let i=0;i<steps;i++){
      const phase=id*2.399963+i/steps*Math.PI*2*(1+r.winding*2),curl=r.winding*(level===0?.09:.24);
      dir=normalize(add(dir,[(random(id,i*3,r.seed)-.5)*r.irregularity*.22+Math.sin(phase)*curl+(level===0?Math.cos(r.seed*1.719)*r.trunkCurve*.09:0),.025-(level===0?0:(r.branchDroop*.5+(level===r.branchLevels?r.terminalDroop*.8:0))*(i/steps)),(random(id,i*3+1,r.seed)-.5)*r.irregularity*.22+Math.cos(phase)*curl+(level===0?Math.sin(r.seed*1.719)*r.trunkCurve*.09:0)]));
      const end=add(a,scale(dir,length/steps)),index=branches.length;if(index>=8192)throw Error('Foliage branch budget exceeded. Reduce levels or branches.');branches.push({id:index,parent:last,start:a,end,radiusStart:radius*(1+(level===0?r.rootFlare*Math.pow(1-i/steps,3):0))*(1-i/steps*(1-(level===0?r.trunkTaper:r.taper))),radiusEnd:radius*(1+(level===0?r.rootFlare*Math.pow(1-(i+1)/steps,3):0))*(1-(i+1)/steps*(1-(level===0?r.trunkTaper:r.taper))),level,path:id,step:i});a=end;last=index;
    }
    if(level>=r.branchLevels)return;
    const count=level===0?(r.branches+2)*r.branchWhorls:r.branches;
    for(let i=0;i<count;i++){
      const tier=Math.floor(i/r.branchWhorls)/(count/r.branchWhorls-(r.branchWhorls>1?1:0)),exponent=1+Math.abs(r.tierSpacingBias)*3,spaced=r.tierSpacingBias>=0?1-Math.pow(1-tier,exponent):Math.pow(tier,exponent);
      const fraction=level===0?r.crownStart+spaced*(.96-r.crownStart):.42+i/count*.55,segment=branches[last-steps+1+Math.min(steps-1,Math.floor(fraction*steps))];
      const t=fraction*steps%1,start=add(segment.start,scale(sub(segment.end,segment.start),t));
      const angle=i*2.399963+random(id,101,r.seed)*Math.PI*2+random(id,i,r.seed+17)*r.irregularity,spread=r.branchAngle+(random(id,i,r.seed+19)-.5)*r.shapeVariation*.45;
      const conical=r.crownShape==='conical'&&level===0?Math.pow(Math.max(.025,1-fraction),r.crownTaper):1;
      const reach=level===0?r.crownRadiusMeters*(.48+random(id,i,r.seed+23)*.2)*conical:length*(.48+random(id,i,r.seed+29)*.18);
      const parentDirection=normalize(sub(segment.end,segment.start)),radial:Vec=[Math.cos(angle),.12,Math.sin(angle)],growth=normalize(add(scale(parentDirection,Math.cos(spread)),scale(radial,Math.sin(spread))));
      grow(start,growth,reach*(level+1===r.branchLevels?r.terminalLength:1),(segment.radiusStart*(1-t)+segment.radiusEnd*t)*r.branchRadiusRatio*(level===0?1:.8),level+1,segment.id);
    }
  }
  const stems=r.type==='bush'?5:1;
  for(let i=0;i<stems;i++){const angle=i*2.399963;grow([0,0,0],normalize([r.type==='bush'?Math.cos(angle)*.38:Math.cos(r.seed*1.719)*r.trunkLean,1,r.type==='bush'?Math.sin(angle)*.38:Math.sin(r.seed*1.719)*r.trunkLean]),r.heightMeters*(r.type==='bush'?.55:.7),r.trunkRadiusMeters*(r.type==='bush'?.55:1),0,-1);}
  // Fit crown spread around the stem axis, not around the world origin: a
  // leaning trunk must not consume the crown radius and squash its fronds.
  const stemTip=branches[r.branchSegments-1].end,axisX=r.type==='tree'?stemTip[0]/stemTip[1]:0,axisZ=r.type==='tree'?stemTip[2]/stemTip[1]:0;
  const actualHeight=Math.max(...branches.map(b=>b.end[1])),actualRadius=Math.max(...branches.map(b=>Math.hypot(b.end[0]-axisX*b.end[1],b.end[2]-axisZ*b.end[1]))),vertical=r.heightMeters/actualHeight,horizontal=r.crownRadiusMeters/Math.max(.001,actualRadius);
  const fit=(p:Vec):Vec=>[axisX*p[1]*vertical+(p[0]-axisX*p[1])*horizontal,p[1]*vertical,axisZ*p[1]*vertical+(p[2]-axisZ*p[1])*horizontal];
  for(const b of branches){b.start=fit(b.start);b.end=fit(b.end);}
  if(branches.length>8192)throw Error('Foliage branch budget exceeded. Reduce levels or branches.');
  const twigs=branches.filter(b=>b.level===r.branchLevels),crownHeight=r.heightMeters*(r.type==='bush'?.95:Math.max(.2,(1-r.crownStart)*1.04)),centerY=r.heightMeters*(r.type==='bush'?.52:r.crownStart+(1-r.crownStart)*.55),meters:Vec=[r.crownRadiusMeters*2,crownHeight,r.crownRadiusMeters*2];
  const paths=new Map<number,FoliageBranch[]>();for(const b of branches){const path=paths.get(b.path)??[];path.push(b);paths.set(b.path,path);}
  function distribute(density:number,seed:number){
    const expected=density*meters.reduce((n,v)=>n*v,1);if(expected>20000)throw Error('Foliage proposal budget exceeds 20000. Reduce density or crown dimensions.');
    const pattern=parseMaterialPattern({type:'clusters',density,clumping:r.clumping,groupSizeMeters:r.groupSizeMeters,placementRegularity:r.placementRegularity,sizeVariation:r.sizeVariation,seed,concentration:r.concentration}),frame={modelMeters:meters},candidates:MaterialPatternFeature[]=[];
    for(const grouped of [false,true]){
      if(!density||grouped&&(!r.clumping||r.placementRegularity===1))continue;
      const spacing=Math.pow(density,-1/3),counts=meters.map(v=>Math.ceil(v/r.groupSizeMeters)),low=grouped?[0,0,0]:meters.map(v=>Math.floor(-v/2/spacing)),high=grouped?counts.map(v=>v-1):meters.map(v=>Math.floor(v/2/spacing));
      if(high.reduce((n,v,i)=>n*(v-low[i]+1),1)>32768)throw Error('Foliage distribution region budget exceeded. Increase group size or reduce density/crown dimensions.');
      for(let z=low[2];z<=high[2];z++)for(let y=low[1];y<=high[1];y++)for(let x=low[0];x<=high[0];x++)for(const f of (grouped?materialPatternGroupedFeaturesAtCell(pattern,[x,y,z],frame,20000):materialPatternFeaturesAtCell(pattern,[x,y,z],frame)))if(f.accepted)candidates.push(f);
    }
    if(candidates.length>22000)throw Error('Foliage generated more than 22000 proposals. Reduce density.');
    return candidates.map((f,i)=>({f,rank:random(i,701,seed)})).sort((a,b)=>a.rank-b.rank);
  }
  function attach(f:MaterialPatternFeature,i:number):FoliageLeaf{
    const targetY=f.center[1]+centerY,envelope=r.crownShape==='conical'?Math.pow(Math.max(.025,Math.min(1,(1-targetY/r.heightMeters)/(1-r.crownStart))),r.crownTaper):1,target:Vec=[axisX*targetY+f.center[0]*envelope,targetY,axisZ*targetY+f.center[2]*envelope];let nearest=Infinity,twig=twigs[0],t=0;
    for(const b of twigs){const axis=sub(b.end,b.start),delta=sub(target,b.start),length=axis.reduce((n,v)=>n+v*v,0),at=Math.max(0,Math.min(1,axis.reduce((n,v,i)=>n+v*delta[i],0)/(length||1))),p=add(b.start,scale(axis,at)),distance=Math.hypot(...sub(target,p));if(distance<nearest){nearest=distance;twig=b;t=at;}}
    const path=paths.get(twig.path)!,along=.15+random(Math.floor(f.center[0]*100000),Math.floor(f.center[2]*100000),r.seed+Math.floor(f.center[1]*10000))*.85;twig=path[Math.min(path.length-1,Math.floor(along*path.length))];t=along*path.length%1;
    const anchor=add(twig.start,scale(sub(twig.end,twig.start),t)),toward=sub(target,anchor),direction=normalize(add(normalize(toward),[(random(i,2,r.seed)-.5)*.5,.35-r.leafDroop*.9,(random(i,3,r.seed)-.5)*.5]));
    if(r.crownShape==='conical'){const lift=Math.max(0,(anchor[1]/r.heightMeters-.8)/.2);direction[1]+=lift*3;}
    return{id:f.id,anchor,direction:normalize(direction),roll:(random(i,5,r.seed)-.5)*Math.PI*2,sizeScale:f.sizeScale*(r.tipLeafScale+(1-r.tipLeafScale)*Math.max(0,1-anchor[1]/r.heightMeters)),branch:twig.id,t};
  }
  const candidates=distribute(r.density,r.seed),budget={low:1800,medium:6500,high:16000}[r.quality];
  for(const {f}of candidates.slice(0,budget))leaves.push(attach(f,leaves.length));
  if(r.leafArrangement!=='scattered'){
    const byPath=new Map<number,FoliageLeaf[]>();for(const leaf of leaves){const id=branches[leaf.branch].path,list=byPath.get(id)??[];list.push(leaf);byPath.set(id,list);}
    for(const [id,list]of byPath){const path=paths.get(id)!;
      for(let i=0;i<list.length;i++){const l=list[i],along=r.leafArrangement==='fan'?.94:.1+.84*(Math.floor(i/2)+.5)/Math.ceil(list.length/2),b=path[Math.min(path.length-1,Math.floor(along*path.length))],t=along*path.length%1,axis=normalize(sub(b.end,b.start)),side=normalize([axis[2],0,-axis[0]]);
        l.branch=b.id;l.t=t;l.anchor=add(b.start,scale(sub(b.end,b.start),t));
        if(r.leafArrangement==='pinnate')l.direction=normalize(add(add(scale(side,i%2?1:-1),scale(axis,.28)),[0,-r.leafDroop,0]));
        else{const angle=-1.25+2.5*i/Math.max(1,list.length-1);l.direction=normalize(add(add(scale(side,Math.sin(angle)),scale(axis,Math.cos(angle))),[0,-r.leafDroop*.4,0]));}
      }
    }
  }
  const bloomCandidates=distribute(r.flowers.density,r.seed+10007),bloomBudget={low:48,medium:128,high:256}[r.quality];
  for(const {f}of bloomCandidates.slice(0,bloomBudget)){const a=attach(f,flowers.length);flowers.push({anchor:a.anchor,normal:normalize([a.direction[0]*.3,1,a.direction[2]*.3]),sizeScale:a.sizeScale,branch:a.branch,t:a.t});}
  const points=[...branches.flatMap(b=>[b.start,b.end]),...leaves.flatMap(l=>[l.anchor,add(l.anchor,scale(l.direction,r.leafSizeMeters*l.sizeScale))]),...flowers.map(f=>f.anchor)];
  const pad=Math.max(r.leafSizeMeters*.65,r.flowers.sizeMeters*.6)+r.trunkRadiusMeters*(1+r.rootFlare),min=[0,0,0].map((_,i)=>Math.min(...points.map(p=>p[i]))-pad) as Vec,max=[0,0,0].map((_,i)=>Math.max(...points.map(p=>p[i]))+pad) as Vec;
  return{recipe:r,branches,leaves,flowers,bounds:{min,max},diagnostics:{branches:branches.length,leaves:leaves.length,proposedLeaves:candidates.length,flowers:flowers.length,proposedFlowers:bloomCandidates.length,qualityThinning:candidates.length>budget,warnings:[...(candidates.length>budget?['Quality budget thinned the leaf proposals deterministically.']:[]),...(bloomCandidates.length>bloomBudget?['Quality budget thinned bloom proposals.']:[])]}};
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
