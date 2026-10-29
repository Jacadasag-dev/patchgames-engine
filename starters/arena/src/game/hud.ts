import * as THREE from 'three';
import {ARENA_LOOT,lootPanelLayout,type LootRect} from './lootUi.ts';
import type {PlayerState,WorldState} from './shapes.ts';

/** Canvas HUD lives in the normal sandbox view, including saved games/replays. */
export class ArenaHud {
  private readonly canvas=new OffscreenCanvas(960,540);
  private readonly context=this.canvas.getContext('2d')!;
  private texture=new THREE.CanvasTexture(this.canvas);
  private readonly material=new THREE.MeshBasicMaterial({map:this.texture,transparent:true,depthTest:false,depthWrite:false,toneMapped:false});
  private readonly geometry=new THREE.PlaneGeometry(2,2);
  private readonly scene=new THREE.Scene();
  private readonly camera=new THREE.Camera();
  private key='';
  private dirty=true;
  constructor(){this.scene.add(new THREE.Mesh(this.geometry,this.material));this.configureTexture();}
  private configureTexture(){this.texture.colorSpace=THREE.SRGBColorSpace;this.texture.minFilter=THREE.LinearFilter;this.texture.generateMipmaps=false;}
  resize(width:number,height:number){
    width=Math.max(1,Math.round(width));height=Math.max(1,Math.round(height));
    if(this.canvas.width===width&&this.canvas.height===height)return;
    // WebGL allocates immutable texture storage. A new source is required after
    // resizing, otherwise subsequent HUD uploads retain the old dimensions.
    this.texture.dispose();this.canvas.width=width;this.canvas.height=height;
    this.texture=new THREE.CanvasTexture(this.canvas);this.configureTexture();this.material.map=this.texture;
    this.key='';this.dirty=true;
  }
  update(state:PlayerState|undefined,world:WorldState|null,hp:number,maxHp:number,lines:readonly string[],bandageDurationMs:number) {
    const w=this.canvas.width,h=this.canvas.height,chest=hp>0?world?.supplies.find(item=>item.id===state?.chestId):undefined;
    const next=JSON.stringify([hp,maxHp,bandageDurationMs,state?.equipped,state?.sword,state?.bow,state?.arrows,state?.bandages,Math.round((state?.bandageMs??0)/100),
      state?.armorFace,state?.armorChest,state?.armorLegs,state?.armorArms,chest?.id,chest?.loot,
      Math.round((state?.chestCursorX??.5)*w),Math.round((state?.chestCursorY??.5)*h),lines]);
    if(next===this.key)return;this.key=next;this.dirty=true;
    const c=this.context;c.clearRect(0,0,w,h);
    const scale=Math.min(1,w/800,h/520),font=(size:number)=>{c.font=`${size*scale}px sans-serif`;};
    const panel=(x:number,y:number,width:number,height:number)=>{c.fillStyle='#14241eeb';c.fillRect(x,y,width,height);c.strokeStyle='#b8a67a';c.lineWidth=1;c.strokeRect(x,y,width,height);};
    if(!state)return;
    panel(16*scale,16*scale,252*scale,92*scale);font(17);c.fillStyle='#f5e4bd';c.fillText(`${Math.ceil(hp)} / ${maxHp} HP`,30*scale,42*scale);
    c.fillStyle='#4a5947';c.fillRect(30*scale,53*scale,224*scale,5*scale);c.fillStyle='#b4c98b';c.fillRect(30*scale,53*scale,224*scale*Math.max(0,hp/maxHp),5*scale);
    font(12);c.fillStyle='#e2e7d9';c.fillText(lines[0]??'',30*scale,78*scale);c.fillText(lines[1]??'',30*scale,96*scale);
    // Slot numbers match the declared loot slots; key names are never drawn (players can rebind them).
    const equipment=[['1','Sword',state.sword,state.equipped===1],['2','Bow',state.bow,state.equipped===2],['+',`Bandages ${state.bandages}`,state.bandages>0,false]] as const;
    const total=394*scale,left=(w-total)/2;
    equipment.forEach(([key,name,owned,selected],i)=>{const x=left+i*134*scale,y=h-67*scale;panel(x,y,126*scale,48*scale);
      if(selected){c.strokeStyle='#f2d89b';c.lineWidth=3;c.strokeRect(x,y,126*scale,48*scale);}
      font(12);c.fillStyle=owned?'#e4c47b':'#829080';c.fillText(key,x+9*scale,y+18*scale);font(14);c.fillText(name,x+9*scale,y+37*scale);});
    c.fillStyle='#14241edb';c.fillRect(left-24*scale,h-100*scale,total+48*scale,26*scale);
    font(12);c.fillStyle='#e2d1a8';c.textAlign='center';c.fillText(`${state.arrows} arrows · Face ${state.armorFace?'✓':'—'}  Chest ${state.armorChest?'✓':'—'}  Legs ${state.armorLegs?'✓':'—'}  Arms ${state.armorArms?'✓':'—'}`,w/2,h-82*scale);
    if(state.bandageMs>0){c.fillStyle='#14241eeb';c.fillRect(w/2-110*scale,h-137*scale,220*scale,28*scale);
      c.fillStyle='#fff2d0';c.fillText(`Bandaging… ${(Math.max(0,bandageDurationMs-state.bandageMs)/1000).toFixed(1)}s`,w/2,h-118*scale);}
    if(!chest){
      if(hp>0){c.strokeStyle='#fff8dd';c.lineWidth=1.6;c.beginPath();c.moveTo(w/2-6,h/2);c.lineTo(w/2+6,h/2);c.moveTo(w/2,h/2-6);c.lineTo(w/2,h/2+6);c.stroke();}
      font(14);c.fillStyle='#fff2d0';c.fillText(lines[2]??'',w/2,h/2+40*scale);c.textAlign='left';return;
    }
    c.textAlign='left';c.fillStyle='#07110c70';c.fillRect(0,0,w,h);
    const layout=lootPanelLayout(w,h),s=layout.scale,p=layout.panel;
    panel(p.x,p.y,p.width,p.height);c.font=`bold ${22*s}px sans-serif`;c.fillStyle='#f6dfaa';c.fillText('SUPPLY CHEST',p.x+20*s,p.y+37*s);
    c.font=`${12*s}px sans-serif`;c.fillStyle='#bcc8b6';c.fillText('Choose supplies · Numbers 1–8 · F take all · E close',p.x+20*s,p.y+61*s);
    const px=(state.chestCursorX??.5)*w,py=(state.chestCursorY??.5)*h;
    const drawButton=(r:LootRect,label:string,active:boolean)=>{const hover=px>=r.x&&px<=r.x+r.width&&py>=r.y&&py<=r.y+r.height;
      c.fillStyle=active?(hover?'#50654a':'#314639'):'#202d25';c.fillRect(r.x,r.y,r.width,r.height);c.strokeStyle=hover?'#f0d29c':'#607359';c.lineWidth=1;c.strokeRect(r.x,r.y,r.width,r.height);c.fillStyle=active?'#f0dfbb':'#7d8c7c';c.font=`${15*s}px sans-serif`;c.fillText(label,r.x+12*s,r.y+25*s);};
    ARENA_LOOT.forEach((item,index)=>{const r=layout.slots[index],available=!!(chest.loot&item.bit);drawButton(r,`${index+1}  ${item.label}`,available);
      c.font=`${11*s}px sans-serif`;c.fillStyle=available?'#b9c8ac':'#71806f';c.fillText(available?'Click to take':'Empty',r.x+12*s,r.y+45*s);});
    drawButton(layout.all,chest.loot?'F  TAKE ALL':'CHEST EMPTY',!!chest.loot);drawButton(layout.close,'×',true);
    c.beginPath();c.moveTo(px,py);c.lineTo(px+4,py+18);c.lineTo(px+8,py+12);c.lineTo(px+16,py+11);c.closePath();c.fillStyle='#fff6dc';c.fill();c.strokeStyle='#17241d';c.stroke();
  }
  render(renderer:THREE.WebGLRenderer){if(this.dirty){this.texture.needsUpdate=true;this.dirty=false;}const auto=renderer.autoClear;renderer.autoClear=false;renderer.clearDepth();renderer.render(this.scene,this.camera);renderer.autoClear=auto;}
  dispose(){this.geometry.dispose();this.material.dispose();this.texture.dispose();this.scene.clear();}
}
