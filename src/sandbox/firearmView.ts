import {CircleGeometry,Color,CylinderGeometry,DataTexture,DynamicDrawUsage,Group,InstancedMesh,Matrix4,MeshBasicMaterial,Quaternion,Vector3} from 'three';
import type {FirearmVector} from './firearms.ts';

export interface FirearmVisualShot {id:string|number;timeMs:number;from:FirearmVector;to:FirearmVector;normal?:FirearmVector;surface?:boolean}
/** Fixed-size pools: no per-shot geometry/material allocation, no replayed
 * effects when a network snapshot repeats a shot, and no unbounded decals. */
export class FirearmShotEffects {
  readonly root=new Group();
  private readonly trails:InstancedMesh;
  private readonly marks:InstancedMesh;
  private readonly seen=new Map<string|number,number>();
  private readonly shots:FirearmVisualShot[]=[];
  private readonly impacts:FirearmVisualShot[]=[];
  private readonly matrix=new Matrix4();
  private readonly q=new Quaternion();
  private readonly p=new Vector3();
  private readonly scale=new Vector3();
  private readonly texture:DataTexture;
  private readonly maxTrails:number;
  private readonly maxMarks:number;
  private readonly lifetime:number;
  constructor(options:{maxTrails?:number;maxMarks?:number;markLifetimeMs?:number;color?:number|string}={}){
    this.maxTrails=Math.max(1,Math.min(256,Math.floor(options.maxTrails??64)));
    this.maxMarks=Math.max(1,Math.min(1024,Math.floor(options.maxMarks??192)));
    this.lifetime=Math.max(100,Math.min(120000,options.markLifetimeMs??20000));
    const data=new Uint8Array(32*32*4);
    for(let y=0;y<32;y++)for(let x=0;x<32;x++){const r=Math.hypot(x-15.5,y-15.5)/15.5,i=(y*32+x)*4,edge=.86+Math.sin(x*13+y*7)*.08;data[i]=data[i+1]=data[i+2]=r<.36?9:48;data[i+3]=Math.round(255*Math.max(0,Math.min(1,(edge-r)*8))*(r<.36?1:.68));}
    this.texture=new DataTexture(data,32,32);this.texture.needsUpdate=true;
    this.trails=new InstancedMesh(new CylinderGeometry(1,1,1,4),new MeshBasicMaterial({color:new Color(options.color??0xffe4ae),transparent:true,opacity:.8,depthWrite:false}),this.maxTrails);
    this.marks=new InstancedMesh(new CircleGeometry(1,12),new MeshBasicMaterial({map:this.texture,transparent:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2}),this.maxMarks);
    for(const mesh of [this.trails,this.marks]){mesh.count=0;mesh.frustumCulled=false;mesh.instanceMatrix.setUsage(DynamicDrawUsage);this.root.add(mesh);}
    this.root.name='firearm-shot-effects';
  }
  update(events:readonly FirearmVisualShot[],nowMs:number):void{
    for(const event of events){
      if(this.seen.has(event.id)||nowMs-event.timeMs>1000||event.timeMs>nowMs+100)continue;
      if(![event.from.x,event.from.y,event.from.z,event.to.x,event.to.y,event.to.z,event.timeMs].every(Number.isFinite))continue;
      this.seen.set(event.id,nowMs);
      if(this.shots.length===this.maxTrails)this.shots.shift();this.shots.push(event);
      if(event.surface&&event.normal&&Math.hypot(event.normal.x,event.normal.y,event.normal.z)>.5){if(this.impacts.length===this.maxMarks)this.impacts.shift();this.impacts.push(event);}
    }
    for(const [id,time]of this.seen)if(nowMs-time>5000)this.seen.delete(id);
    while(this.seen.size>2048)this.seen.delete(this.seen.keys().next().value!);
    let count=0;
    for(let i=this.shots.length-1;i>=0;i--){const shot=this.shots[i],age=nowMs-shot.timeMs;if(age>100){this.shots.splice(i,1);continue;}const from=new Vector3(shot.from.x,shot.from.y,shot.from.z),delta=new Vector3(shot.to.x,shot.to.y,shot.to.z).sub(from),length=delta.length();if(length<.001)continue;
      const direction=delta.divideScalar(length),head=Math.min(length,Math.max(.05,age)*2.4),tail=Math.max(0,head-12),span=Math.max(.01,head-tail);
      this.p.copy(from).addScaledVector(direction,(head+tail)/2);this.q.setFromUnitVectors(new Vector3(0,1,0),direction);this.scale.set(.008,span,.008);this.matrix.compose(this.p,this.q,this.scale);this.trails.setMatrixAt(count++,this.matrix);
    }
    this.trails.count=count;this.trails.instanceMatrix.needsUpdate=true;count=0;
    for(let i=this.impacts.length-1;i>=0;i--){const shot=this.impacts[i],age=nowMs-shot.timeMs;if(age>this.lifetime){this.impacts.splice(i,1);continue;}const normal=new Vector3(shot.normal!.x,shot.normal!.y,shot.normal!.z).normalize();this.p.set(shot.to.x,shot.to.y,shot.to.z).addScaledVector(normal,.004);this.q.setFromUnitVectors(new Vector3(0,0,1),normal);const size=.055*Math.min(1,(this.lifetime-age)/500);this.scale.set(size,size,size);this.matrix.compose(this.p,this.q,this.scale);this.marks.setMatrixAt(count++,this.matrix);}
    this.marks.count=count;this.marks.instanceMatrix.needsUpdate=true;
  }
  reset():void{this.seen.clear();this.shots.length=this.impacts.length=0;this.trails.count=this.marks.count=0;}
  inspection(){return {trails:this.trails.count,marks:this.marks.count,maxTrails:this.maxTrails,maxMarks:this.maxMarks,seen:this.seen.size};}
  dispose():void{this.reset();this.root.removeFromParent();for(const mesh of [this.trails,this.marks]){mesh.geometry.dispose();(mesh.material as MeshBasicMaterial).dispose();mesh.dispose();}this.texture.dispose();}
}
