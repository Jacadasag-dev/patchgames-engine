/** Optional bounded diagnostic trails of accepted current velocities. This
 * reads water state only; it creates no motion, water, forces or particle work. */
import {BufferAttribute,BufferGeometry,Color,Group,LineDashedMaterial,LineSegments} from 'three';
import {sampleWaterBody,type WaterBodyManifest,type WaterBodyState} from './waterBody.ts';
import {sampleBoundaryWater,validateBoundaryState} from './waterBoundary.ts';
import {waterBodyCells} from './waterBodyCells.ts';

export interface WaterCurrentLinesOptions {
  maxLines?:number;steps?:number;stepSeconds?:number;color?:string;opacity?:number;minSpeed?:number;offset?:number;
  /** Diagnostic streamline length in metres, default .8. Curves show flow
   * direction even at low speed; dash travel always uses actual velocity.
   * Each segment is still capped below a quarter cell and clipped by water. */
  minLength?:number;
  /** Underwater trails through the 3D (depth) currents, default 48; 0 hides
   * them. They start where water moves most vertically and follow the full
   * velocity until the bed, the surface, a wall or dry ground. They are drawn
   * through the water surface, so they also show in front of submerged objects. */
  depthLines?:number;
  /** Underwater trail colors where water sinks and where it rises. */
  downColor?:string;upColor?:string;
}
interface Sample {x:number;z:number;y:number;vx:number;vz:number;cell:number}
interface Point {x:number;y:number;z:number}
const bounded=(value:number|undefined,fallback:number,min:number,max:number,name:string)=>{
  const result=value??fallback;if(!Number.isFinite(result)||result<min||result>max)throw new Error(`Invalid water current lines ${name}`);return result;
};

export class WaterCurrentLinesView {
  readonly root=new Group();readonly geometry=new BufferGeometry();readonly material:LineDashedMaterial;
  readonly water:WaterBodyManifest;
  private readonly count:number;private readonly steps:number;private readonly seconds:number;private readonly minimum:number;private readonly offset:number;private readonly minLength:number;
  private readonly positions:Float32Array;private readonly distances:Float32Array;private readonly speeds:Float32Array;
  private readonly clock={value:0};
  constructor(water:WaterBodyManifest,options:WaterCurrentLinesOptions={}) {
    this.water=water;
    // Three sorts transparent objects by their containing Group first. Put
    // the whole diagnostic group after the pool/local-water groups; setting
    // only the LineSegments order lets transparent water cover the trails.
    this.root.renderOrder=3;
    this.count=bounded(options.maxLines,96,1,512,'maxLines');this.steps=bounded(options.steps,12,1,32,'steps');
    if(!Number.isInteger(this.count)||!Number.isInteger(this.steps))throw new Error('Water current line budgets must be integers');
    this.seconds=bounded(options.stepSeconds,.12,.001,1,'stepSeconds');this.minimum=bounded(options.minSpeed,.025,0,100,'minSpeed');this.offset=bounded(options.offset,.018,0,.2,'offset');
    this.minLength=bounded(options.minLength,.8,0,8,'minLength');
    this.positions=new Float32Array(this.count*this.steps*6);this.distances=new Float32Array(this.count*this.steps*2);this.speeds=new Float32Array(this.distances.length);
    this.geometry.setAttribute('position',new BufferAttribute(this.positions,3));this.geometry.setAttribute('lineDistance',new BufferAttribute(this.distances,1));this.geometry.setAttribute('currentSpeed',new BufferAttribute(this.speeds,1));this.geometry.setDrawRange(0,0);
    this.material=new LineDashedMaterial({color:options.color??'#b9eadb',opacity:bounded(options.opacity,.5,0,1,'opacity'),transparent:true,depthWrite:false,dashSize:.16,gapSize:.26});
    this.material.onBeforeCompile=shader=>{
      shader.uniforms.waterCurrentLineTime=this.clock;
      shader.vertexShader='uniform float waterCurrentLineTime;\nattribute float currentSpeed;\n'+shader.vertexShader;
      shader.vertexShader=shader.vertexShader.replace('vLineDistance = scale * lineDistance;', 'vLineDistance = scale * (lineDistance - waterCurrentLineTime * currentSpeed);');
    };
    this.material.customProgramCacheKey=()=> 'water-current-lines-v1';
    const lines=new LineSegments(this.geometry,this.material);lines.frustumCulled=false;lines.renderOrder=3;this.root.add(lines);
    // Underwater trails are an x-ray overlay: deep water renders nearly opaque
    // and writes depth, so they draw after it without a depth test.
    this.depthCount=bounded(options.depthLines,48,0,512,'depthLines');if(!Number.isInteger(this.depthCount))throw new Error('Water current line budgets must be integers');
    this.down=new Color(options.downColor??'#ff3d9a');this.up=new Color(options.upColor??'#a6ff3d');
    this.depthPositions=new Float32Array(this.depthCount*this.steps*6);this.depthColors=new Float32Array(this.depthPositions.length);
    this.depthDistances=new Float32Array(this.depthCount*this.steps*2);this.depthSpeeds=new Float32Array(this.depthDistances.length);
    this.depthGeometry.setAttribute('position',new BufferAttribute(this.depthPositions,3));this.depthGeometry.setAttribute('color',new BufferAttribute(this.depthColors,3));
    this.depthGeometry.setAttribute('lineDistance',new BufferAttribute(this.depthDistances,1));this.depthGeometry.setAttribute('currentSpeed',new BufferAttribute(this.depthSpeeds,1));this.depthGeometry.setDrawRange(0,0);
    this.depthMaterial=new LineDashedMaterial({vertexColors:true,opacity:1,transparent:true,depthWrite:false,depthTest:false,dashSize:.2,gapSize:.08});
    this.depthMaterial.onBeforeCompile=this.material.onBeforeCompile;this.depthMaterial.customProgramCacheKey=()=> 'water-current-depth-lines-v1';
    const depthLines=new LineSegments(this.depthGeometry,this.depthMaterial);depthLines.frustumCulled=false;
    this.depthRoot.renderOrder=4;this.depthRoot.add(depthLines);this.root.add(this.depthRoot);
  }
  readonly depthRoot=new Group();readonly depthGeometry=new BufferGeometry();readonly depthMaterial:LineDashedMaterial;
  private readonly depthCount:number;private readonly down:Color;private readonly up:Color;
  private readonly depthPositions:Float32Array;private readonly depthColors:Float32Array;private readonly depthDistances:Float32Array;private readonly depthSpeeds:Float32Array;
  /** Use simulation time, including during pause/replay, rather than wall time. */
  animate(seconds:number):void {if(!Number.isFinite(seconds))throw new Error('Invalid water current lines clock');this.clock.value=seconds;}
  update(state:WaterBodyState):void {
    const w=this.water,n=w.columns*w.rows;
    if(state.waterRevision!==w.revision||[state.depth,state.flowX,state.flowZ,state.bed].some(a=>a.length!==n)||state.bedVertices.length!==(w.columns+1)*(w.rows+1)
      ||state.barrierX.length!==(w.columns+1)*w.rows||state.barrierZ.length!==w.columns*(w.rows+1))throw new Error('Current line state must match its manifest');
    if(state.bedVertices.some(v=>!Number.isFinite(v))||state.solidDepth?.some(v=>!Number.isFinite(v)||v<0))throw new Error('Invalid current line terrain');
    for(let i=0;i<n;i++)if(!Number.isFinite(state.depth[i])||state.depth[i]<0||!Number.isFinite(state.flowX[i])||!Number.isFinite(state.flowZ[i])||!Number.isFinite(state.bed[i]))throw new Error('Invalid current line state');
    if(state.boundary){this.updateRefined(state);this.animate(state.time);return;}
    const surface=(i:number)=>state.bed[i]+state.depth[i]+(state.solidDepth?.[i]??0);
    const blocked=(a:number,b:number)=>{
      if(a===b)return false;
      const ax=Math.floor(a/w.rows),az=a%w.rows,bx=Math.floor(b/w.rows),bz=b%w.rows;
      const signature=ax!==bx?state.barrierX[Math.max(ax,bx)*w.rows+az]:state.barrierZ[ax*(w.rows+1)+Math.max(az,bz)];
      if(!signature)return false;const fields=signature.split('|'),top=Number(fields.at(-1)),bottom=Number(fields.at(-2));
      return Number.isFinite(top)&&Number.isFinite(bottom)&&top>=Math.min(surface(a),surface(b))&&bottom<Math.max(surface(a),surface(b));
    };
    const connected=(a:number,b:number)=>{
      const ax=Math.floor(a/w.rows),az=a%w.rows,bx=Math.floor(b/w.rows),bz=b%w.rows;
      if(Math.abs(ax-bx)>1||Math.abs(az-bz)>1)return false;
      if(ax===bx||az===bz)return !blocked(a,b);
      // A diagonal cannot cut through a closed corner or a dry intermediate.
      const x=bx*w.rows+az,z=ax*w.rows+bz;
      return state.depth[x]>w.wetDepth&&state.depth[z]>w.wetDepth&&!blocked(a,x)&&!blocked(x,b)&&!blocked(a,z)&&!blocked(z,b);
    };
    const sample=(x:number,z:number):Sample|undefined=>{
      const gx=(x-w.origin.x)/w.cellSizeX,gz=(z-w.origin.z)/w.cellSizeZ,cx=Math.floor(gx),cz=Math.floor(gz);
      if(cx<0||cz<0||cx>=w.columns||cz>=w.rows)return;
      const cell=cx*w.rows+cz;if(state.depth[cell]<=w.wetDepth)return;
      // Interpolate connected center samples; never borrow flow across a dam.
      const ix=Math.floor(gx-.5),iz=Math.floor(gz-.5),fx=gx-.5-ix,fz=gz-.5-iz;
      let weight=0,y=0,vx=0,vz=0;
      for(let a=0;a<2;a++)for(let b=0;b<2;b++){
        const xx=ix+a,zz=iz+b;if(xx<0||zz<0||xx>=w.columns||zz>=w.rows)continue;
        const i=xx*w.rows+zz;if(state.depth[i]<=w.wetDepth||!connected(cell,i))continue;
        const share=(a?fx:1-fx)*(b?fz:1-fz);weight+=share;y+=surface(i)*share;vx+=state.flowX[i]*share;vz+=state.flowZ[i]*share;
      }
      if(weight<=0)return;y/=weight;vx/=weight;vz/=weight;
      const dx=gx-cx,dz=gz-cz,v=cx*(w.rows+1)+cz;
      const bed=(state.bedVertices[v]*(1-dz)+state.bedVertices[v+1]*dz)*(1-dx)+(state.bedVertices[v+w.rows+1]*(1-dz)+state.bedVertices[v+w.rows+2]*dz)*dx;
      if(y-bed<=w.wetDepth||Math.hypot(vx,vz)<=this.minimum)return;
      return{x,z,y:y+this.offset,vx,vz,cell};
    };
    const wet:number[]=[];for(let i=0;i<n;i++)if(state.depth[i]>w.wetDepth&&Math.hypot(state.flowX[i],state.flowZ[i])>this.minimum)wet.push(i);
    let vertex=0;const lines=Math.min(this.count,wet.length),limit=Math.min(w.cellSizeX,w.cellSizeZ)*.24;
    for(let k=0;k<lines;k++){
      const i=wet[Math.floor((k+.5)*wet.length/lines)];
      let current=sample(w.origin.x+(Math.floor(i/w.rows)+.5)*w.cellSizeX,w.origin.z+(i%w.rows+.5)*w.cellSizeZ),distance=0;
      for(let step=0;step<this.steps&&current;step++){
        // Integrate direction in space, rather than stretching simulation
        // time: low speeds remain readable without crossing many cells when
        // their neighboring velocity is faster. Motion still uses real m/s.
        const speed=Math.hypot(current.vx,current.vz),distanceStep=Math.min(limit,Math.max(speed*this.seconds,this.minLength/this.steps));
        const middle=sample(current.x+current.vx/speed*distanceStep*.5,current.z+current.vz/speed*distanceStep*.5);if(!middle||!connected(current.cell,middle.cell))break;
        const middleSpeed=Math.hypot(middle.vx,middle.vz);
        const next=sample(current.x+middle.vx/middleSpeed*distanceStep,current.z+middle.vz/middleSpeed*distanceStep);if(!next||!connected(current.cell,next.cell))break;
        const length=Math.hypot(next.x-current.x,next.z-current.z);
        for(const [point,at] of [[current,distance],[next,distance+length]] as const){this.positions.set([point.x,point.y,point.z],vertex*3);this.distances[vertex]=at;this.speeds[vertex]=Math.hypot(point.vx,point.vz);vertex++;}
        distance+=length;current=next;
      }
    }
    this.geometry.setDrawRange(0,vertex);for(const key of ['position','lineDistance','currentSpeed'])this.geometry.getAttribute(key).needsUpdate=true;
    this.traceDepth(state,connected,limit);
    this.animate(state.time);
  }
  /** Underwater trails: seeds at three heights in a bounded spread of columns,
   * kept where water moves most vertically, then integrated through the full
   * 3D velocity (midpoint rule) inside the water. Empty while currents sleep. */
  private traceDepth(state:WaterBodyState,connected:(a:number,b:number)=>boolean,limit:number,clear?:(a:Point,b:Point)=>boolean):void {
    const w=this.water,d=state.depthCurrents,cells=state.boundary?waterBodyCells(w,state):undefined;let vertex=0;
    if(this.depthCount&&d&&!d.sleeping){
      const cellOf=(x:number,z:number)=>{if(cells)return cells.locate({x,z})??-1;const cx=Math.floor((x-w.origin.x)/w.cellSizeX),cz=Math.floor((z-w.origin.z)/w.cellSizeZ);return cx<0||cz<0||cx>=w.columns||cz>=w.rows?-1:cx*w.rows+cz;};
      const at=(x:number,y:number,z:number)=>{
        const cell=cellOf(x,z);if(cell<0||(cells?cells.depth(cell):state.depth[cell])<=w.wetDepth)return;
        const sample=sampleWaterBody(w,state,{x,y,z});if(!sample||y<=sample.bed+.01||y>=sample.surface-.01)return;
        const v=sample.velocity,speed=Math.hypot(v.x,v.y,v.z);return speed>this.minimum?{x,y,z,v,speed,cell}:undefined;
      };
      // At most ~150 candidate columns, three heights each: seeding is the
      // larger cost, and the strongest vertical flows are spatially coherent.
      const n=w.columns*w.rows,stride=Math.max(1,Math.round(Math.sqrt(n/150))),candidates:NonNullable<ReturnType<typeof at>>[]=[];
      if(cells){
        const stride=Math.max(1,Math.ceil(cells.count/150));
        for(let i=0;i<cells.count;i+=stride){const center=cells.center(i),bed=cells.bedAt(i,center.x,center.z),head=cells.level(i);if(head-bed<=w.wetDepth*4)continue;
          for(const fraction of [.25,.5,.75]){const p=at(center.x,bed+(head-bed)*fraction,center.z);if(p&&Math.abs(p.v.y)>1e-4)candidates.push(p);}}
      }else for(let x=0;x<w.columns;x+=stride)for(let z=0;z<w.rows;z+=stride){const i=x*w.rows+z;if(state.depth[i]<=w.wetDepth*4)continue;
        for(const fraction of [.25,.5,.75]){const p=at(w.origin.x+(x+.5)*w.cellSizeX,state.bed[i]+state.depth[i]*fraction,w.origin.z+(z+.5)*w.cellSizeZ);if(p&&Math.abs(p.v.y)>1e-4)candidates.push(p);}}
      candidates.sort((a,b)=>Math.abs(b.v.y)-Math.abs(a.v.y));
      const pool=candidates.slice(0,this.depthCount*2),lines=Math.min(this.depthCount,pool.length),color=new Color();
      for(let k=0;k<lines;k++){
        let current=at(pool[Math.floor((k+.5)*pool.length/lines)].x,pool[Math.floor((k+.5)*pool.length/lines)].y,pool[Math.floor((k+.5)*pool.length/lines)].z),distance=0;
        for(let step=0;step<this.steps&&current;step++){
          const length=Math.min(limit,Math.max(current.speed*this.seconds,this.minLength/this.steps)),s=length/current.speed;
          const middle=at(current.x+current.v.x*s*.5,current.y+current.v.y*s*.5,current.z+current.v.z*s*.5);if(!middle||!connected(current.cell,middle.cell)||clear&&!clear(current,middle))break;
          const m=length/middle.speed,next=at(current.x+middle.v.x*m,current.y+middle.v.y*m,current.z+middle.v.z*m);if(!next||!connected(current.cell,next.cell)||clear&&!clear(current,next))break;
          const segment=Math.hypot(next.x-current.x,next.y-current.y,next.z-current.z);
          for(const [point,travelled] of [[current,distance],[next,distance+segment]] as const){
            // Blend from the rising to the sinking color by vertical direction.
            color.copy(this.up).lerp(this.down,.5-.5*Math.max(-1,Math.min(1,point.v.y/Math.max(point.speed,1e-9))));
            this.depthPositions[vertex*3]=point.x;this.depthPositions[vertex*3+1]=point.y;this.depthPositions[vertex*3+2]=point.z;
            this.depthColors[vertex*3]=color.r;this.depthColors[vertex*3+1]=color.g;this.depthColors[vertex*3+2]=color.b;
            this.depthDistances[vertex]=travelled;this.depthSpeeds[vertex]=point.speed;vertex++;
          }
          distance+=segment;current=next;
        }
      }
    }
    this.depthGeometry.setDrawRange(0,vertex);for(const key of ['position','color','lineDistance','currentSpeed'])this.depthGeometry.getAttribute(key).needsUpdate=true;
  }
  /** Exact region seeds and segment clipping keep diagnostic strokes on their
   * own side even when a thin wall lies between both integration endpoints. */
  private updateRefined(state:WaterBodyState):void {
    validateBoundaryState(this.water,state);
    const w=this.water,cells=waterBodyCells(w,state),faces=cells.faces(),limit=Math.min(w.cellSizeX,w.cellSizeZ)*.24;
    const barrierFaces:number[][]=Array.from({length:cells.count},()=>[]);
    faces.forEach((f,i)=>{if(f.barrier&&f.b>=0){barrierFaces[f.a].push(i);barrierFaces[f.b].push(i);}});
    const clear=(a:Point,b:Point,underwater:boolean)=>{
      const dx=b.x-a.x,dz=b.z-a.z,barriers=new Set<number>();
      for(const i of cells.indices({min:{x:Math.min(a.x,b.x),z:Math.min(a.z,b.z)},max:{x:Math.max(a.x,b.x),z:Math.max(a.z,b.z)}})){
        const polygon=cells.polygon(i);let low=0,high=1;
        for(let k=0;k<polygon.length&&low<=high;k++){
          const p=polygon[k],q=polygon[(k+1)%polygon.length],start=(q.x-p.x)*(a.z-p.z)-(q.z-p.z)*(a.x-p.x),change=(q.x-p.x)*dz-(q.z-p.z)*dx;
          if(Math.abs(change)<1e-15){if(start< -1e-10){low=1;high=0;}continue;}
          const t=-start/change;if(change>0)low=Math.max(low,t);else high=Math.min(high,t);
        }
        if(high-low<1e-10)continue;
        for(const edge of barrierFaces[i])barriers.add(edge);
        const head=cells.level(i);
        for(const t of [low,high]){const x=a.x+dx*t,z=a.z+dz*t,bed=cells.bedAt(i,x,z),y=a.y+(b.y-a.y)*t;
          if(head-bed<=w.wetDepth||underwater&&(y<=bed||y>=head))return false;}
      }
      // Volumetric moving sheets still use the ordinary grid-face barrier.
      for(const edge of barriers){const f=faces[edge];if(f.barrier&&f.barrier.top>=Math.min(cells.level(f.a),cells.level(f.b))){
        const ex=f.end.x-f.start.x,ez=f.end.z-f.start.z,den=dx*ez-dz*ex;if(Math.abs(den)<1e-15)continue;
        const px=f.start.x-a.x,pz=f.start.z-a.z,t=(px*ez-pz*ex)/den,u=(px*dz-pz*dx)/den;
        if(t>1e-9&&t<1-1e-9&&u>=0&&u<=1){const y=a.y+(b.y-a.y)*t;if(y>=f.barrier.bottom&&y<=f.barrier.top+this.offset)return false;}
      }}
      return true;
    };
    const sample=(x:number,z:number):Sample|undefined=>{
      const p=sampleBoundaryWater(w,state,{x,z});if(!p||p.depth<=w.wetDepth||Math.hypot(p.velocity.x,p.velocity.z)<=this.minimum)return;
      return{x,z,y:p.surface+this.offset,vx:p.velocity.x,vz:p.velocity.z,cell:p.region};
    };
    const wet:number[]=[];for(let i=0;i<cells.count;i++)if(cells.depth(i)>w.wetDepth&&Math.hypot(cells.flowX[i],cells.flowZ[i])>this.minimum)wet.push(i);
    const count=Math.min(this.count,wet.length);let vertex=0;
    for(let k=0;k<count;k++){
      const i=wet[Math.floor((k+.5)*wet.length/count)],center=cells.center(i);let current=sample(center.x,center.z),distance=0;
      for(let step=0;step<this.steps&&current;step++){
        const speed=Math.hypot(current.vx,current.vz);let length=Math.min(limit,Math.max(speed*this.seconds,this.minLength/this.steps)),next:Sample|undefined;
        // A region may be narrower than the regular integration step. Shorten
        // the stroke at its boundary instead of suppressing the whole trail.
        for(let attempt=0;attempt<8;attempt++,length*=.5){
          const middle=sample(current.x+current.vx/speed*length*.5,current.z+current.vz/speed*length*.5);if(!middle||!clear(current,middle,false))continue;
          const middleSpeed=Math.hypot(middle.vx,middle.vz),candidate=sample(current.x+middle.vx/middleSpeed*length,current.z+middle.vz/middleSpeed*length);
          if(candidate&&clear(current,candidate,false)){next=candidate;break;}
        }
        if(!next)break;
        const travelled=Math.hypot(next.x-current.x,next.z-current.z);
        for(const [p,d] of [[current,distance],[next,distance+travelled]] as const){this.positions.set([p.x,p.y,p.z],vertex*3);this.distances[vertex]=d;this.speeds[vertex]=Math.hypot(p.vx,p.vz);vertex++;}
        distance+=travelled;current=next;
      }
    }
    this.geometry.setDrawRange(0,vertex);for(const key of ['position','lineDistance','currentSpeed'])this.geometry.getAttribute(key).needsUpdate=true;
    this.traceDepth(state,()=>true,limit,(a,b)=>clear(a,b,true));
  }
  dispose():void {this.geometry.dispose();this.material.dispose();this.depthGeometry.dispose();this.depthMaterial.dispose();this.root.clear();this.root.removeFromParent();}
}
