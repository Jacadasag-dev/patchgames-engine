import {compileGenerationMaps, generationDataRevision, type GenerationMapRecipe} from './generationMaps.ts';

export type PlanetVector = readonly [number, number, number];
export interface PlanetTile {face:number; level:number; x:number; y:number}
export interface PlanetColors {ocean:string; lowland:string; highland:string; snow:string}
export interface PlanetRecipe {
  kind:'planet'; version:1; seed:number; radiusMeters:number;
  segments?:number; maxLevel?:number; seaLevelMeters?:number;
  surface:{maps:GenerationMapRecipe; height:string}; colors?:Partial<PlanetColors>;
}
export interface ResolvedPlanetRecipe extends Omit<PlanetRecipe, 'segments'|'maxLevel'|'seaLevelMeters'|'colors'> {
  segments:number; maxLevel:number; seaLevelMeters:number; colors:PlanetColors;
}
export interface PlanetSample {heightMeters:number; position:PlanetVector; normal:PlanetVector; color:PlanetVector}
export interface PlanetPatchData {
  key:string; tile:PlanetTile; revision:string; origin:PlanetVector;
  positions:Float32Array; normals:Float32Array; colors:Float32Array; indices:Uint16Array;
  /** Optional worker-prepared metre UVs and bounded terrain material groups. */
  uvs?:Float32Array;groups?:{start:number;count:number;materialIndex:number}[];
  byteLength:number; surfaceTriangles:number; skirtTriangles:number;
  bounds:{center:PlanetVector; radius:number};
}
export interface CompiledPlanet {
  readonly recipe:ResolvedPlanetRecipe; readonly revision:string;
  readonly radius:number; readonly minHeight:number; readonly maxHeight:number;
  sample(direction:PlanetVector):PlanetSample;
  patch(tile:PlanetTile):PlanetPatchData;
}
export const PLANET_LIMITS = Object.freeze({
  minRadiusMeters:1000, maxRadiusMeters:100_000_000, maxLevel:24,
  maxSegments:32, maxPatchSamplingCost:2_000_000,
});
const DEFAULT_COLORS:PlanetColors = {ocean:'#123f62',lowland:'#53804b',highland:'#88745a',snow:'#e4ebe9'};
type Vec = [number, number, number];
const add = (a:PlanetVector,b:PlanetVector):Vec => [a[0]+b[0],a[1]+b[1],a[2]+b[2]];
const sub = (a:PlanetVector,b:PlanetVector):Vec => [a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const scale = (a:PlanetVector,n:number):Vec => [a[0]*n,a[1]*n,a[2]*n];
const dot = (a:PlanetVector,b:PlanetVector) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross = (a:PlanetVector,b:PlanetVector):Vec => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const normalize = (a:PlanetVector):Vec => scale(a,1/Math.hypot(...a));
const clamp = (n:number,min:number,max:number) => Math.max(min,Math.min(max,n));
function number(input:unknown,name:string,min:number,max:number,integer=false):number {
  if(typeof input!=='number'||!Number.isFinite(input)||input<min||input>max||integer&&!Number.isInteger(input))
    throw Error('Planet '+name+' must be '+(integer?'an integer':'finite')+' in ['+min+', '+max+'].');
  return input;
}
function plain(input:unknown,keys:readonly string[],name:string):Record<string,unknown> {
  if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))
    throw Error('Planet '+name+' requires supported plain data.');
  if(Object.getOwnPropertySymbols(input).length)throw Error('Planet '+name+' does not allow symbol fields.');
  for(const key of Object.getOwnPropertyNames(input)) {
    const descriptor=Object.getOwnPropertyDescriptor(input,key);
    if(!keys.includes(key)||!descriptor||!('value'in descriptor)||!descriptor.enumerable)
      throw Error('Planet '+name+' has an unsupported field or accessor: '+key+'.');
  }
  return input as Record<string,unknown>;
}
function freeze<T>(input:T):T {
  if(input&&typeof input==='object'){for(const child of Object.values(input))freeze(child);Object.freeze(input);}
  return input;
}
function direction(input:PlanetVector):Vec {
  if(!Array.isArray(input)||input.length!==3||!input.every(v=>typeof v==='number'&&Number.isFinite(v)))
    throw Error('Planet direction requires three finite coordinates.');
  const magnitude=Math.hypot(...input);
  if(!Number.isFinite(magnitude)||magnitude<1e-20)throw Error('Planet direction must be nonzero and bounded.');
  return scale(input,1/magnitude);
}
function validateTile(tile:PlanetTile,maxLevel:number=PLANET_LIMITS.maxLevel):void {
  const data=plain(tile,['face','level','x','y'],'tile');
  number(data.face,'tile face',0,5,true);const level=number(data.level,'tile level',0,maxLevel,true),width=2**level;
  number(data.x,'tile x',0,width-1,true);number(data.y,'tile y',0,width-1,true);
}
export function planetTileKey(tile:PlanetTile):string {
  validateTile(tile);return tile.face+'/'+tile.level+'/'+tile.x+'/'+tile.y;
}
export function planetTileChildren(tile:PlanetTile):readonly PlanetTile[] {
  validateTile(tile);
  if(tile.level>=PLANET_LIMITS.maxLevel)throw Error('Planet tile is already at the maximum level.');
  return [0,1,2,3].map(i=>({face:tile.face,level:tile.level+1,x:tile.x*2+(i&1),y:tile.y*2+(i>>1)}));
}
/** Cube coordinates u/v are in [-1,1]. Every face basis has U×V pointing out. */
export function planetDirection(face:number,u:number,v:number):PlanetVector {
  number(face,'face',0,5,true);number(u,'cube u',-1,1);number(v,'cube v',-1,1);
  const cube:Vec = face===0?[1,v,-u]:face===1?[-1,v,u]:face===2?[u,1,-v]
    :face===3?[u,-1,v]:face===4?[u,v,1]:[-u,v,-1];
  return normalize(cube);
}
/** Inverse cube coordinates. Edge/corner ties choose X, then Y, then Z, so
 * callers can use one canonical source tile without losing the shared seam. */
export function planetCoordinates(input:PlanetVector):{face:number;u:number;v:number} {
  const [x,y,z]=direction(input),ax=Math.abs(x),ay=Math.abs(y),az=Math.abs(z);
  if(ax>=ay&&ax>=az)return x>=0?{face:0,u:-z/ax,v:y/ax}:{face:1,u:z/ax,v:y/ax};
  if(ay>=az)return y>=0?{face:2,u:x/ay,v:-z/ay}:{face:3,u:x/ay,v:z/ay};
  return z>=0?{face:4,u:x/az,v:y/az}:{face:5,u:-x/az,v:y/az};
}
/** Conservative surface envelope. Baked bounds separately include the skirts. */
export function planetTileBounds(tile:PlanetTile,radius:number,minHeight=0,maxHeight=0):{
  center:PlanetVector;radius:number;angularRadius:number;
} {
  validateTile(tile);number(radius,'radius',PLANET_LIMITS.minRadiusMeters,PLANET_LIMITS.maxRadiusMeters);
  number(minHeight,'minimum height',-radius*.1,radius*.1);number(maxHeight,'maximum height',minHeight,radius*.1);
  const width=2**tile.level,u=-1+2*(tile.x+.5)/width,v=-1+2*(tile.y+.5)/width;
  const centerDirection=planetDirection(tile.face,u,v),half=1/width;
  let angle=0;
  for(const du of [-half,half])for(const dv of [-half,half]){
    const corner=planetDirection(tile.face,u+du,v+dv);
    angle=Math.max(angle,Math.atan2(Math.hypot(...cross(centerDirection,corner)),dot(centerDirection,corner)));
  }
  // On a cube rectangle the smallest dot with its middle ray is at a corner.
  const angularRadius=Math.min(Math.PI/2,angle+1e-12),mid=radius+(minHeight+maxHeight)/2;
  return {center:scale(centerDirection,mid),radius:(radius+maxHeight)*2*Math.sin(angularRadius/2)+(maxHeight-minHeight)/2,angularRadius};
}
function linearColor(hex:string):Vec {
  return [1,3,5].map(i=>{const v=parseInt(hex.slice(i,i+2),16)/255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}) as Vec;
}
function mix(a:PlanetVector,b:PlanetVector,t:number):Vec {return add(scale(a,1-t),scale(b,t));}

/** A serializable example using the same shared fields as ordinary generators. */
export function createPlanetRecipe(seed=42,radiusMeters=6_371_000):PlanetRecipe {
  const heightScale=radiusMeters/6_371_000,scaleMeters=Math.min(1_000_000,radiusMeters*.12);
  return {kind:'planet',version:1,seed,radiusMeters,segments:16,maxLevel:20,seaLevelMeters:0,surface:{height:'height',maps:{
    kind:'generation-maps',version:1,seed,maps:{
      continents:{type:'noise',space:'world',scaleMeters,octaves:3},
      base:{type:'remap',input:'continents',from:[.22,.78],to:[-5000*heightScale,4500*heightScale],unit:'metres'},
      mountainMask:{type:'remap',input:'continents',from:[.5,.72],to:[0,1],unit:'normalized'},
      ridges:{type:'noise',space:'world',scaleMeters:scaleMeters*.12,octaves:4,ridged:true},
      ridgeHeight:{type:'remap',input:'ridges',from:[0,1],to:[0,3500*heightScale],unit:'metres'},
      mountains:{type:'multiply',inputs:['ridgeHeight','mountainMask']},
      hills:{type:'noise',space:'world',scaleMeters:Math.max(1,scaleMeters*.008),octaves:4},
      hillHeight:{type:'remap',input:'hills',from:[0,1],to:[-140*heightScale,140*heightScale],unit:'metres'},
      height:{type:'add',inputs:[{map:'base'},{map:'mountains'},{map:'hillHeight'}]},
    },
  }}};
}

/** Planet-centred double precision is authoritative. No renderer or planar
 * physics is implied; views consume locally rebased Float32 patch positions. */
export function compilePlanet(input:PlanetRecipe):CompiledPlanet {
  const data=plain(input,['kind','version','seed','radiusMeters','segments','maxLevel','seaLevelMeters','surface','colors'],'recipe');
  if(data.kind!=='planet'||data.version!==1)throw Error('Use kind:planet, version:1.');
  const seed=number(data.seed,'seed',-2147483648,2147483647,true);
  const radius=number(data.radiusMeters,'radius',PLANET_LIMITS.minRadiusMeters,PLANET_LIMITS.maxRadiusMeters);
  const segments=number(data.segments??16,'segments',4,PLANET_LIMITS.maxSegments,true);
  if((segments&(segments-1))!==0)throw Error('Planet segments must be a power of two.');
  const maxLevel=number(data.maxLevel??20,'maximum level',0,PLANET_LIMITS.maxLevel,true);
  const seaLevelMeters=number(data.seaLevelMeters??0,'sea level',-radius*.1,radius*.1);
  const surface=plain(data.surface,['maps','height'],'surface');
  if(typeof surface.height!=='string'||!surface.height.length)throw Error('Planet surface requires a height map ID.');
  const maps=compileGenerationMaps(surface.maps),output=maps.output(surface.height);
  if(output.unit!=='metres'||output.dynamic||output.scopes.length||output.spaces.some(space=>space!=='world'))
    throw Error('Planet height requires a static world-space metre map without object identities.');
  if(((segments+1)**2*5+1)*output.cost>PLANET_LIMITS.maxPatchSamplingCost)
    throw Error('Planet patch sampling budget exceeded; reduce segments or height-map cost.');
  const minHeight=number(output.range[0],'minimum height',-radius*.1,radius*.1);
  const maxHeight=number(output.range[1],'maximum height',minHeight,radius*.1);
  const colorData=data.colors===undefined?{}:plain(data.colors,Object.keys(DEFAULT_COLORS),'colors');
  const colors={...DEFAULT_COLORS,...colorData} as PlanetColors;
  for(const value of Object.values(colors))if(typeof value!=='string'||!/^#[a-f0-9]{6}$/i.test(value))
    throw Error('Planet colors require six-digit hexadecimal RGB strings.');
  const recipe=freeze({kind:'planet',version:1,seed,radiusMeters:radius,segments,maxLevel,seaLevelMeters,
    colors,surface:{maps:maps.recipe,height:surface.height}} satisfies ResolvedPlanetRecipe);
  const revision=generationDataRevision(recipe),palette=Object.fromEntries(Object.entries(colors).map(([key,value])=>[key,linearColor(value)])) as Record<keyof PlanetColors,Vec>;
  const height=(unit:PlanetVector)=>maps.sample(recipe.surface.height,{world:scale(unit,radius)});
  const point=(unit:PlanetVector)=>scale(unit,radius+height(unit));
  const sample=(inputDirection:PlanetVector):PlanetSample=>{
    const unit=direction(inputDirection),heightMeters=height(unit),position=scale(unit,radius+heightMeters);
    // The tangent frame depends only on the absolute direction, never the face
    // or LOD. Normals agree across adjacent faces and between parent/child tiles.
    const tangent=normalize(cross(Math.abs(unit[1])<.9?[0,1,0]:[1,0,0],unit));
    const bitangent=cross(unit,tangent),epsilon=Math.max(.5,radius*1e-8)/radius;
    const delta=(axis:PlanetVector)=>sub(point(normalize(add(unit,scale(axis,epsilon)))),point(normalize(add(unit,scale(axis,-epsilon)))));
    let normal=normalize(cross(delta(tangent),delta(bitangent)));
    if(!normal.every(Number.isFinite)||dot(normal,unit)<=0)normal=unit;
    const span=Math.max(1,maxHeight-seaLevelMeters),altitude=clamp((heightMeters-seaLevelMeters)/span,0,1);
    const base=heightMeters<=seaLevelMeters?palette.ocean:mix(palette.lowland,palette.highland,clamp(altitude*1.5,0,1));
    const snow=heightMeters<=seaLevelMeters?0:clamp(Math.max((altitude-.65)/.35,(Math.abs(unit[1])-.82)/.18),0,1);
    return {heightMeters,position,normal,color:mix(base,palette.snow,snow)};
  };
  const patch=(tileInput:PlanetTile):PlanetPatchData=>{
    validateTile(tileInput,maxLevel);const tile={...tileInput},key=planetTileKey(tile),width=2**tile.level;
    const u0=-1+2*tile.x/width,v0=-1+2*tile.y/width,tileWidth=2/width;
    const middle=planetDirection(tile.face,u0+tileWidth/2,v0+tileWidth/2),origin=point(middle);
    const grid=(segments+1)**2,perimeter=segments*4,vertices=grid+perimeter;
    const positions=new Float32Array(vertices*3),normals=new Float32Array(vertices*3),colorArray=new Float32Array(vertices*3);
    const surfaceTriangles=segments*segments*2,skirtTriangles=perimeter*2,indices=new Uint16Array((surfaceTriangles+skirtTriangles)*3);
    const units:PlanetVector[]=new Array(grid);let bound=0,indexCursor=0;
    const put=(index:number,position:PlanetVector,normal:PlanetVector,color:PlanetVector)=>{
      const local=sub(position,origin);positions.set(local,index*3);normals.set(normal,index*3);colorArray.set(color,index*3);
      bound=Math.max(bound,Math.hypot(...local));
    };
    for(let y=0;y<=segments;y++)for(let x=0;x<=segments;x++) {
      const index=y*(segments+1)+x,unit=planetDirection(tile.face,u0+tileWidth*x/segments,v0+tileWidth*y/segments),p=sample(unit);
      units[index]=unit;put(index,p.position,p.normal,p.color);
      if(x<segments&&y<segments){const a=index,b=a+1,c=a+segments+1,d=c+1;indices.set([a,b,c,b,d,c],indexCursor);indexCursor+=6;}
    }
    // A lower-detail edge can lie below the finer surface by the full declared
    // height range plus its spherical chord sag. Skirts bridge that depth while
    // retaining identical source samples wherever edge vertices coincide.
    const sag=(radius+maxHeight)*(1-Math.cos(Math.min(Math.PI/2,Math.SQRT2*tileWidth/segments)));
    const skirtDepth=(maxHeight-minHeight)+sag+1;
    const edge:number[]=[];
    for(let x=0;x<segments;x++)edge.push(x);
    for(let y=0;y<segments;y++)edge.push(y*(segments+1)+segments);
    for(let x=segments;x>0;x--)edge.push(segments*(segments+1)+x);
    for(let y=segments;y>0;y--)edge.push(y*(segments+1));
    for(let i=0;i<perimeter;i++) {
      const source=edge[i],bottom=grid+i,unit=units[source],sourcePosition=add(origin,Array.from(positions.subarray(source*3,source*3+3)) as Vec);
      put(bottom,sub(sourcePosition,scale(unit,skirtDepth)),Array.from(normals.subarray(source*3,source*3+3)) as Vec,Array.from(colorArray.subarray(source*3,source*3+3)) as Vec);
      const next=(i+1)%perimeter;indices.set([source,bottom,edge[next],edge[next],bottom,grid+next],indexCursor);indexCursor+=6;
    }
    return {key,tile,revision,origin,positions,normals,colors:colorArray,indices,
      byteLength:positions.byteLength+normals.byteLength+colorArray.byteLength+indices.byteLength,
      surfaceTriangles,skirtTriangles,bounds:{center:origin,radius:bound+Math.max(1e-5,bound*2e-7)}};
  };
  return Object.freeze({recipe,revision,radius,minHeight,maxHeight,sample,patch});
}
