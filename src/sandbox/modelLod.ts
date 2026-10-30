import {BufferGeometry,CylinderGeometry,SphereGeometry} from 'three';
import {registerGeneratedGeometryLod} from './generatedLod.ts';

export interface PreparedModelPrimitiveLod<G extends BufferGeometry=BufferGeometry> {
  /** Original full-detail geometry. Render-boundary selection is temporary. */
  readonly geometry:G;
  readonly levels:readonly {readonly geometry:G;readonly error:number}[];
  /** Owns the source and every prepared lower-detail geometry. Idempotent. */
  dispose():void;
}
const triangles=(geometry:BufferGeometry)=>(geometry.index?.count??geometry.getAttribute('position').count)/3;

function prepare<G extends BufferGeometry>(make:(level:number)=>{geometry:G;error:number},configure?: (geometry:G)=>void):PreparedModelPrimitiveLod<G>{
  const levels:{geometry:G;error:number}[]=[];
  let release:(()=>void)|undefined;
  try{
    for(let level=0;level<3;level++){
      const value=make(level);try{configure?.(value.geometry);value.geometry.computeBoundingSphere();}catch(error){value.geometry.dispose();throw error;}
      if(level&&triangles(value.geometry)>=triangles(levels.at(-1)!.geometry)){value.geometry.dispose();continue;}
      levels.push(value);
    }
    const geometry=levels[0].geometry;
    if(levels.length>1)release=registerGeneratedGeometryLod(geometry,levels);
    geometry.userData.generatedModelLod={version:1,levels:levels.map(value=>({triangles:triangles(value.geometry),error:value.error}))};
    let disposed=false;
    return{geometry,levels:Object.freeze(levels.map(value=>Object.freeze(value))),dispose(){
      if(disposed)return;disposed=true;release?.();for(const value of levels)value.geometry.dispose();
    }};
  }catch(error){release?.();for(const value of levels)value.geometry.dispose();throw error;}
}
function segments(value:number,name:string,minimum:number){
  if(!Number.isInteger(value)||value<minimum||value>128)throw Error('Model LOD: '+name+' must be an integer in '+minimum+'..128.');
  return value;
}
function dimension(value:number,name:string){if(!Number.isFinite(value)||value<=0||value>128)throw Error('Model LOD: '+name+' must be finite in (0,128].');return value;}

/** Regenerate the same analytic sphere, preserving centre, axes and UV seam.
 * Configure every tier with the same metric-UV operation during preparation.
 * No arbitrary mesh decimation, part removal or bone-weight rewriting occurs. */
export function prepareModelSphereLod(radius:number,widthSegments=24,heightSegments=16,configure?:(geometry:SphereGeometry)=>void):PreparedModelPrimitiveLod<SphereGeometry>{
  dimension(radius,'radius');segments(widthSegments,'sphere width',6);segments(heightSegments,'sphere height',4);
  if((widthSegments+1)*(heightSegments+1)>20000)throw Error('Model LOD: primitive vertex budget exceeded.');
  return prepare(level=>{
    const width=Math.max(6,Math.floor(widthSegments/2**level)),height=Math.max(4,Math.floor(heightSegments/2**level));
    return{geometry:new SphereGeometry(radius,width,height),error:level?(1-Math.cos(Math.PI/width))+(1-Math.cos(Math.PI/(2*height))):0};
  },configure);
}

/** Analytic upright cylinder tiers. The caps, side UV seam and height remain
 * intact; all tiers are built once, before entering the render loop. */
export function prepareModelCylinderLod(radius:number,height:number,radialSegments=20,configure?:(geometry:CylinderGeometry)=>void):PreparedModelPrimitiveLod<CylinderGeometry>{
  dimension(radius,'radius');dimension(height,'height');segments(radialSegments,'cylinder radial segments',6);
  return prepare(level=>{
    const radial=Math.max(6,Math.floor(radialSegments/2**level));
    return{geometry:new CylinderGeometry(radius,radius,height,radial),error:level?(1-Math.cos(Math.PI/radial))*radius/Math.hypot(radius,height/2):0};
  },configure);
}
