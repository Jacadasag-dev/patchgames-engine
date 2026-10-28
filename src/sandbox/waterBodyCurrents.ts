/** Internal depth-averaged current entrainment. Exchange momentum only across
 * connected wet faces; never move volume, extend a shoreline, or cross a dam.
 * Pair coefficients are symmetric in water mass and capped so the complete
 * four-neighbor update is a convex average. Consequently it conserves linear
 * momentum, cannot increase kinetic energy, and needs no extra solver steps. */
import type {WaterBodyManifest,WaterBodyState} from './waterBody.ts';
import type {WaterBodyGeometry} from './waterBodyGrid.ts';
import {waterBodyCells} from './waterBodyCells.ts';

export interface WaterCurrentGroups {
  owner:Int32Array;area:Float64Array;volume:Float64Array;head:Float64Array;
  cx:Float64Array;cz:Float64Array;x:Float64Array;z:Float64Array;
}

/** Mean of max(0, level - linear bed) along one face. */
function positiveDepthMean(level:number,bed0:number,bed1:number):number{
  const h0=level-bed0,h1=level-bed1;
  return h0>0&&h1>0?(h0+h1)*.5:h0>0?h0*h0/(2*(h0-h1)):h1>0?h1*h1/(2*(h1-h0)):0;
}

export function mixWaterBodyCurrents(w:WaterBodyManifest,s:WaterBodyState,geometry:WaterBodyGeometry,dt:number,
  changeX=new Float64Array(s.depth.length),changeZ=new Float64Array(s.depth.length),groups?:WaterCurrentGroups):void {
  if(w.currents===false)return;
  if(s.boundary){mixBoundaryCurrents(w,s,geometry,dt,changeX,changeZ,groups);return;}
  const count=s.depth.length;changeX.fill(0);changeZ.fill(0);
  const viscosity=w.currentMixing??.05;
  const pair=(i:number,j:number,spacing:number,barrier:WaterBodyGeometry['x'][number])=>{
    const a=s.depth[i],b=s.depth[j];if(a<=w.wetDepth||b<=w.wetDepth)return;
    const bedA=s.bed[i]+(s.solidDepth?.[i]??0),bedB=s.bed[j]+(s.solidDepth?.[j]??0);
    const overlap=Math.min(bedA+a,bedB+b)-Math.max(bedA,bedB,barrier?.top??-Infinity);
    if(overlap<=w.wetDepth)return;
    const dx=s.flowX[j]-s.flowX[i],dz=s.flowZ[j]-s.flowZ[i],shear=Math.hypot(dx,dz);
    if(shear<1e-12)return;
    // A .2-cell mixing length resolves larger eddies as flow while diffusing
    // subcell shear. The physical baseline remains independent of grid size.
    const eddy=viscosity+.04*spacing*shear;
    const connection=Math.min(1,overlap/Math.min(a,b));
    const relaxation=Math.min(.25,-Math.expm1(-2*eddy*dt/(spacing*spacing)))*connection;
    const mass=a*b/(a+b),px=mass*relaxation*dx,pz=mass*relaxation*dz;
    changeX[i]+=px;changeX[j]-=px;changeZ[i]+=pz;changeZ[j]-=pz;
  };
  for(let x=0;x<w.columns;x++)for(let z=0;z<w.rows;z++){
    const i=x*w.rows+z;
    if(x+1<w.columns)pair(i,i+w.rows,w.cellSizeX,geometry.x[(x+1)*w.rows+z]);
    if(z+1<w.rows)pair(i,i+1,w.cellSizeZ,geometry.z[x*(w.rows+1)+z+1]);
  }
  for(let i=0;i<count;i++)if(changeX[i]||changeZ[i]){
    s.flowX[i]+=changeX[i]/s.depth[i];s.flowZ[i]+=changeZ[i]/s.depth[i];
    if(Math.hypot(changeX[i],changeZ[i])/s.depth[i]>w.sleepSpeed*.05){s.sleeping[i]=false;s.quietTime[i]=0;}
  }
}

/** Symmetric physical-volume exchange. Refinement can give a region many
 * neighbours, so bound the complete row sum instead of assuming four faces. */
function mixBoundaryCurrents(w:WaterBodyManifest,s:WaterBodyState,geometry:WaterBodyGeometry,dt:number,changeX:Float64Array,changeZ:Float64Array,groups?:WaterCurrentGroups):void{
  const cells=waterBodyCells(w,s),n=groups?.area.length??cells.count,cx=changeX.length===n?changeX:new Float64Array(n),cz=changeZ.length===n?changeZ:new Float64Array(n);
  cx.fill(0);cz.fill(0);
  const rows=new Float64Array(n),pairs:{a:number;b:number;coefficient:number}[]=[],viscosity=w.currentMixing??.05,pairIndex=groups?new Map<number,number>():undefined;
  const volume=(i:number)=>groups?groups.volume[i]:cells.volume(i),area=(i:number)=>groups?groups.area[i]:cells.area(i),depth=(i:number)=>volume(i)/area(i),level=(i:number)=>groups?groups.head[i]:cells.level(i),vx=groups?.x??cells.flowX,vz=groups?.z??cells.flowZ;
  for(const face of cells.faces(geometry)){
    if(face.b<0)continue;const a=groups?groups.owner[face.a]:face.a,b=groups?groups.owner[face.b]:face.b;if(a===b)continue;
    // Terrain quadrature in one hydraulic pool shares a velocity. Such an
    // internal edge has exactly zero mixing exchange and needs no shoreline
    // inversion or overlap integral.
    const dx=vx[b]-vx[a],dz=vz[b]-vz[a],shear=Math.hypot(dx,dz);if(shear<1e-12)continue;
    const ha=depth(a),hb=depth(b);if(ha<=w.wetDepth||hb<=w.wetDepth)continue;
    const la=level(a),lb=level(b),lower=Math.max(groups?la-ha:cells.bed(a)+cells.solidDepth[a],groups?lb-hb:cells.bed(b)+cells.solidDepth[b],face.barrier?.top??-Infinity),head=Math.min(la,lb),shift=groups?Math.max(cells.solidDepth[face.a],cells.solidDepth[face.b]):0;
    // The group lower bed can intersect the sloping face in its interior.
    // Subtract the two positive-part integrals to retain that kink; treating
    // the already-clamped endpoints as one line undercounts the opening.
    const bed0=face.start.bed+shift,bed1=face.end.bed+shift;
    const overlap=head>lower?Math.max(0,positiveDepthMean(head,bed0,bed1)-positiveDepthMean(lower,bed0,bed1)):0;
    if(overlap<=w.wetDepth)continue;
    const spacing=groups?Math.max(Math.min(w.cellSizeX,w.cellSizeZ)*.05,Math.abs((groups.cx[b]-groups.cx[a])*face.nx+(groups.cz[b]-groups.cz[a])*face.nz)):face.distance,eddy=viscosity+.04*spacing*shear,connection=Math.min(1,overlap/Math.min(ha,hb));
    const relaxation=Math.min(.25,-Math.expm1(-2*eddy*dt/(spacing*spacing)))*connection;
    const ma=volume(a),mb=volume(b),geometryWeight=face.length*spacing/(.5*(area(a)+area(b)));
    const coefficient=ma*mb/(ma+mb)*relaxation*geometryWeight;if(coefficient<=0)continue;
    // Terrain triangles are storage quadrature, not independent mixing
    // masses. Sum their shared conductance once per hydraulic pair so changing
    // an interior tessellation cannot change the pool's current response.
    const key=Math.min(a,b)*n+Math.max(a,b),old=pairIndex?.get(key);
    if(old!==undefined)pairs[old].coefficient+=coefficient;
    else{pairIndex?.set(key,pairs.length);pairs.push({a,b,coefficient});}
  }
  for(const {a,b,coefficient} of pairs){rows[a]+=coefficient/volume(a);rows[b]+=coefficient/volume(b);}
  for(const {a,b,coefficient} of pairs){
    const amount=coefficient/Math.max(1,rows[a],rows[b]),px=amount*(vx[b]-vx[a]),pz=amount*(vz[b]-vz[a]);
    cx[a]+=px;cx[b]-=px;cz[a]+=pz;cz[b]-=pz;
  }
  for(let i=0;i<n;i++)if(cx[i]||cz[i]){
    const mass=volume(i);vx[i]+=cx[i]/mass;vz[i]+=cz[i]/mass;
    if(!groups&&Math.hypot(cx[i],cz[i])/mass>w.sleepSpeed*.05)cells.wake(i);
  }
  if(groups)for(let i=0;i<cells.count;i++){const group=groups.owner[i];cells.flowX[i]=cells.volume(i)>0?vx[group]:0;cells.flowZ[i]=cells.volume(i)>0?vz[group]:0;if(groups.volume[group]>0&&Math.hypot(cx[group],cz[group])/groups.volume[group]>w.sleepSpeed*.05)cells.wake(i);}
  cells.commit();
}
