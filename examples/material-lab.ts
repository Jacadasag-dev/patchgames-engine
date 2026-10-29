import * as THREE from 'three';
import {materialGeneratorSchema,MATERIAL_GENERATOR_PRESETS,type ResolvedMaterialGenerator,type GeneratedMaterialPixels} from '../src/shared/materialGenerator.ts';
import {MATERIAL_LAB_PRESETS} from '../src/shared/materialLabPresets.ts';
import {createGeneratedMaterialFromPixels} from '../src/sandbox/materialGenerator.ts';
import css from './material-lab.css?inline';

const labels:Record<string,string>={tileMeters:'Tile size (metres)',blockMeters:'Block size (metres)',mortarMeters:'Mortar width (metres)',plankMeters:'Plank width (metres)',grainMeters:'Grain size (metres)',gapMeters:'Plank gap (metres)',stoneMeters:'Stone size (metres)',bladeMeters:'Blade size (metres)',sizeVariation:'Size variation',secondaryColor:'Shadow color',reliefMeters:'Relief depth (metres)',paletteSteps:'Palette colors'};
const label=(key:string)=>labels[key]??key.charAt(0).toUpperCase()+key.slice(1);
const choice:Record<string,string[]>={family:['masonry','rock','wood','dirt','gravel','grass','metal','plaster'],shape:['rectangle','square','triangle'],bond:['stack','staggered'],direction:['vertical','horizontal'],style:['realistic','stylized','pixel']};
type Handle=ReturnType<typeof createGeneratedMaterialFromPixels>;
type MapName='color'|'normal'|'height'|'roughness'|'metalness'|'ao';
const mapNames:MapName[]=['color','normal','height','roughness','metalness','ao'];
function node<K extends keyof HTMLElementTagNameMap>(tag:K,text='',className=''){const el=document.createElement(tag);el.textContent=text;el.className=className;return el;}
function select(values:string[],value:string){const el=node('select');for(const item of values){const opt=node('option',label(item));opt.value=item;el.append(opt);}el.value=value;return el;}
function paint(canvas:HTMLCanvasElement,pixels:{width:number;height:number;data:Uint8Array}){canvas.width=pixels.width;canvas.height=pixels.height;const data=new Uint8ClampedArray(pixels.data.length);data.set(pixels.data);canvas.getContext('2d')!.putImageData(new ImageData(data,pixels.width,pixels.height),0,0);}
function download(blob:Blob,name:string){const url=URL.createObjectURL(blob),anchor=node('a');anchor.href=url;anchor.download=name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}

/** Standalone browser demo. Returns cleanup; no account, network assets or provider calls. */
export function mountMaterialLab(parent:HTMLElement,onClose?:()=>void){
  let recipe=structuredClone(MATERIAL_LAB_PRESETS[0].recipe),activeId=MATERIAL_LAB_PRESETS[0].id,disposed=false,sequence=0,debounce=0;
  let baked:GeneratedMaterialPixels|undefined,handle:Handle|undefined,worker:Worker|undefined,mapTab='3d',shape='sphere',repeat=1,raf=0;
  const root=node('section','','ml');root.setAttribute('aria-label','Material generator lab');const style=node('style');style.textContent=css;root.append(style);
  const header=node('header'),brand=node('div');brand.append(node('div','PATCHGAMES ENGINE / MATERIALS','eyebrow'),node('div','Material Lab','brand'));
  header.append(brand,node('p','Make a surface. Shape its character. Keep the recipe.'),node('div','','spacer'),node('span','50 generated materials · no image assets','badge'));
  if(onClose){const close=node('button','Close lab','close');close.onclick=onClose;header.append(close);}root.append(header);
  const body=node('div','','body'),library=node('aside','','library'),workspace=node('main','','workspace'),controls=node('aside','','controls');body.append(library,workspace,controls);root.append(body);
  library.append(node('h2','Material library'));const search=node('input');search.type='search';search.placeholder='Search materials…';search.setAttribute('aria-label','Search materials');
  const filter=select(['all',...choice.family],'all');filter.setAttribute('aria-label','Filter material family');const count=node('p','','library-count'),cards=node('div','','cards');library.append(search,filter,count,cards);
  const entries=structuredClone([...MATERIAL_LAB_PRESETS]);
  try{const saved=JSON.parse(localStorage.getItem('patchgames-material-lab-v1')??'[]');if(Array.isArray(saved))for(const item of saved.slice(0,50)){const parsed=materialGeneratorSchema.safeParse(item.recipe);if(parsed.success&&typeof item.id==='string')entries.push({id:item.id,recipe:parsed.data});}}catch{}
  const titlebar=node('div','','titlebar'),heading=node('div'),title=node('h1'),subtitle=node('div','','sub');heading.append(title,subtitle);const shuffle=node('button','New seed');titlebar.append(heading,shuffle);workspace.append(titlebar);
  const viewport=node('div','','viewport'),canvas=node('canvas'),mapCanvas=node('canvas'),hint=node('span','Drag to orbit · scroll to zoom','hint'),busy=node('span','Generating…','busy');mapCanvas.hidden=true;viewport.append(canvas,mapCanvas,hint,busy);workspace.append(viewport);
  const tabs=node('div','','tabs');tabs.setAttribute('role','group');tabs.setAttribute('aria-label','Preview map');const tabButtons=new Map<string,HTMLButtonElement>();
  for(const id of ['3d',...mapNames]){const button=node('button',id==='3d'?'3D material':id==='ao'?'Occlusion':label(id));button.onclick=()=>{mapTab=id;showMap();};tabs.append(button);tabButtons.set(id,button);}workspace.append(tabs);
  const toolbar=node('div','','toolbar'),shapeChoice=select(['sphere','cube','plane'],shape),light=select(['studio','warm','cool'],'studio'),tiling=select(['1','2','4'],'1');
  shapeChoice.setAttribute('aria-label','Preview geometry');light.setAttribute('aria-label','Lighting');tiling.setAttribute('aria-label','Tile repeats');
  const rotate=node('input');rotate.type='checkbox';rotate.id='ml-rotate';const rotateLabel=node('label','Auto rotate');rotateLabel.prepend(rotate);
  toolbar.append(shapeChoice,light,node('label','Repeats'),tiling,rotateLabel);workspace.append(toolbar);
  const status=node('output','Preparing the material studio…','status');status.setAttribute('aria-live','polite');root.append(status);
  controls.append(node('h2','Make it yours'));const fields=node('div','','fields');controls.append(fields);
  const actions=node('div','','actions'),save=node('button','Save preset','primary'),exportRecipe=node('button','Recipe JSON'),exportMap=node('button','PNG map');actions.append(save,exportRecipe,exportMap);controls.append(actions);
  const details=node('details'),summary=node('summary','Advanced recipe editor'),editor=node('textarea');editor.setAttribute('aria-label','Material recipe JSON');editor.spellcheck=false;const apply=node('button','Apply JSON');details.append(summary,editor,apply);controls.append(details,node('p','Generated from parameters using the engine. Height changes shading, not geometry. Large textures need more memory.','note'));parent.append(root);

  let renderer:THREE.WebGLRenderer;
  try{renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:true});}catch{root.remove();throw Error('Material Lab requires WebGL for its 3D preview.');}
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.2;
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(38,1,0.1,100),group=new THREE.Group();camera.position.set(0,0,5.3);scene.add(group);
  scene.add(new THREE.HemisphereLight(0xdce9d7,0x28342a,2));const key=new THREE.DirectionalLight(0xffedcc,4);key.position.set(-3,4,5);scene.add(key);const rim=new THREE.DirectionalLight(0xa9c7dc,2);rim.position.set(3,1,-3);scene.add(rim);
  const fallback=new THREE.MeshStandardMaterial({color:'#b8b29b',roughness:0.8});
  const meshes={sphere:new THREE.Mesh(new THREE.SphereGeometry(1.35,96,64),fallback),cube:new THREE.Mesh(new THREE.BoxGeometry(2.2,2.2,2.2,1,1,1),fallback),plane:new THREE.Mesh(new THREE.BoxGeometry(2.8,2.8,0.08),fallback)};
  for(const[id,mesh]of Object.entries(meshes)){mesh.visible=id===shape;group.add(mesh);}group.rotation.set(-0.12,0.35,0);
  const render=()=>{if(!disposed&&mapTab==='3d')renderer.render(scene,camera);};
  const resize=new ResizeObserver(()=>{const rect=viewport.getBoundingClientRect();renderer.setSize(Math.max(1,rect.width),Math.max(1,rect.height),false);camera.aspect=rect.width/Math.max(1,rect.height);camera.updateProjectionMatrix();render();});resize.observe(viewport);
  function announce(text:string,error=false){status.textContent=text;status.classList.toggle('error',error);}
  function showMap(){canvas.hidden=mapTab!=='3d';mapCanvas.hidden=mapTab==='3d';hint.textContent=mapTab==='3d'?'Drag to orbit · scroll to zoom':'Texture map · export with PNG map';for(const[id,button]of tabButtons)button.setAttribute('aria-pressed',String(id===mapTab));if(baked&&mapTab!=='3d'){paint(mapCanvas,baked[mapTab as MapName]);mapCanvas.style.objectFit='contain';mapCanvas.style.imageRendering=recipe.output.style==='pixel'?'pixelated':'auto';}render();}
  function showRecipe(){title.textContent=recipe.name;subtitle.textContent=`${label(recipe.pattern.family)} / seed ${recipe.seed} / ${recipe.output.style}`;editor.value=JSON.stringify(recipe,null,2);}
  function schedule(){showRecipe();clearTimeout(debounce);worker?.terminate();worker=undefined;sequence++;exportMap.disabled=true;busy.hidden=false;busy.textContent='Waiting for preview…';debounce=window.setTimeout(generate,180);}
  function generate(){
    if(disposed)return;const id=sequence,started=performance.now();
    const parsed=materialGeneratorSchema.safeParse(recipe);if(!parsed.success){busy.hidden=true;announce(parsed.error.issues.map(i=>i.path.join('.')+': '+i.message).join(' · '),true);return;}
    recipe=parsed.data;busy.textContent=`Generating ${recipe.output.resolution} × ${recipe.output.resolution}…`;
    worker=new Worker(new URL('./material-lab-worker.ts',import.meta.url),{type:'module'});
    worker.onerror=()=>{busy.hidden=true;announce('The preview worker failed. Try a lower resolution.',true);};
    worker.onmessage=event=>{
      if(disposed||event.data.id!==sequence||id!==sequence)return;busy.hidden=true;
      if(event.data.error){announce(event.data.error,true);worker?.terminate();worker=undefined;return;}
      baked=event.data.baked;exportMap.disabled=false;const next=createGeneratedMaterialFromPixels(baked!);for(const mesh of Object.values(meshes))mesh.material=next.material;handle?.dispose();handle=next;setRepeats();showMap();
      announce(`${baked!.color.width} × ${baked!.color.height} · 6 PBR maps · ${(baked!.diagnostics.bytes/1048576).toFixed(1)} MiB · ${Math.round(performance.now()-started)} ms bake`);
      worker?.terminate();worker=undefined;
    };worker.postMessage({id,recipe});
  }
  function setRepeats(){if(handle)for(const map of Object.values(handle.maps))map.repeat.set(repeat,repeat);render();}
  function field(key:string,value:unknown,change:(v:unknown)=>void){
    const wrap=node('label','','field');wrap.append(node('span',label(key)));
    if(choice[key]){const control=select(choice[key],String(value));control.onchange=()=>change(control.value);wrap.append(control);}
    else if(Array.isArray(value)){const pair=node('div','','pair'),values=[...value];value.forEach((part,i)=>{const input=node('input');input.type='number';input.min='0.002';input.max='100';input.step='0.01';input.value=String(part);input.setAttribute('aria-label',`${label(key)} ${i===0?'width':'height'}`);input.onchange=()=>{values[i]=input.valueAsNumber;change([...values]);};pair.append(input);});wrap.append(pair);}
    else if(typeof value==='string'){const input=node('input');input.type=key.toLowerCase().includes('color')?'color':'text';input.value=value;input.onchange=()=>change(input.value);wrap.append(input);}
    else if(typeof value==='number'){
      const meter=key.endsWith('Meters'),seed=key==='seed',palette=key==='paletteSteps';
      const min=seed?-2147483648:palette?2:meter&& !['gapMeters','mortarMeters','reliefMeters'].includes(key)?0.002:0;
      const max=seed?2147483647:palette?32:meter?key==='reliefMeters'?0.2:key==='gapMeters'?0.05:key==='mortarMeters'?0.1:2:1;
      const step=seed||palette?1:meter?0.001:0.01,row=node('div','','range-row'),input=node('input');input.type='number';input.min=String(min);input.max=String(max);input.step=String(step);input.value=String(value);input.setAttribute('aria-label',label(key));
      if(!seed){const slider=node('input');slider.type='range';slider.min=String(min);slider.max=String(max);slider.step=String(step);slider.value=String(value);slider.setAttribute('aria-label',label(key)+' slider');slider.oninput=()=>{input.value=slider.value;change(slider.valueAsNumber);};input.onchange=()=>{slider.value=input.value;change(input.valueAsNumber);};row.append(slider);}else input.onchange=()=>change(input.valueAsNumber);
      row.append(input);wrap.append(row);
    }fields.append(wrap);
  }
  function buildFields(){
    fields.replaceChildren();field('name',recipe.name,value=>{recipe.name=String(value);showRecipe();});
    field('family',recipe.pattern.family,value=>{const preset=MATERIAL_GENERATOR_PRESETS.find(p=>p.recipe.pattern.family===value)!;recipe=materialGeneratorSchema.parse({...recipe,pattern:preset.recipe.pattern});buildFields();schedule();});
    const set=(key:string)=>(value:unknown)=>{recipe={...recipe,[key]:value};schedule();};
    fields.append(node('h3','Palette & surface'));for(const key of ['color','secondaryColor','roughness','variation','weathering','reliefMeters','tileMeters','seed']as const)field(key,recipe[key],set(key));
    fields.append(node('h3',label(recipe.pattern.family)+' controls'));for(const[key,value]of Object.entries(recipe.pattern))if(key!=='family')field(key,value,next=>{recipe={...recipe,pattern:{...recipe.pattern,[key]:next}as ResolvedMaterialGenerator['pattern']};schedule();});
    fields.append(node('h3','Output quality'));const res=node('label','','field');res.append(node('span','Resolution'));const sizes=select(['32','64','128','256','512','1024','2048'],String(recipe.output.resolution));sizes.onchange=()=>{recipe.output.resolution=Number(sizes.value)as ResolvedMaterialGenerator['output']['resolution'];schedule();};res.append(sizes);fields.append(res);
    field('style',recipe.output.style,value=>{recipe.output.style=value as ResolvedMaterialGenerator['output']['style'];schedule();});field('paletteSteps',recipe.output.paletteSteps,value=>{recipe.output.paletteSteps=Number(value);schedule();});
  }
  const thumbWorker=new Worker(new URL('./material-lab-worker.ts',import.meta.url),{type:'module'}),thumbQueue:{id:string;recipe:ResolvedMaterialGenerator}[]=[],thumbs=new Map<string,HTMLCanvasElement>();let thumbBusy=false;
  function nextThumb(){if(disposed||thumbBusy||!thumbQueue.length)return;thumbBusy=true;const item=thumbQueue.shift()!;thumbWorker.postMessage({...item,resolution:96,thumbnail:true});}
  thumbWorker.onmessage=event=>{const target=thumbs.get(event.data.id);if(target&&event.data.color)paint(target,event.data.color);thumbBusy=false;nextThumb();};thumbWorker.onerror=()=>{thumbBusy=false;announce('Some library thumbnails could not load. Select a material to preview it.',true);};
  function buildCards(){cards.replaceChildren();const query=search.value.toLowerCase(),shown=entries.filter(item=>(filter.value==='all'||filter.value===item.recipe.pattern.family)&&(item.recipe.name+' '+item.recipe.pattern.family).toLowerCase().includes(query));count.textContent=`${shown.length} materials · 50 engine examples`;
    for(const item of shown){const button=node('button','','card');button.setAttribute('aria-pressed',String(item.id===activeId));button.setAttribute('aria-label',item.recipe.name);let thumb=thumbs.get(item.id);if(!thumb){thumb=node('canvas');thumbs.set(item.id,thumb);thumbQueue.push(item);}button.append(thumb,node('span',item.recipe.name));button.onclick=()=>{activeId=item.id;recipe=structuredClone(item.recipe);buildCards();buildFields();schedule();};cards.append(button);}if(!shown.length)cards.append(node('p','No matching materials.','empty'));nextThumb();
  }
  search.oninput=buildCards;filter.onchange=buildCards;shuffle.onclick=()=>{recipe.seed=Math.floor(Math.random()*2147483647);buildFields();schedule();};
  shapeChoice.onchange=()=>{shape=shapeChoice.value;for(const[id,mesh]of Object.entries(meshes))mesh.visible=id===shape;render();};
  light.onchange=()=>{key.color.set(light.value==='warm'?0xffc57c:light.value==='cool'?0xa4caff:0xffedcc);render();};tiling.onchange=()=>{repeat=Number(tiling.value);setRepeats();};
  function animate(){if(disposed||!rotate.checked)return;group.rotation.y+=0.004;render();raf=requestAnimationFrame(animate);}rotate.onchange=()=>{cancelAnimationFrame(raf);if(rotate.checked)animate();};
  let drag:{x:number;y:number}|undefined;canvas.onpointerdown=event=>{canvas.setPointerCapture(event.pointerId);drag={x:event.clientX,y:event.clientY};};canvas.onpointermove=event=>{if(!drag)return;group.rotation.y+=(event.clientX-drag.x)*0.008;group.rotation.x=Math.max(-1.3,Math.min(1.3,group.rotation.x+(event.clientY-drag.y)*0.008));drag={x:event.clientX,y:event.clientY};render();};canvas.onpointerup=canvas.onpointercancel=()=>{drag=undefined;};canvas.onwheel=event=>{event.preventDefault();camera.position.z=Math.max(3.2,Math.min(10,camera.position.z+event.deltaY*0.003));render();};
  exportRecipe.onclick=()=>download(new Blob([JSON.stringify(recipe,null,2)],{type:'application/json'}),recipe.name+'.json');
  exportMap.onclick=()=>{if(!baked)return;const temp=node('canvas'),id=mapTab==='3d'?'color':mapTab as MapName;paint(temp,baked[id]);temp.toBlob(blob=>{if(blob)download(blob,recipe.name+'-'+id+'.png');});};
  save.onclick=()=>{try{const parsed=materialGeneratorSchema.parse(recipe),item={id:'saved-'+Date.now(),recipe:parsed};entries.push(item);const saved=entries.filter(item=>item.id.startsWith('saved-')).slice(-50);localStorage.setItem('patchgames-material-lab-v1',JSON.stringify(saved));activeId=item.id;search.value='';filter.value='all';buildCards();announce('Saved in this browser. Export JSON to keep a portable copy.');}catch(error){announce(String(error),true);}};
  apply.onclick=()=>{try{recipe=materialGeneratorSchema.parse(JSON.parse(editor.value));buildFields();schedule();}catch(error){announce(String(error),true);}};
  buildCards();buildFields();showMap();schedule();
  return()=>{disposed=true;clearTimeout(debounce);cancelAnimationFrame(raf);worker?.terminate();thumbWorker.terminate();resize.disconnect();handle?.dispose();fallback.dispose();for(const mesh of Object.values(meshes))mesh.geometry.dispose();renderer.dispose();renderer.forceContextLoss();root.remove();};
}
