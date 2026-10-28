/** Bounded presentation of terrain contacts. These meshes have no liquid mass,
 * never alter a head/footprint, and disappear when accepted flow/contact ends. */
import {BufferAttribute,BufferGeometry,Color,DoubleSide,DynamicDrawUsage,Group,Mesh,MeshPhysicalMaterial,ShaderMaterial} from 'three';
import type {WaterBodyManifest,WaterBodyState} from './waterBody.ts';
import type {WaterBodySurfaceBuffers} from './waterBodyView.ts';
import type {PhysicsScene} from './physics.ts';
import {waterBodyCells} from './waterBodyCells.ts';
import {collideLiquidGround,liquidGrounds} from './liquidCollision.ts';
import type {WaterDetailEvent} from './waterDetail.ts';
import {buildWaterFlightMesh} from './waterFlightMesh.ts';
import type {WaterFlightSourceConnection} from './waterFlightMesh.ts';
import {WATER_CURRENT_GLSL} from './waterCurrentShader.ts';
import {WATER_SURFACE_OPTICS_GLSL,WaterFlowAdvectionClock,waterSurfaceWaveTone} from './waterSurfaceOptics.ts';
import {createWaterDetailSolidQuery} from './waterDetailView.ts';
import {buildWaterImpactPlumes,waterImpactLifetime,WATER_IMPACT_LIMITS} from './waterImpactPlumes.ts';

export type WaterTerrainEffectsQuality='off'|'low'|'high';
export interface WaterTerrainEffectsOptions {quality?:WaterTerrainEffectsQuality;color?:string;shallowColor?:string;shallowDepth?:number;edgeOpacity?:number;flowStrength?:number;waveContrast?:number;waveNormalStrength?:number;foamColor?:string;
  /** Shared physical appearance; textures are borrowed, never disposed here.
   * A depthWrite-only stub remains sufficient for headless callers. */surfaceMaterial?:{depthWrite:boolean}&Partial<MeshPhysicalMaterial>}
export interface WaterTerrainEffectsBuffers {positions:Float32Array;normals:Float32Array;uvs:Float32Array;activity:Float32Array;optics:Float32Array;shoreBands:number;falls:number}
const budgets={off:{shore:0,falls:0},low:{shore:384,falls:48},high:{shore:1024,falls:128}};
export const WATER_TERRAIN_FALL_SEGMENTS=64;
const clamp=(v:number)=>Math.max(0,Math.min(1,v));
const smooth=(v:number)=>{const t=clamp(v);return t*t*(3-2*t);};
type Point={x:number;y:number;z:number};

/** Index the accepted top triangles once. Attached lips query only their
 * neighboring control cells and the nearest upstream border; no all-surface
 * scan, synthetic head extrapolation, or support/physics changes. */
export function createWaterSourceSurfaceSampler(w:WaterBodyManifest,surface:WaterBodySurfaceBuffers,sourceStyle:Pick<WaterTerrainEffectsOptions,'waveContrast'|'waveNormalStrength'>={}) {
  const p=surface.positions,n=surface.normals,bins=new Map<number,number[]>(),columns=w.columns,rows=w.rows;
  for(let at=0;at<p.length;at+=9){if(n[at+1]+n[at+4]+n[at+7]<=.3)continue;
    const area=(p[at+5]-p[at+8])*(p[at]-p[at+6])+(p[at+6]-p[at+3])*(p[at+2]-p[at+8]);if(Math.abs(area)<1e-18)continue;
    const minX=Math.max(0,Math.floor((Math.min(p[at],p[at+3],p[at+6])-w.origin.x)/w.cellSizeX)),maxX=Math.min(columns-1,Math.floor((Math.max(p[at],p[at+3],p[at+6])-w.origin.x)/w.cellSizeX));
    const minZ=Math.max(0,Math.floor((Math.min(p[at+2],p[at+5],p[at+8])-w.origin.z)/w.cellSizeZ)),maxZ=Math.min(rows-1,Math.floor((Math.max(p[at+2],p[at+5],p[at+8])-w.origin.z)/w.cellSizeZ));
    for(let x=minX;x<=maxX;x++)for(let z=minZ;z<=maxZ;z++){const cell=x*rows+z;if(!bins.has(cell))bins.set(cell,[]);bins.get(cell)!.push(at);}
  }
  // A join queries only a local aperture neighborhood. Exhausting either bound
  // rejects the join; it never substitutes nearest-height or dry extrapolation.
  const candidates=(minX:number,maxX:number,minZ:number,maxZ:number):number[]|undefined=>{
    const x0=Math.max(0,Math.floor((minX-w.origin.x)/w.cellSizeX)),x1=Math.min(columns-1,Math.floor((maxX-w.origin.x)/w.cellSizeX)),z0=Math.max(0,Math.floor((minZ-w.origin.z)/w.cellSizeZ)),z1=Math.min(rows-1,Math.floor((maxZ-w.origin.z)/w.cellSizeZ));
    if((x1-x0+1)*(z1-z0+1)>64)return;const found=new Set<number>();
    for(let x=x0;x<=x1;x++)for(let z=z0;z<=z1;z++)for(const at of bins.get(x*rows+z)??[]){found.add(at);if(found.size>512)return;}return[...found];
  };
  const query=(point:Point,flow:Point,maxProbe:number):{height:number;normal:Point;tone:number;point:Point;triangle:number}|undefined=>{
    const speed=Math.hypot(flow.x,flow.z);if(!(speed>0))return;
    const ux=-flow.x/speed,uz=-flow.z/speed;
    let bestDistance=Infinity,bestHeightDistance=Infinity,result:{height:number;normal:Point;tone:number;point:Point;triangle:number}|undefined;
    const tolerance=1e-6,positionTolerance=Math.min(w.cellSizeX,w.cellSizeZ)*tolerance;
    const nearby=candidates(Math.min(point.x,point.x+ux*maxProbe)-positionTolerance,Math.max(point.x,point.x+ux*maxProbe)+positionTolerance,Math.min(point.z,point.z+uz*maxProbe)-positionTolerance,Math.max(point.z,point.z+uz*maxProbe)+positionTolerance);if(!nearby)return;
    for(const at of nearby){
      const ax=p[at],az=p[at+2],bx=p[at+3],bz=p[at+5],dx=p[at+6],dz=p[at+8],den=(bz-dz)*(ax-dx)+(dx-bx)*(az-dz);
      const a=((bz-dz)*(point.x-dx)+(dx-bx)*(point.z-dz))/den,b=((dz-az)*(point.x-dx)+(ax-dx)*(point.z-dz))/den;
      const da=((bz-dz)*ux+(dx-bx)*uz)/den,db=((dz-az)*ux+(ax-dx)*uz)/den;
      const values=[a,b,1-a-b],rates=[da,db,-da-db];let low=0,high=maxProbe;
      for(let k=0;k<3;k++){if(rates[k]>0)low=Math.max(low,(-tolerance-values[k])/rates[k]);else if(rates[k]<0)high=Math.min(high,(-tolerance-values[k])/rates[k]);else if(values[k]<-tolerance){high=-1;break;}}
      if(low>high||low>bestDistance+positionTolerance)continue;
      const flow=surface.flowData,vertex=at/3;if(flow){const depth=values[0]*flow[vertex*4+3]+values[1]*flow[(vertex+1)*4+3]+values[2]*flow[(vertex+2)*4+3],rate=rates[0]*flow[vertex*4+3]+rates[1]*flow[(vertex+1)*4+3]+rates[2]*flow[(vertex+2)*4+3];if(depth+rate*low<=0){if(!(rate>0))continue;const wetStart=Math.max(low,-depth/rate);if(!(wetStart<high))continue;low=wetStart+Math.min(positionTolerance,(high-wetStart)*.5);}}
      if(low>bestDistance+positionTolerance)continue;
      const weights=values.map((v,k)=>Math.max(0,v+rates[k]*low)),sum=weights[0]+weights[1]+weights[2];for(let k=0;k<3;k++)weights[k]/=sum;
      if(flow&&weights[0]*flow[vertex*4+3]+weights[1]*flow[(vertex+1)*4+3]+weights[2]*flow[(vertex+2)*4+3]<=0)continue;
      const height=weights[0]*p[at+1]+weights[1]*p[at+4]+weights[2]*p[at+7],heightDistance=Math.abs(height-point.y);
      if(low>=bestDistance-positionTolerance&&heightDistance>=bestHeightDistance)continue;
      const normal={x:weights[0]*n[at]+weights[1]*n[at+3]+weights[2]*n[at+6],y:weights[0]*n[at+1]+weights[1]*n[at+4]+weights[2]*n[at+7],z:weights[0]*n[at+2]+weights[1]*n[at+5]+weights[2]*n[at+8]},length=Math.hypot(normal.x,normal.y,normal.z);if(!(length>0))continue;
      const tone=waterSurfaceWaveTone(normal,sourceStyle.waveContrast,sourceStyle.waveNormalStrength);normal.x/=length;normal.y/=length;normal.z/=length;result={height,normal,tone,point:{x:weights[0]*ax+weights[1]*bx+weights[2]*dx,y:height,z:weights[0]*az+weights[1]*bz+weights[2]*dz},triangle:at};bestDistance=low;bestHeightDistance=heightDistance;
    }
    return result;
  };
  const sample=(point:Point,flow:Point)=>{const hit=query(point,flow,Math.min(w.cellSizeX,w.cellSizeZ)*.5);return hit?{height:hit.height,normal:hit.normal,tone:hit.tone}:undefined;};
  const connect:WaterFlightSourceConnection=(a,b)=>{
    if(!surface.flowData||!Number.isFinite(a.maxOffset)||!Number.isFinite(b.maxOffset)||a.maxOffset<0||b.maxOffset<0)return;
    const first=query(a.point,a.flow,a.maxOffset),last=query(b.point,b.flow,b.maxOffset);if(!first||!last)return;
    const from=first.point,to=last.point,dx=to.x-from.x,dz=to.z-from.z,length=Math.hypot(dx,dz),epsilon=Math.max(1,Math.abs(from.x),Math.abs(from.y),Math.abs(from.z),Math.abs(to.x),Math.abs(to.y),Math.abs(to.z))*2e-7;
    if(length<=epsilon)return Math.abs(from.y-to.y)<=epsilon?[from,to]:undefined;
    const nearby=candidates(Math.min(from.x,to.x)-epsilon,Math.max(from.x,to.x)+epsilon,Math.min(from.z,to.z)-epsilon,Math.max(from.z,to.z)+epsilon);if(!nearby)return;
    type Span={at:number;low:number;high:number;y:number;dy:number;depth:number;dDepth:number};const spans:Span[]=[],timeTolerance=Math.min(1e-5,epsilon/length);
    for(const at of nearby){const ax=p[at],az=p[at+2],bx=p[at+3],bz=p[at+5],cx=p[at+6],cz=p[at+8],den=(bz-cz)*(ax-cx)+(cx-bx)*(az-cz),u=((bz-cz)*(from.x-cx)+(cx-bx)*(from.z-cz))/den,v=((cz-az)*(from.x-cx)+(ax-cx)*(from.z-cz))/den,du=((bz-cz)*dx+(cx-bx)*dz)/den,dv=((cz-az)*dx+(ax-cx)*dz)/den;
      const values=[u,v,1-u-v],rates=[du,dv,-du-dv];let low=0,high=1;
      for(let k=0;k<3;k++){
        // A projected source can lie one double-precision ulp outside a shared
        // Float32 edge. Do not divide that roundoff by an almost-parallel ray
        // and turn a continuous boundary into an empty interval.
        const roundoff=64*Number.EPSILON*Math.max(1,Math.abs(values[k]),Math.abs(rates[k]));if(values[k]>=-roundoff&&values[k]+rates[k]>=-roundoff)continue;
        if(rates[k]>0)low=Math.max(low,-values[k]/rates[k]);else if(rates[k]<0)high=Math.min(high,-values[k]/rates[k]);else{high=-1;break;}
      }
      if(low>high+timeTolerance)continue;const vertex=at/3,f=surface.flowData,depth=values[0]*f[vertex*4+3]+values[1]*f[(vertex+1)*4+3]+values[2]*f[(vertex+2)*4+3],dDepth=rates[0]*f[vertex*4+3]+rates[1]*f[(vertex+1)*4+3]+rates[2]*f[(vertex+2)*4+3];
      if(dDepth>0)low=Math.max(low,-depth/dDepth);else if(dDepth<0)high=Math.min(high,-depth/dDepth);if(low>high||depth+dDepth*(low+high)*.5<=0)continue;
      spans.push({at,low:Math.max(0,low),high:Math.min(1,high),y:values[0]*p[at+1]+values[1]*p[at+4]+values[2]*p[at+7],dy:rates[0]*p[at+1]+rates[1]*p[at+4]+rates[2]*p[at+7],depth,dDepth});
    }
    const start=spans.findIndex(s=>s.at===first.triangle&&s.low<=timeTolerance),end=spans.findIndex(s=>s.at===last.triangle&&s.high>=1-timeTolerance);if(start<0||end<0)return;
    // Walk the straight XZ segment on its actual piecewise surface. Unlike a
    // head-to-head chord this follows curved wet lips without cutting terrain.
    const entered=new Float64Array(spans.length).fill(Infinity),parent=new Int32Array(spans.length).fill(-1),queue=[start];entered[start]=0;let reached=-1,work=0;
    for(let q=0;q<queue.length;q++){const i=queue[q],s=spans[i];if(i===end){reached=i;break;}if(q>=512)return;
      for(let j=0;j<spans.length;j++){if(++work>8192)return;if(j===i)continue;const next=spans[j],low=Math.max(entered[i],s.low,next.low),high=Math.min(s.high,next.high);if(low>high+timeTolerance||next.high<=entered[i]+timeTolerance)continue;
        const delta=s.y-next.y,slope=s.dy-next.dy;let t=Math.min(high,Math.max(low,slope===0?low:-delta/slope));if(low>high)t=(low+high)*.5;t=Math.max(entered[i],t);
        if(Math.abs(delta+slope*t)>epsilon||s.depth+s.dDepth*t<=0||next.depth+next.dDepth*t<=0||t>=entered[j])continue;
        entered[j]=Math.max(0,t);parent[j]=i;queue.push(j);
      }
    }
    if(reached<0)return;const route:number[]=[];for(let i=reached;i>=0;i=parent[i]){route.push(i);if(route.length>63)return;}route.reverse();const path:Point[]=[from];
    for(let k=1;k<route.length;k++){const s=spans[route[k]],t=entered[route[k]],previous=path[path.length-1],point={x:from.x+dx*t,y:s.y+s.dy*t,z:from.z+dz*t};if(Math.hypot(point.x-previous.x,point.y-previous.y,point.z-previous.z)>epsilon)path.push(point);}
    path.push(to);return path.length<=64?path:undefined;
  };
  // Only the original adjacent-control neighborhood broadens candidate lookup;
  // every accepted join still needs complete wet coverage and native clearance.
  return Object.assign(sample,{connect:Object.assign(connect,{maxDistance:Math.hypot(w.cellSizeX,w.cellSizeZ)})});
}

/** Pure geometry, deterministic for an accepted state. Shore bands stay on the
 * wet side of displayed contacts; fall strips require real downhill current. */
export function buildWaterTerrainEffects(w:WaterBodyManifest,s:WaterBodyState,surface:WaterBodySurfaceBuffers,terrain:(x:number,z:number)=>number,quality:WaterTerrainEffectsQuality='high',detail:readonly WaterDetailEvent[]=[],blocked?:(from:Point,to:Point)=>boolean,weights?:ReadonlyMap<string,number>,sourceStyle:Pick<WaterTerrainEffectsOptions,'waveContrast'|'waveNormalStrength'>={}):WaterTerrainEffectsBuffers {
  const budget=budgets[quality];if(!budget)throw new Error('Invalid terrain water detail quality');
  const positions:number[]=[],normals:number[]=[],uvs:number[]=[],activity:number[]=[],optics:number[]=[];let shoreBands=0,falls=0,fallSegments=0;
  const quad=(a:Point,b:Point,c:Point,d:Point,kind:number,speed:number,strength:number,from=0,to=1,sourceDepth=0,opacity=1)=>{
    if(kind===1){if(fallSegments+1>budget.falls*WATER_TERRAIN_FALL_SEGMENTS)return false;fallSegments++;}
    const width0=Math.hypot(b.x-a.x,b.y-a.y,b.z-a.z),width1=Math.hypot(d.x-c.x,d.y-c.y,d.z-c.z);
    // Falling patterns repeat in metres, independently of sheet height or
    // subdivision count. Shore bands retain their normalized wet-side fade.
    const ex=b.x-a.x,ey=b.y-a.y,ez=b.z-a.z,fx=c.x-a.x,fy=c.y-a.y,fz=c.z-a.z,nx=ey*fz-ez*fy,ny=ez*fx-ex*fz,nz=ex*fy-ey*fx,n=Math.hypot(nx,ny,nz)||1;
    for(const [p,u,v] of [[a,0,from],[b,1,from],[c,0,to],[c,0,to],[b,1,from],[d,1,to]] as const){positions.push(p.x,p.y,p.z);normals.push(kind?nx/n:0,kind?ny/n:0,kind?nz/n:0);uvs.push(kind?u*(v===from?width0:width1):u,kind?-p.y:v);activity.push(kind,speed,kind===1?1:strength);optics.push(sourceDepth,opacity);}return true;
  };
  if(budget.shore&&surface.flowData){const p=surface.positions,f=surface.flowData,n=surface.normals;
    for(let at=0;at<p.length&&shoreBands<budget.shore;at+=9){const first=at/3;if(n[at+1]+n[at+4]+n[at+7]<.3)continue;
      const depths=[f[first*4+3],f[(first+1)*4+3],f[(first+2)*4+3]],contact=depths.map((d,k)=>d<=1e-7?k:-1).filter(k=>k>=0);
      if(contact.length!==2)continue;const a=contact[0],b=contact[1],c=3-a-b;if(depths[c]<=w.wetDepth)continue;
      const point=(k:number):Point=>({x:p[at+k*3],y:p[at+k*3+1]+.001,z:p[at+k*3+2]}),pa=point(a),pb=point(b),pc=point(c),length=Math.hypot(pb.x-pa.x,pb.z-pa.z);if(length<1e-5)continue;
      const reach=Math.abs((pb.x-pa.x)*(pc.z-pa.z)-(pb.z-pa.z)*(pc.x-pa.x))/length;if(reach<1e-5)continue;
      const bedA=pa.y-depths[a],bedB=pb.y-depths[b],bedC=pc.y-depths[c],steepness=Math.max(Math.abs(bedC-bedA),Math.abs(bedC-bedB))/reach;
      if(steepness<.015)continue;const t=Math.min(.35,Math.min(.12,Math.min(w.cellSizeX,w.cellSizeZ)*.18)/reach),mix=(a:Point,b:Point):Point=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t}),speed=Math.hypot(f[(first+c)*4],f[(first+c)*4+1]);
      quad(pa,pb,mix(pa,pc),mix(pb,pc),0,speed,smooth(steepness/.8));shoreBands++;
    }
  }
  // Cross-sheet falls come from accepted local exchange, with both edges
  // clipped by the engine to the actual opening and receiving support.
  // Optional detail packets can be thinned by transport. The owned physical
  // inventory is complete and is the only authority for airborne geometry.
  // A rounded shell must clear the actual terrain as well as native solids.
  // Layer support beds are synthetic control planes: native floors/openings
  // provide their clipping instead, so a fall can leave its donor layer.
  const groundCache=new WeakMap<Point,number>(),below=(p:Point)=>{let bed=groundCache.get(p);if(bed===undefined){bed=terrain(p.x,p.z);groundCache.set(p,bed);}return bed>p.y+1e-5;};
  const flightBlocked=(a:Point,b:Point)=>!!blocked?.(a,b)||(s.boundary?.mesh.supportLayer===undefined&&(below(a)||below(b)||below({x:(a.x+b.x)*.5,y:(a.y+b.y)*.5,z:(a.z+b.z)*.5})));
  const sourceSurface=budget.falls&&s.flights?.length?createWaterSourceSurfaceSampler(w,surface,sourceStyle):undefined;
  const streams=buildWaterFlightMesh(s.flights??[],s.time,-w.liquid.gravity.y,budget.falls,budget.falls*WATER_TERRAIN_FALL_SEGMENTS*6,flightBlocked,sourceSurface,sourceSurface?.connect);
  for(const [into,from] of [[positions,streams.positions],[normals,streams.normals],[uvs,streams.uvs],[activity,streams.activity],[optics,streams.optics]] as const)for(const v of from)into.push(v);
  falls=streams.openings;fallSegments=streams.positions.length/18;
  const byOpening=new Map<string,WaterDetailEvent[]>();
  for(const e of detail.filter(e=>e.fall&&!e.flight)){if(!(e.volume>0&&e.duration>0))continue;const key=e.source;if(!byOpening.has(key)){if(byOpening.size>=budget.falls-falls)continue;byOpening.set(key,[]);}byOpening.get(key)!.push(e);}
  const records=[...byOpening.values()].flat(),openings=new Set<string>();
  for(let index=0;index<records.length;index++){const event=records[index],fall=event.fall,flight=event.flight,key=flight?`flight:${flight.id}`:event.source;if(fallSegments>=budget.falls*WATER_TERRAIN_FALL_SEGMENTS)break;
    const segmentBudget=Math.min(WATER_TERRAIN_FALL_SEGMENTS,Math.max(1,Math.floor((budget.falls*WATER_TERRAIN_FALL_SEGMENTS-fallSegments)/(records.length-index))));
    const speed=Math.hypot(event.velocity.x,event.velocity.y,event.velocity.z),age=flight?Math.max(0,Math.min(s.time,event.time)-flight.time):0,front=flight?age+flight.duration*.5:1,trail=flight?Math.max(0,age-flight.duration*.5):0;
    const row=(t:number):[Point,Point]=>flight?flight.edge.map(p=>{const a=trail+(front-trail)*t;return{x:p.x+flight.velocity.x*a,y:p.y+flight.velocity.y*a-flight.gravity*a*a*.5,z:p.z+flight.velocity.z*a};}) as [Point,Point]:fall!.from.map((p,k)=>({x:p.x+(fall!.to[k].x-p.x)*t,y:p.y+(fall!.to[k].y-p.y)*t*t,z:p.z+(fall!.to[k].z-p.z)*t})) as [Point,Point];
    const first=row(0),last=row(1),segments=Math.min(segmentBudget,flight?Math.max(1,Math.min(8,Math.ceil(Math.hypot(last[0].x-first[0].x,last[0].y-first[0].y,last[0].z-first[0].z)/.08))):8);
    let work=segments,emitted=false;
    const obstructed=(a:Point,b:Point,c:Point)=>{if(!blocked)return false;const center={x:(a.x+b.x+c.x)/3,y:(a.y+b.y+c.y)/3,z:(a.z+b.z+c.z)/3};return blocked(a,b)||blocked(b,c)||blocked(c,a)||blocked(center,center);};
    const segment=(t0:number,t1:number,a:[Point,Point],b:[Point,Point],depth=0):boolean=>{
      if(obstructed(a[0],a[1],b[0])||obstructed(b[0],a[1],b[1])){if(work>=segmentBudget||depth>=12)return false;const t=(t0+t1)*.5,m=row(t);work++;return segment(t0,t,a,m,depth+1)&&segment(t,t1,m,b,depth+1);}
      const added=quad(a[0],a[1],b[0],b[1],1,speed,1,t0,t1,flight?.sourceDepth??event.sourceDepth??event.depth,weights?.get(event.source)??1);emitted||=added;return added;
    };
    for(let k=0;k<segments;k++)if(!segment(k/segments,(k+1)/segments,row(k/segments),row((k+1)/segments)))break;
    if(emitted&&!openings.has(key)){openings.add(key);falls++;}
  }
  if(budget.falls){const cells=waterBodyCells(w,s),candidates:{a:number;b:number;start:{x:number;z:number};end:{x:number;z:number};width:number;speed:number;drop:number;distance:number;strength:number}[]=[];
    const edgeKey=(a:{x:number;z:number},b:{x:number;z:number})=>[`${Math.round(a.x*1e8)},${Math.round(a.z*1e8)}`,`${Math.round(b.x*1e8)},${Math.round(b.z*1e8)}`].sort().join('|');
    const flyingEdges=new Set((s.flights??[]).map(f=>edgeKey(f.edge[0],f.edge[1]))),flyingFaces=new Set((s.flights??[]).map(f=>f.id));
    for(const face of cells.faces()){const axis=Math.abs(face.nx)>.5?'x':'z',parentA=cells.parent(face.a),parentB=face.b>=0?cells.parent(face.b):-1;
      if(face.b<0||flyingEdges.has(edgeKey(face.start,face.end))||flyingFaces.has(`grid-${axis}-${Math.min(parentA,parentB)}-${Math.max(parentA,parentB)}`)||flyingFaces.has(`region-${face.a}-${face.b}-${face.start.x}-${face.start.z}`))continue;const ua=cells.flowX[face.a]*face.nx+cells.flowZ[face.a]*face.nz,ub=cells.flowX[face.b]*face.nx+cells.flowZ[face.b]*face.nz,velocity=(ua+ub)*.5;if(Math.abs(velocity)<.06)continue;
      const sign=velocity>0?1:-1,a=sign>0?face.a:face.b,b=sign>0?face.b:face.a,depth=cells.depth(a);if(depth<=w.wetDepth)continue;
      const top=cells.level(a),bottom=cells.level(b),drop=top-bottom,distance=Math.max(face.distance,Math.min(w.cellSizeX,w.cellSizeZ)*.05),steepness=drop/distance;
      if(steepness<=.4||top<=Math.max(face.start.bed,face.end.bed,face.barrier?.top??-Infinity)+w.wetDepth)continue;
      const ca=cells.center(a),cb=cells.center(b),bedDrop=terrain(ca.x,ca.z)-terrain(cb.x,cb.z);if(bedDrop/distance<=.4)continue;
      candidates.push({a,b,start:face.start,end:face.end,width:face.length,speed:Math.abs(velocity),drop,distance,strength:smooth((steepness-.4)/1.2)*smooth(Math.abs(velocity)/.6)});
    }
    candidates.sort((a,b)=>b.width*b.drop*b.speed-a.width*a.drop*a.speed);
    for(const f of candidates.slice(0,budget.falls-falls)){const a=cells.center(f.a),b=cells.center(f.b),head=cells.level(f.a),tail=Math.max(cells.level(f.b),cells.bed(f.b)),thickness=Math.max(.002,Math.min(.08,cells.depth(f.a))*.25),segments=8,mid={x:(f.start.x+f.end.x)*.5,z:(f.start.z+f.end.z)*.5};
      // Each half stays inside one convex hydraulic owner. Routing through
      // the real face endpoints prevents a narrow wall-tip opening from
      // becoming a center-to-center sheet across the placement footprint.
      const cap=(region:number,center:{x:number;z:number},edge:{x:number;z:number})=>{const dx=edge.x-mid.x,dz=edge.z-mid.z,polygon=cells.polygon(region);let fraction=1;for(let k=0;k<polygon.length;k++){const p=polygon[k],q=polygon[(k+1)%polygon.length],ex=q.x-p.x,ez=q.z-p.z,own=ex*(center.z-p.z)-ez*(center.x-p.x),change=ex*dz-ez*dx;if(change<0)fraction=Math.min(fraction,Math.max(0,own/-change));}return{x:center.x+dx*fraction,z:center.z+dz*fraction};};
      const upstream=[cap(f.a,a,f.start),cap(f.a,a,f.end)],downstream=[cap(f.b,b,f.start),cap(f.b,b,f.end)],mix=(p:{x:number;z:number},q:{x:number;z:number},t:number)=>({x:p.x+(q.x-p.x)*t,z:p.z+(q.z-p.z)*t});
      const row=(t:number):[Point,Point]|undefined=>{const edges=t<=.5?[mix(upstream[0],f.start,t*2),mix(upstream[1],f.end,t*2)]:[mix(f.start,downstream[0],t*2-1),mix(f.end,downstream[1],t*2-1)],cx=(edges[0].x+edges[1].x)*.5,cz=(edges[0].z+edges[1].z)*.5,ballistic=head+(tail-head)*t*t,centerGround=terrain(cx,cz);if(centerGround+thickness>=head)return;
        const side=(edge:{x:number;z:number}):Point=>{const dx=edge.x-cx,dz=edge.z-cz,sample=(fraction:number)=>terrain(cx+dx*fraction,cz+dz*fraction),ceiling=Math.min(head,Math.max(ballistic,centerGround+thickness));let fraction=1;if(sample(1)+thickness>ceiling){let low=0,high=1;for(let k=0;k<8;k++){const mid=(low+high)*.5;if(sample(mid)+thickness<=ceiling)low=mid;else high=mid;}fraction=low;}const x=cx+dx*fraction,z=cz+dz*fraction;return{x,y:Math.min(head,Math.max(sample(fraction)+thickness,ballistic)),z};};return[side(edges[0]),side(edges[1])];};
      const intrudes=(a:Point,b:Point,c:Point)=>{for(const weights of [[.5,.5,0],[.5,0,.5],[0,.5,.5],[1/3,1/3,1/3]]){const x=a.x*weights[0]+b.x*weights[1]+c.x*weights[2],y=a.y*weights[0]+b.y*weights[1]+c.y*weights[2],z=a.z*weights[0]+b.z*weights[1]+c.z*weights[2];if(terrain(x,z)>y-1e-4)return true;}return false;};
      let work=segments,emitted=false;
      const segment=(t0:number,t1:number,previous:[Point,Point],current:[Point,Point],depth=0)=>{if(Math.hypot(current[1].x-current[0].x,current[1].z-current[0].z)<1e-5)return;
        // Above-ground endpoints alone do not keep a chord out of a convex
        // cliff lip. Refine only contact intervals until both triangle
        // interiors clear the real terrain; hard bounds prevent a fine
        // terrain mesh from turning into another simulation-scale mesh.
        if(intrudes(previous[0],previous[1],current[0])||intrudes(current[0],previous[1],current[1])){if(work>=WATER_TERRAIN_FALL_SEGMENTS||depth>=12)return;const mid=(t0+t1)*.5,middle=row(mid);if(!middle)return;work++;segment(t0,mid,previous,middle,depth+1);segment(mid,t1,middle,current,depth+1);return;}
        emitted=quad(previous[0],previous[1],current[0],current[1],1,f.speed,f.strength,t0,t1,cells.depth(f.a))||emitted;
      };
      let previous=row(0);for(let k=1;k<=segments;k++){const current=row(k/segments);if(!previous||!current)break;segment((k-1)/segments,k/segments,previous,current);previous=current;}if(emitted)falls++;
    }
  }
  return{positions:Float32Array.from(positions),normals:Float32Array.from(normals),uvs:Float32Array.from(uvs),activity:Float32Array.from(activity),optics:Float32Array.from(optics),shoreBands,falls};
}

const vertex=`
#include <clipping_planes_pars_vertex>
attribute vec3 activity;attribute vec2 optics;varying vec2 detailUv;varying vec2 detailOptics;varying vec3 detailActivity;varying vec3 detailWorld;varying vec3 detailNormal;
void main(){detailNormal=mat3(modelMatrix)*normal;detailUv=uv;detailActivity=activity;detailOptics=optics;detailWorld=(modelMatrix*vec4(position,1.)).xyz;vec4 mvPosition=modelViewMatrix*vec4(position,1.);
#include <clipping_planes_vertex>
gl_Position=projectionMatrix*mvPosition;}`;
const fragment=`
#include <clipping_planes_pars_fragment>
float hash31(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
float noise3(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(mix(hash31(i),hash31(i+vec3(1,0,0)),f.x),mix(hash31(i+vec3(0,1,0)),hash31(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash31(i+vec3(0,0,1)),hash31(i+vec3(1,0,1)),f.x),mix(hash31(i+vec3(0,1,1)),hash31(i+vec3(1,1,1)),f.x),f.y),f.z);}
uniform float seconds;uniform float shallowDepth;uniform vec3 waterColor;uniform vec3 shallowColor;uniform vec3 foamColor;varying vec2 detailUv;varying vec2 detailOptics;varying vec3 detailActivity;varying vec3 detailWorld;varying vec3 detailNormal;
void main(){
#include <clipping_planes_fragment>
float speed=detailActivity.y,phase=detailUv.y*18.-seconds*speed*5.,fall=step(.5,detailActivity.x),splash=step(1.5,detailActivity.x);
float fiberFilter=1.-smoothstep(.2,1.,fwidth(detailUv.x*35.));float fibers=sin(detailUv.x*35.+sin(phase*.43)*.7)*fiberFilter;
float fineFilter=1.-smoothstep(.2,1.,fwidth(detailUv.x*89.+phase*1.7));float moving=sin(phase+detailUv.x*13.)*.65+sin(phase*1.7+detailUv.x*89.)*fineFilter*.35;
float depth=smoothstep(0.,shallowDepth,max(0.,detailOptics.x));vec3 base=mix(shallowColor,waterColor,depth);
vec3 normal=length(detailNormal)>.1?normalize(detailNormal):normalize(cross(dFdx(detailWorld),dFdy(detailWorld)));float fresnel=pow(1.-abs(dot(normal,normalize(cameraPosition-detailWorld))),3.);
float glint=pow(max(0.,moving*.5+fibers*.3),8.)*.35;vec3 liquid=base*(.88+.08*moving+.045*fibers)+vec3(glint+fresnel*.045);
float shoreAlpha=(1.-detailUv.y)*(.12+.22*(.5+.5*moving))*(.65+.35*sin(phase*.45));
float liquidAlpha=mix(.6,.93,depth)*(.94+.06*moving)*mix(1.,.78,splash);float alpha=mix(shoreAlpha,liquidAlpha,fall)*detailActivity.z*detailOptics.y;
if(splash>.5){
 float foam=step(2.5,detailActivity.x);vec3 drift=vec3(seconds*.21,-seconds*(.3+speed*.035),seconds*.16);
 float curl=noise3(detailWorld*3.+drift),turbulence=noise3(detailWorld*8.+drift*2.+curl*1.7)*.65+noise3(detailWorld*17.+drift*3.1)*.35;
 float edge=pow(max(0.,sin(detailUv.x*3.14159265)),1.6),heightFade=smoothstep(0.,.09,detailUv.y)*(1.-smoothstep(.3,1.,detailUv.y));
 float plume=edge*heightFade*smoothstep(.18,.74,turbulence+curl*.2)*.46;
 float radial=length((detailUv-.5)*2.);float churn=(1.-smoothstep(.5,1.,radial))*smoothstep(.21,.7,turbulence)*.7;
 alpha=mix(plume,churn,foam)*detailOptics.y;liquid=mix(base,foamColor,.68+.26*turbulence);
}
gl_FragColor=vec4(mix(foamColor,liquid,fall),alpha);
#include <tonemapping_fragment>
#include <colorspace_fragment>
}`;

export class WaterTerrainEffectsView {
  readonly root=new Group();private readonly geometry=new BufferGeometry();private readonly material:ShaderMaterial;private readonly mesh:Mesh;private readonly water:WaterBodyManifest;private quality:WaterTerrainEffectsQuality;private scene:PhysicsScene;private terrainKey='';private terrain:(x:number,z:number)=>number=()=>0;private disposed=false;private accepted?:{state:WaterBodyState;surface:WaterBodySurfaceBuffers;detail:readonly WaterDetailEvent[]};
  private readonly impactGeometry=new BufferGeometry();private readonly impactMesh:Mesh;private readonly impacts=new Map<string,WaterDetailEvent>();private lastStateTime=-Infinity;private impactTime=NaN;private splashCount_=0;
  get splashCount():number{return this.splashCount_;}
  private solidsKey='';private solidQuery?:(from:Point,to:Point)=>boolean;
  private readonly pourMaterial:MeshPhysicalMaterial;private readonly pourAdvection={value:0};private readonly flowClock=new WaterFlowAdvectionClock();
  private readonly sourceStyle:Pick<WaterTerrainEffectsOptions,'waveContrast'|'waveNormalStrength'>;private readonly surfaceMaterial?:WaterTerrainEffectsOptions['surfaceMaterial'];private readonly surfaceDepthWrite:boolean;
  counts={shoreBands:0,falls:0};
  constructor(water:WaterBodyManifest,scene:PhysicsScene,options:WaterTerrainEffectsOptions={}){this.water=water;this.scene=scene;this.sourceStyle={waveContrast:options.waveContrast,waveNormalStrength:options.waveNormalStrength};this.surfaceMaterial=options.surfaceMaterial;this.surfaceDepthWrite=options.surfaceMaterial?.depthWrite??true;this.quality=options.quality??'high';if(!budgets[this.quality])throw new Error('Invalid terrain water detail quality');
    this.material=new ShaderMaterial({vertexShader:vertex,fragmentShader:fragment,clipping:true,uniforms:{seconds:{value:0},waterColor:{value:new Color(options.color??'#217d96')},shallowColor:{value:new Color(options.shallowColor??'#65b9ba')},shallowDepth:{value:options.shallowDepth??.15},foamColor:{value:new Color(options.foamColor??'#eef8f4')}},transparent:true,depthWrite:false,side:DoubleSide,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});
    this.pourMaterial=new MeshPhysicalMaterial({color:0xffffff,transparent:true,depthWrite:false,side:DoubleSide,roughness:.12,metalness:0,ior:1.333,clearcoat:.65,clearcoatRoughness:.08,opacity:.9,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});
    this.pourMaterial.onBeforeCompile=shader=>{
      shader.uniforms.waterPourAdvection=this.pourAdvection;shader.uniforms.waterPourFlowStrength={value:options.flowStrength??(water.currents===false?0:1)};shader.uniforms.waterPourDeep=this.material.uniforms.waterColor;shader.uniforms.waterPourShallow=this.material.uniforms.shallowColor;shader.uniforms.waterPourShallowDepth=this.material.uniforms.shallowDepth;shader.uniforms.waterPourEdgeOpacity={value:options.edgeOpacity??0};
      shader.vertexShader='attribute vec3 activity;attribute vec2 optics;varying vec2 waterPourUv;varying vec2 waterPourOptics;varying float waterPourSpeed;varying float waterPourSourceTone;\n'+shader.vertexShader;
      shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nwaterPourUv=uv;waterPourOptics=optics;waterPourSpeed=activity.y;waterPourSourceTone=activity.z;');
      shader.fragmentShader=WATER_SURFACE_OPTICS_GLSL+WATER_CURRENT_GLSL+'uniform float waterPourAdvection;uniform float waterPourFlowStrength;uniform float waterPourEdgeOpacity;uniform float waterPourShallowDepth;uniform vec3 waterPourDeep;uniform vec3 waterPourShallow;varying vec2 waterPourUv;varying vec2 waterPourOptics;varying float waterPourSpeed;varying float waterPourSourceTone;\n'+shader.fragmentShader;
      shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
diffuseColor.rgb*=mix(waterPourDeep,waterPourShallow,waterSurfaceTint(waterPourOptics.x,waterPourShallowDepth));
vec4 waterPourCurrentDetail=waterCurrentDetail(waterPourUv,vec2(0.0,1.0),waterPourOptics.x,0.0,waterPourAdvection)*smoothstep(0.025,0.7,waterPourSpeed);
diffuseColor.rgb=mix(diffuseColor.rgb,vec3(0.85,0.96,0.94),clamp(waterPourFlowStrength*waterPourCurrentDetail.z*0.26,0.0,0.8));
float waterPourDepth=max(0.,waterPourOptics.x);
float waterPourDepthAlpha=max(mix(waterPourEdgeOpacity,1.0,smoothstep(0.0,waterPourShallowDepth,waterPourDepth)),0.2*smoothstep(0.0,0.002,waterPourDepth));
diffuseColor.a*=waterPourOptics.y*waterPourDepthAlpha;`);
      shader.fragmentShader=shader.fragmentShader.replace('#include <normal_fragment_maps>',`#include <normal_fragment_maps>
// Metre-scale flowing optical slopes use the same physical light/environment
// response as the body. They never move the shell or alter clipping.
vec2 waterPourSlope=waterPourCurrentDetail.xy*waterPourFlowStrength;
vec3 waterPourDx=dFdx(-vViewPosition),waterPourDy=dFdy(-vViewPosition);vec2 waterPourDuvx=dFdx(waterPourUv),waterPourDuvy=dFdy(waterPourUv);
vec3 waterPourU=waterPourDx*waterPourDuvy.y-waterPourDy*waterPourDuvx.y,waterPourV=waterPourDy*waterPourDuvx.x-waterPourDx*waterPourDuvy.x;
vec3 waterPourNormalDetail=vec3(0.);if(length(waterPourU)>1e-9&&length(waterPourV)>1e-9)waterPourNormalDetail=(normalize(waterPourU)*waterPourSlope.x+normalize(waterPourV)*waterPourSlope.y);
normal=normalize(normal+waterPourNormalDetail);`);
      shader.fragmentShader=shader.fragmentShader.replace('#include <clearcoat_normal_fragment_maps>',`#include <clearcoat_normal_fragment_maps>
#ifdef USE_CLEARCOAT
clearcoatNormal=normalize(clearcoatNormal+waterPourNormalDetail);
#endif`);
      shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>','outgoingLight *= waterPourSourceTone;\n#include <opaque_fragment>');
    };
    this.pourMaterial.customProgramCacheKey=()=> 'water-outlet-physical-v3';this.syncPourMaterial();
    this.mesh=new Mesh(this.geometry,[this.material,this.pourMaterial]);this.mesh.name='water-detail:shore-falls';this.mesh.frustumCulled=false;this.mesh.receiveShadow=true;this.mesh.renderOrder=3;this.root.add(this.mesh);this.impactMesh=new Mesh(this.impactGeometry,this.material);this.impactMesh.name='water-detail:impact-plumes';this.impactMesh.frustumCulled=false;this.impactMesh.renderOrder=4;this.root.add(this.impactMesh);this.root.visible=false;
  }
  private syncPourMaterial():void{const source=this.surfaceMaterial,target=this.pourMaterial;if(!source)return;
    for(const key of ['roughness','metalness','ior','clearcoat','clearcoatRoughness','envMapIntensity','opacity','transmission','thickness','attenuationDistance','specularIntensity'] as const){const value=source[key];if(value!==undefined&&target[key]!==value){const before=target[key];target[key]=value;if((key==='transmission'||key==='clearcoat')&&!!before!==!!value)target.needsUpdate=true;}}
    for(const key of ['envMap','map','normalMap','roughnessMap','clearcoatMap','clearcoatRoughnessMap'] as const)if(source[key]!==undefined&&target[key]!==source[key]){target[key]=source[key]!;target.needsUpdate=true;}
    if(source.normalScale)target.normalScale.copy(source.normalScale);if(source.attenuationColor)target.attenuationColor.copy(source.attenuationColor);if(source.specularColor)target.specularColor.copy(source.specularColor);
  }
  setQuality(quality:WaterTerrainEffectsQuality):void{if(!budgets[quality])throw new Error('Invalid terrain water detail quality');this.quality=quality;if(this.accepted)this.update(this.accepted.state,this.accepted.surface,this.scene,this.accepted.detail);else this.root.visible=false;}
  update(state:WaterBodyState,surface:WaterBodySurfaceBuffers,scene=this.scene,detail:readonly WaterDetailEvent[]=[]):void{if(this.disposed)return;this.scene=scene;this.accepted={state,surface,detail};this.syncPourMaterial();
    if(this.quality!=='off'){
      const key=JSON.stringify([scene.terrain,scene.terrainChunks]);if(key!==this.terrainKey){this.terrainKey=key;const grounds=liquidGrounds(scene);this.terrain=(x,z)=>{let height=-Infinity;for(const ground of grounds){const hit=collideLiquidGround({x,y:-10001,z},.01,ground);if(hit)height=Math.max(height,hit.point.y);}return Number.isFinite(height)?height:this.water.liquid.bounds.min.y;};}
      if(this.impacts.size||state.flights?.length||detail.some(e=>e.fall||e.flight||(e.kind==='impact'||e.kind==='splash'))){const solidsKey=JSON.stringify(scene.colliders);if(solidsKey!==this.solidsKey){const query=createWaterDetailSolidQuery(scene);this.solidQuery=(a,b)=>query(a,b,1e-5);this.solidsKey=solidsKey;}}
    }
    const cells=state.boundary?.mesh.supportLayer!==undefined&&this.quality!=='off'?waterBodyCells(this.water,state):undefined;
    const terrain=cells?(x:number,z:number)=>{const i=cells.locate({x,z});return i===undefined?this.water.liquid.bounds.min.y:cells.bedAt(i,x,z);}:this.terrain;
    if(state.time<this.lastStateTime){this.impacts.clear();}this.lastStateTime=state.time;
    for(const e of detail)if(e.kind==='impact'||e.kind==='splash')this.impacts.set(`${e.source}:${e.time}`,e);
    for(const [key,e]of this.impacts)if(state.time-e.time>=waterImpactLifetime(this.water,e))this.impacts.delete(key);
    if(this.impacts.size>WATER_IMPACT_LIMITS.events){const keep=[...this.impacts.values()].sort((a,b)=>b.energy-a.energy).slice(0,WATER_IMPACT_LIMITS.events);this.impacts.clear();for(const e of keep)this.impacts.set(`${e.source}:${e.time}`,e);}
    const result=buildWaterTerrainEffects(this.water,state,surface,terrain,this.quality,detail,this.solidQuery,undefined,this.sourceStyle);this.counts={shoreBands:result.shoreBands,falls:result.falls};if(this.surfaceMaterial)this.surfaceMaterial.depthWrite=result.falls?false:this.surfaceDepthWrite;for(const [name,values,size] of [['position',result.positions,3],['normal',result.normals,3],['uv',result.uvs,2],['activity',result.activity,3],['optics',result.optics,2]] as const){const old=this.geometry.getAttribute(name);if(old?.array.length===values.length){old.array.set(values);old.needsUpdate=true;}else this.geometry.setAttribute(name,new BufferAttribute(values,size).setUsage(DynamicDrawUsage));}this.geometry.setDrawRange(0,result.positions.length/3);this.geometry.clearGroups();if(result.shoreBands)this.geometry.addGroup(0,result.shoreBands*6,0);if(result.positions.length/3>result.shoreBands*6)this.geometry.addGroup(result.shoreBands*6,result.positions.length/3-result.shoreBands*6,1);this.root.visible=result.positions.length>0;this.material.uniforms.seconds.value=state.time;let flowVolume=0,flowSpeed=0;for(const flight of state.flights??[]){const age=Math.max(0,state.time-flight.time),speed=Math.hypot(flight.velocity.x,flight.velocity.y+this.water.liquid.gravity.y*age,flight.velocity.z);flowVolume+=flight.volume;flowSpeed+=flight.volume*speed;}if(!flowVolume){let n=0;for(let i=0;i<result.activity.length;i+=3)if(result.activity[i]===1){flowSpeed+=result.activity[i+1];n++;}flowVolume=n;}this.pourAdvection.value=this.flowClock.accept(state.time,flowVolume?flowSpeed/flowVolume:0);this.updateImpacts(state.time,true);
  }
  private updateImpacts(seconds:number,force=false):void{if(!force&&seconds===this.impactTime)return;this.impactTime=seconds;const result=buildWaterImpactPlumes(this.water,[...this.impacts.values()],seconds,this.quality,this.solidQuery);this.splashCount_=result.count;for(const [name,values,size]of[['position',result.positions,3],['normal',new Float32Array(result.positions.length),3],['uv',result.uvs,2],['activity',result.activity,3],['optics',result.optics,2]] as const){const old=this.impactGeometry.getAttribute(name);if(old?.array.length===values.length){old.array.set(values);old.needsUpdate=true;}else this.impactGeometry.setAttribute(name,new BufferAttribute(values,size).setUsage(DynamicDrawUsage));}this.impactGeometry.setDrawRange(0,result.positions.length/3);this.root.visible=this.geometry.drawRange.count>0||result.positions.length>0;}
  animate(seconds:number):void{if(!Number.isFinite(seconds))throw new Error('Water detail time must be finite');this.material.uniforms.seconds.value=seconds;this.pourAdvection.value=this.flowClock.advance(seconds);if(this.quality!=='off'&&this.impacts.size){for(const [key,e]of this.impacts)if(seconds-e.time>=waterImpactLifetime(this.water,e))this.impacts.delete(key);this.updateImpacts(seconds);}}
  dispose():void{if(this.disposed)return;this.disposed=true;if(this.surfaceMaterial)this.surfaceMaterial.depthWrite=this.surfaceDepthWrite;this.geometry.dispose();this.impactGeometry.dispose();this.material.dispose();this.pourMaterial.dispose();this.root.clear();this.root.removeFromParent();}
}
