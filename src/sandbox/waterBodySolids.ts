/** Exact bounded solid columns shared by displacement and buoyancy. */
import type {PhysicsShape,PhysicsVector} from './physics.ts';
import {physicsConvexFaces,physicsShapeVolume} from './physicsGeometry.ts';
import {liquidRotate,type LiquidObstacle} from './liquidCollision.ts';
import type {WaterBodyManifest,WaterBodyState} from './waterBody.ts';
import {waterBodyCells} from './waterBodyCells.ts';
import type {WaterBoundaryMesh} from './waterBoundaryGeometry.ts';
type Polygon=PhysicsVector[];
type Solid={faces:Polygon[];volume:number;scale:number};
const zero=():PhysicsVector=>({x:0,y:0,z:0});
const add=(a:PhysicsVector,b:PhysicsVector):PhysicsVector=>({x:a.x+b.x,y:a.y+b.y,z:a.z+b.z});
const scale=(v:PhysicsVector,s:number):PhysicsVector=>({x:v.x*s,y:v.y*s,z:v.z*s});
const dot=(a:PhysicsVector,b:PhysicsVector)=>a.x*b.x+a.y*b.y+a.z*b.z;
const cross=(a:PhysicsVector,b:PhysicsVector):PhysicsVector=>({x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x});
const meshes=new WeakMap<PhysicsShape,Solid>();
/** Convex clipping preserves continuous partial immersion, including thin
 * rotated boards. Curved shapes use at most 50 vertices and their analytic
 * volume to normalize the approximation; fully submerged volume is exact. */
export function waterBodySolid(shape:PhysicsShape):Solid {
  const cached=meshes.get(shape);if(cached)return cached;
  let points:PhysicsVector[],faces:Polygon[];
  if(shape.kind==='box'){
    const h=shape.halfExtents;
    points=Array.from({length:8},(_,i)=>({x:(i&1?1:-1)*h.x,y:(i&2?1:-1)*h.y,z:(i&4?1:-1)*h.z}));
    faces=[[0,2,3,1],[4,5,7,6],[0,1,5,4],[2,6,7,3],[0,4,6,2],[1,3,7,5]].map(f=>f.map(i=>points[i]));
  }else{
    if(shape.kind==='convex')points=shape.vertices;
    else{
      const r=shape.radius,h=shape.kind==='capsule'?shape.halfHeight:0;
      points=[{x:0,y:h+r,z:0},{x:0,y:-h-r,z:0}];
      const rings=shape.kind==='capsule'?[Math.PI/6,Math.PI/3,Math.PI/2,Math.PI/2,Math.PI*2/3,Math.PI*5/6]
        :[Math.PI/6,Math.PI/3,Math.PI/2,Math.PI*2/3,Math.PI*5/6];
      rings.forEach((angle,j)=>{for(let k=0;k<8;k++){const phi=k*Math.PI/4;
        points.push({x:r*Math.sin(angle)*Math.cos(phi),y:r*Math.cos(angle)+(shape.kind==='capsule'?(j<3?h:-h):0),z:r*Math.sin(angle)*Math.sin(phi)});}});
    }
    faces=physicsConvexFaces({kind:'convex',vertices:points}).map(f=>f.map(i=>points[i]));
  }
  const volume=physicsShapeVolume(shape),approx=measure(faces).volume;
  const result={faces,volume,scale:volume/approx};meshes.set(shape,result);return result;
}
function measure(faces:Polygon[]):{volume:number;point:PhysicsVector} {
  if(!faces.length)return{volume:0,point:zero()};
  // Scalar form of the tetrahedral fan about the vertex centroid; same
  // operation order as the vector form, without per-term allocation.
  let ox=0,oy=0,oz=0,count=0;
  for(const face of faces)for(const p of face){ox=ox+p.x;oy=oy+p.y;oz=oz+p.z;count++;}
  const inverse=1/count;ox*=inverse;oy*=inverse;oz*=inverse;
  let volume=0,px=0,py=0,pz=0;
  for(const face of faces)for(let i=1;i<face.length-1;i++){
    const a=face[0],b=face[i],c=face[i+1],ax=a.x-ox,ay=a.y-oy,az=a.z-oz,ux=b.x-ox,uy=b.y-oy,uz=b.z-oz,vx=c.x-ox,vy=c.y-oy,vz=c.z-oz;
    const part=Math.abs(ax*(uy*vz-uz*vy)+ay*(uz*vx-ux*vz)+az*(ux*vy-uy*vx))/6,share=part/4;
    volume+=part;px=px+((ox+a.x)+(b.x+c.x))*share;py=py+((oy+a.y)+(b.y+c.y))*share;pz=pz+((oz+a.z)+(b.z+c.z))*share;
  }
  return{volume,point:volume>0?{x:px*(1/volume),y:py*(1/volume),z:pz*(1/volume)}:{x:ox,y:oy,z:oz}};
}
/** Retain n dot p <= offset, capping the newly exposed convex section. */
function clip(faces:Polygon[],normal:PhysicsVector,offset:number):Polygon[] {
  const tolerance=1e-10*Math.hypot(normal.x,normal.y,normal.z);
  const distance=(p:PhysicsVector)=>{const d=dot(normal,p)-offset;return Math.abs(d)<tolerance?0:d;};
  let outside=false,inside=false;
  for(const face of faces)for(const p of face){const d=distance(p);if(d>0)outside=true;else if(d<0)inside=true;if(outside&&inside)break;}
  if(!outside)return faces;
  if(!inside)return [];
  const near=(q:PhysicsVector,p:PhysicsVector)=>{const dx=q.x-p.x,dy=q.y-p.y,dz=q.z-p.z;return dx*dx+dy*dy+dz*dz<1e-18;};
  const result:Polygon[]=[],cap:PhysicsVector[]=[];
  for(const face of faces){
    const polygon:Polygon=[];
    for(let i=0;i<face.length;i++){
      const a=face[i],b=face[(i+1)%face.length],da=distance(a),db=distance(b);
      if(da<=0)polygon.push(a);
      if((da<0&&db>0)||(da>0&&db<0)){
        const t=da/(da-db),p={x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t};polygon.push(p);
        if(!cap.some(q=>near(q,p)))cap.push(p);
      }else if(da===0&&!cap.some(q=>near(q,a)))cap.push(a);
    }
    if(polygon.length>=3){
      // Twice the polygon's vector area, accumulated in fan order.
      const o=polygon[0];let sx=0,sy=0,sz=0;
      for(let k=1;k<polygon.length-1;k++){const p=polygon[k],q=polygon[k+1],ux=p.x-o.x,uy=p.y-o.y,uz=p.z-o.z,vx=q.x-o.x,vy=q.y-o.y,vz=q.z-o.z;sx=sx+(uy*vz-uz*vy);sy=sy+(uz*vx-ux*vz);sz=sz+(ux*vy-uy*vx);}
      if(sx*sx+sy*sy+sz*sz>1e-28)result.push(polygon);
    }
  }
  if(cap.length>=3){
    // Region edge normals are scaled by edge length. Choose a nonparallel
    // reference by direction, not a threshold that assumes a unit normal.
    const center=scale(cap.reduce(add,zero()),1/cap.length),reference=Math.abs(normal.x)<.9*Math.hypot(normal.x,normal.y,normal.z)?{x:1,y:0,z:0}:{x:0,y:1,z:0};
    const u=cross(normal,reference),v=cross(normal,u);
    // Each point's angle once, rather than twice per comparison.
    // A stable insertion sort orders these few points exactly as a stable sort.
    const angles=cap.map(p=>{const dx=p.x-center.x,dy=p.y-center.y,dz=p.z-center.z;return Math.atan2(dx*v.x+dy*v.y+dz*v.z,dx*u.x+dy*u.y+dz*u.z);});
    for(let k=1;k<cap.length;k++){const p=cap[k],angle=angles[k];let j=k-1;while(j>=0&&angles[j]-angle>0){cap[j+1]=cap[j];angles[j+1]=angles[j];j--;}cap[j+1]=p;angles[j+1]=angle;}
    result.push(cap);
  }
  return result;
}
const WEST={x:-1,y:0,z:0},EAST={x:1,y:0,z:0},NORTH={x:0,y:0,z:-1},SOUTH={x:0,y:0,z:1},DOWN={x:0,y:-1,z:0},UP={x:0,y:1,z:0};
/** The solid inside one XZ cell's vertical prism, before any height cut. */
function horizontalColumn(faces:Polygon[],x0:number,x1:number,z0:number,z1:number):Polygon[]{
  for(const [normal,offset] of [[WEST,-x0],[EAST,x1],[NORTH,-z0],[SOUTH,z1]] as [PhysicsVector,number][]){faces=clip(faces,normal,offset);if(!faces.length)return faces;}
  return faces;
}
function verticalColumn(faces:Polygon[],bed:number,surface:number){
  if(!faces.length)return{volume:0,point:zero()};
  faces=clip(faces,DOWN,-bed);if(!faces.length)return{volume:0,point:zero()};
  faces=clip(faces,UP,surface);if(!faces.length)return{volume:0,point:zero()};
  return measure(faces);
}
/** An obstacle's horizontal cuts depend only on its pose and the cell. Scenes
 * are rebuilt each step and a moving body is measured by both the water step
 * and buoyancy, so key cuts by collider content; the height cuts that follow
 * the moving waterline are redone on every call. A cell index identifies a
 * different prism in each immutable manifest, so caches are scoped to that
 * manifest as well as the collider pose. Bounded by collider count per basin. */
type Cuts={faces?:Polygon[];cells:Map<number,Polygon[]>;regions?:WeakMap<WaterBoundaryMesh,Map<number,Polygon[]>>};
const horizontalCache=new WeakMap<WaterBodyManifest,Map<string,Cuts>>();
// One step's obstacle asks for many columns; resolve its content key once.
const obstacleCuts=new WeakMap<LiquidObstacle,WeakMap<WaterBodyManifest,Cuts>>();
function cached(w:WaterBodyManifest,obstacle:LiquidObstacle){
  let byManifest=obstacleCuts.get(obstacle);const known=byManifest?.get(w);if(known)return known;
  if(!byManifest){byManifest=new WeakMap();obstacleCuts.set(obstacle,byManifest);}
  let poses=horizontalCache.get(w);if(!poses){poses=new Map();horizontalCache.set(w,poses);}
  const c=obstacle.collider,key=JSON.stringify([c.shape,c.position,c.rotation??null]);
  let entry=poses.get(key);
  // Least recently used order: moving poses age out, static walls stay.
  if(entry)poses.delete(key);
  else{entry={cells:new Map()};if(poses.size>=128)poses.delete(poses.keys().next().value!);}
  poses.set(key,entry);byManifest.set(w,entry);return entry;
}
function cellSolid(w:WaterBodyManifest,obstacle:LiquidObstacle,x:number,z:number):Polygon[]{
  const entry=cached(w,obstacle),i=x*w.rows+z;let horizontal=entry.cells.get(i);
  if(!horizontal){
    const mesh=waterBodySolid(obstacle.collider.shape);
    entry.faces??=mesh.faces.map(face=>face.map(p=>add(obstacle.collider.position,liquidRotate(p,obstacle.collider.rotation))));
    const minX=w.origin.x+x*w.cellSizeX,minZ=w.origin.z+z*w.cellSizeZ;
    horizontal=horizontalColumn(entry.faces,minX,minX+w.cellSizeX,minZ,minZ+w.cellSizeZ);entry.cells.set(i,horizontal);
  }
  return horizontal;
}
/** The obstacle's solid between bed and surface inside one XZ cell. */
export function waterBodyObstacleColumn(w:WaterBodyManifest,obstacle:LiquidObstacle,x:number,z:number,bed:number,surface:number){
  return verticalColumn(cellSolid(w,obstacle,x,z),bed,surface);
}
/** Lowest point of the obstacle's solid inside an XZ cell; Infinity if none. */
export function waterBodyObstacleBottom(w:WaterBodyManifest,obstacle:LiquidObstacle,x:number,z:number):number{
  let bottom=Infinity;for(const face of cellSolid(w,obstacle,x,z))for(const p of face)bottom=Math.min(bottom,p.y);
  return bottom;
}
/** The obstacle's horizontal cut at one height inside an XZ cell: the
 * waterplane a hull presents there (the rate its column volume grows with
 * the water level) and that cut's centroid. Scaled like the column volume. */
export function waterBodyObstacleSection(w:WaterBodyManifest,obstacle:LiquidObstacle,x:number,z:number,height:number):{area:number;x:number;z:number}{
  return section(cellSolid(w,obstacle,x,z),height,waterBodySolid(obstacle.collider.shape).scale);
}
function section(faces:Polygon[],height:number,scale:number):{area:number;x:number;z:number}{
  const points:PhysicsVector[]=[];
  for(const face of faces)for(let k=0;k<face.length;k++){
    const a=face[k],b=face[(k+1)%face.length],da=a.y-height,db=b.y-height;
    const p=da===0?a:da*db<0?{x:a.x+(b.x-a.x)*da/(da-db),y:height,z:a.z+(b.z-a.z)*da/(da-db)}:undefined;
    if(p&&!points.some(q=>(q.x-p.x)**2+(q.z-p.z)**2<1e-18))points.push(p);
  }
  if(points.length<3)return{area:0,x:0,z:0};
  // The cut of a convex solid is convex: order it about its vertex mean.
  let mx=0,mz=0;for(const p of points){mx+=p.x;mz+=p.z;}mx/=points.length;mz/=points.length;
  const angles=points.map(p=>Math.atan2(p.z-mz,p.x-mx)),order=points.map((_,k)=>k).sort((a,b)=>angles[a]-angles[b]);
  let twice=0,cx=0,cz=0;
  for(let k=0;k<order.length;k++){const p=points[order[k]],q=points[order[(k+1)%order.length]],cross=(p.x-mx)*(q.z-mz)-(q.x-mx)*(p.z-mz);
    twice+=cross;cx+=(p.x+q.x-2*mx)*cross;cz+=(p.z+q.z-2*mz)*cross;}
  if(Math.abs(twice)<=1e-18)return{area:0,x:mx,z:mz};
  return{area:Math.abs(twice)/2*scale,x:mx+cx/(3*twice),z:mz+cz/(3*twice)};
}

/** The same convex solid clipped to an individual hydraulic region. Static
 * walls already represented by the region's bed must not displace twice. */
function regionSolid(w:WaterBodyManifest,s:WaterBodyState,obstacle:LiquidObstacle,i:number,mesh=s.boundary?.mesh):Polygon[]{
  if(!mesh)return cellSolid(w,obstacle,Math.floor(i/w.rows),i%w.rows);
  const region=mesh.regions[i];
  if(region.bulk)return cellSolid(w,obstacle,Math.floor(region.cell/w.rows),region.cell%w.rows);
  if(!obstacle.bodyId&&region.solid?.id===obstacle.colliderId)return [];
  const entry=cached(w,obstacle);entry.regions??=new WeakMap();
  let regions=entry.regions.get(mesh);if(!regions){regions=new Map();entry.regions.set(mesh,regions);}
  const known=regions.get(i);if(known)return known;
  entry.faces??=waterBodySolid(obstacle.collider.shape).faces.map(face=>face.map(p=>add(obstacle.collider.position,liquidRotate(p,obstacle.collider.rotation))));
  let faces=entry.faces;const polygon=region.polygon;
  const signed=polygon.reduce((sum,a,k)=>{const b=polygon[(k+1)%polygon.length];return sum+a.x*b.z-b.x*a.z;},0),sign=Math.sign(signed);
  for(let k=0;k<polygon.length&&faces.length;k++){
    const a=polygon[k],b=polygon[(k+1)%polygon.length],normal={x:sign*(b.z-a.z),y:0,z:sign*(a.x-b.x)};
    faces=clip(faces,normal,normal.x*a.x+normal.z*a.z);
  }
  regions.set(i,faces);return faces;
}
export function waterBodyObstacleRegion(w:WaterBodyManifest,s:WaterBodyState,obstacle:LiquidObstacle,i:number,bed:number,surface:number){
  if(!s.boundary)return waterBodyObstacleColumn(w,obstacle,Math.floor(i/w.rows),i%w.rows,bed,surface);
  const region=s.boundary.mesh.regions[i];
  if(region.bulk)return waterBodyObstacleColumn(w,obstacle,Math.floor(region.cell/w.rows),region.cell%w.rows,bed,surface);
  let faces=regionSolid(w,s,obstacle,i);if(!faces.length)return{volume:0,point:zero()};
  const p=s.boundary.mesh.regions[i].polygon,a=p[0];
  for(let k=1;k+1<p.length;k++){
    const b=p[k],c=p[k+1],dx=b.x-a.x,dz=b.z-a.z,ex=c.x-a.x,ez=c.z-a.z,det=dx*ez-dz*ex;
    if(Math.abs(det)<=1e-20)continue;
    const bx=((b.bed-a.bed)*ez-(c.bed-a.bed)*dz)/det,bz=(dx*(c.bed-a.bed)-ex*(b.bed-a.bed))/det;
    faces=clip(faces,{x:bx,y:-1,z:bz},-(a.bed-bx*a.x-bz*a.z));break;
  }
  return measure(clip(faces,UP,surface));
}
export function waterBodyObstacleRegionBottom(w:WaterBodyManifest,s:WaterBodyState,obstacle:LiquidObstacle,i:number):number {
  let bottom=Infinity;for(const face of regionSolid(w,s,obstacle,i))for(const p of face)bottom=Math.min(bottom,p.y);return bottom;
}
/** Signed closest clearance to the actual planar bed under this footprint. */
export function waterBodyObstacleRegionClearance(w:WaterBodyManifest,s:WaterBodyState,obstacle:LiquidObstacle,i:number,terrainHeight?:(x:number,z:number)=>number):number {
  if(s.boundary?.mesh.placementOnly&&terrainHeight){
    // Placement-only controls deliberately retain the original flat hydraulic
    // bed. Ground contact still sees the physical terrain at the clipped solid
    // footprint; its uphill corner must not be propped up by a water lid.
    let clearance=Infinity;
    for(const face of regionSolid(w,s,obstacle,i))for(const p of face)clearance=Math.min(clearance,p.y-terrainHeight(p.x,p.z));
    return clearance;
  }
  if(!s.boundary)return waterBodyObstacleRegionBottom(w,s,obstacle,i)-s.bed[i];
  const mesh=s.boundary.mesh,reference=mesh.surface;
  if(mesh.regions[i].bulk&&reference){
    // Bulk water keeps its original center-bed pressure law; native support
    // must still see the actual terrain beneath the body's entire footprint.
    let clearance=Infinity;
    for(const j of reference.mesh.cells[mesh.regions[i].cell])if(reference.owners[j]===i){
      const faces=regionSolid(w,s,obstacle,j,reference.mesh);if(!faces.length)continue;
      const p=reference.mesh.regions[j].polygon,a=p[0];let largest=0,bx=0,bz=0;
      for(let k=1;k+1<p.length;k++){const b=p[k],c=p[k+1],dx=b.x-a.x,dz=b.z-a.z,ex=c.x-a.x,ez=c.z-a.z,det=dx*ez-dz*ex;
        if(Math.abs(det)>largest){largest=Math.abs(det);bx=((b.bed-a.bed)*ez-(c.bed-a.bed)*dz)/det;bz=(dx*(c.bed-a.bed)-ex*(b.bed-a.bed))/det;}}
      for(const face of faces)for(const point of face)clearance=Math.min(clearance,point.y-(a.bed+bx*(point.x-a.x)+bz*(point.z-a.z)));
    }
    return clearance;
  }
  const cells=waterBodyCells(w,s);let clearance=Infinity;
  for(const face of regionSolid(w,s,obstacle,i))for(const p of face)clearance=Math.min(clearance,p.y-cells.bedAt(i,p.x,p.z));
  return clearance;
}
export function waterBodyObstacleRegionSection(w:WaterBodyManifest,s:WaterBodyState,obstacle:LiquidObstacle,i:number,height:number){
  return section(regionSolid(w,s,obstacle,i),height,waterBodySolid(obstacle.collider.shape).scale);
}

/** Columns a displacement estimate may step past other solids to reach open water. */
const WATER_BODY_SOLID_REACH=6;
/** The water ledger stores only liquid. A submerged solid occupies additional
 * column height, changing the hydraulic head without creating any water. Use
 * the previous accepted exterior surface for this moving-boundary update;
 * the following conservative grid solve carries displaced water outwards.
 * Shape clipping, rather than an AABB, preserves tapered rocks and thin fins.
 */
export function waterBodySolidDepth(w:WaterBodyManifest,s:WaterBodyState,obstacles:LiquidObstacle[]):number[]{
  if(s.boundary){
    const boundary=s.boundary,regions=boundary.mesh.regions;
    if(regions.length!==s.depth.length||regions.some((r,i)=>!r.bulk||r.cell!==i))return regionSolidDepth(w,s,obstacles);
    // An uncut basin has the original four cardinal exterior samples. A
    // graph-wide average changes a floating hull's waterline and can feed its
    // own displacement waves back into its support, despite identical cells.
    // Actual placement cuts retain the connected-side sampling below.
    const depth=boundary.volume.map(v=>v/w.cellArea),occupied=rectangularSolidDepth(w,{...s,depth,boundary:undefined},obstacles);
    boundary.solidDepth=occupied.map((h,i)=>h*w.cellArea/regions[i].area);
    waterBodyCells(w,s).commit();return s.solidDepth!;
  }
  return rectangularSolidDepth(w,s,obstacles);
}
function rectangularSolidDepth(w:WaterBodyManifest,s:WaterBodyState,obstacles:LiquidObstacle[]):number[]{
  const occupied=Array(s.depth.length).fill(0),capacity=Array(s.depth.length).fill(0);let tests=0;
  for(const obstacle of obstacles){
    const mesh=waterBodySolid(obstacle.collider.shape);
    const x0=Math.max(0,Math.floor((obstacle.min.x-w.origin.x)/w.cellSizeX)),x1=Math.min(w.columns-1,Math.floor((obstacle.max.x-w.origin.x)/w.cellSizeX));
    const z0=Math.max(0,Math.floor((obstacle.min.z-w.origin.z)/w.cellSizeZ)),z1=Math.min(w.rows-1,Math.floor((obstacle.max.z-w.origin.z)/w.cellSizeZ));
    if(x0>x1||z0>z1)continue;
    for(let x=x0;x<=x1;x++)for(let z=z0;z<=z1;z++){
      if(++tests>32768)throw new Error('Water body solid column budget exceeded; stream fewer solids');
      const i=x*w.rows+z,bed=s.bed[i];
      // The pressure head inside an intersecting solid is a volume proxy,
      // not an independent free surface. Feeding that raised head back into
      // its own immersion made buoyant bodies pump themselves up and down.
      // Interpolate the actual adjacent waterline just beyond this footprint.
      // Step past columns another solid occupies: a neighbouring hull's head
      // is its own pressure proxy, and two tight hulls reading each other's
      // closed a displacement loop between them.
      let weighted=0,weights=0;
      for(const [sx,sz,dx,dz] of [[x0-1,z,-1,0],[x1+1,z,1,0],[x,z0-1,0,-1],[x,z1+1,0,1]]){
        let xx=sx,zz=sz;
        for(let k=0;k<WATER_BODY_SOLID_REACH&&xx>=0&&xx<w.columns&&zz>=0&&zz<w.rows&&(s.solidDepth?.[xx*w.rows+zz]??0)>1e-9;k++){
          if(xx+dx<0||xx+dx>=w.columns||zz+dz<0||zz+dz>=w.rows)break;xx+=dx;zz+=dz;}
        if(xx<0||xx>=w.columns||zz<0||zz>=w.rows)continue;
        const j=xx*w.rows+zz;if(s.depth[j]<=w.dryDepth)continue;
        const weight=1/Math.max(w.cellSizeX,w.cellSizeZ,Math.hypot((xx-x)*w.cellSizeX,(zz-z)*w.cellSizeZ));
        weighted+=(s.bed[j]+s.depth[j]+(s.solidDepth?.[j]??0))*weight;weights+=weight;
      }
      const surface=weights?weighted/weights:bed+s.depth[i]+(s.solidDepth?.[i]??0);
      capacity[i]=Math.max(capacity[i],surface-bed);
      if(surface<=bed+w.dryDepth||obstacle.min.y>=surface||obstacle.max.y<=bed)continue;
      occupied[i]+=waterBodyObstacleColumn(w,obstacle,x,z,bed,surface).volume*mesh.scale/w.cellArea;
    }
  }
  // Overlapping authored collision children may not occupy more than the
  // entire column. No volume is removed: depth is always real liquid volume.
  for(let i=0;i<occupied.length;i++)occupied[i]=Math.max(0,Math.min(occupied[i],capacity[i]));
  return occupied;
}

function regionSolidDepth(w:WaterBodyManifest,s:WaterBodyState,obstacles:LiquidObstacle[]):number[]{
  const cells=waterBodyCells(w,s),occupied=Array(cells.count).fill(0),capacity=Array(cells.count).fill(0),adjacent:number[][]=Array.from({length:cells.count},()=>[]);
  for(const face of cells.faces())if(face.b>=0){
    const crest=Math.min(face.start.bed,face.end.bed);
    if(Math.min(cells.level(face.a),cells.level(face.b))>crest+w.dryDepth){adjacent[face.a].push(face.b);adjacent[face.b].push(face.a);}
  }
  let tests=0;
  for(const obstacle of obstacles){
    const mesh=waterBodySolid(obstacle.collider.shape),indices=cells.indices({min:obstacle.min,max:obstacle.max}),footprint=new Set(indices);
    for(const i of indices){
      if(++tests>32768)throw new Error('Water body solid column budget exceeded; stream fewer solids');
      const region=s.boundary!.mesh.regions[i];if(!obstacle.bodyId&&region.solid?.id===obstacle.colliderId)continue;
      const center=cells.center(i),bed=cells.bed(i),seen=new Set([i]),queue=[{i,distance:0}];let weighted=0,weights=0;
      // Exterior samples must be hydraulically connected. The other pool in
      // this same base square is never an exterior sample across its wall.
      for(let at=0;at<queue.length;at++){
        const entry=queue[at];
        if(entry.i!==i&&!footprint.has(entry.i)&&(cells.solidDepth[entry.i]??0)<=1e-9&&cells.depth(entry.i)>w.dryDepth){
          const p=cells.center(entry.i),weight=1/Math.max(Math.sqrt(cells.area(entry.i)),Math.hypot(p.x-center.x,p.z-center.z));
          weighted+=cells.level(entry.i)*weight;weights+=weight;continue;
        }
        if(entry.distance>=WATER_BODY_SOLID_REACH)continue;
        for(const j of adjacent[entry.i])if(!seen.has(j)){seen.add(j);queue.push({i:j,distance:entry.distance+1});}
      }
      const surface=weights?weighted/weights:cells.level(i);capacity[i]=Math.max(capacity[i],surface-bed);
      if(surface<=bed+w.dryDepth||obstacle.min.y>=surface||obstacle.max.y<=bed)continue;
      occupied[i]+=waterBodyObstacleRegion(w,s,obstacle,i,bed,surface).volume*mesh.scale/cells.area(i);
    }
  }
  for(let i=0;i<occupied.length;i++)cells.solidDepth[i]=Math.max(0,Math.min(occupied[i],capacity[i]));
  cells.commit();return s.solidDepth!;
}
