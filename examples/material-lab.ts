import {objectSurfaceSchema,OBJECT_SURFACE_EXAMPLES,BOX_SURFACES,type ResolvedObjectSurface,type BoxSurface,type ObjectSurfaceBake} from '../src/shared/objectSurface.ts';
import {ObjectSurfaceView} from '../src/sandbox/objectSurface.ts';
import * as THREE from 'three';
import {materialGeneratorSchema,MATERIAL_GENERATOR_PRESETS,type ResolvedMaterialGenerator,type GeneratedMaterialPixels} from '../src/shared/materialGenerator.ts';
import {MATERIAL_LAB_PRESETS} from '../src/shared/materialLabPresets.ts';
import {createGeneratedMaterialFromPixels} from '../src/sandbox/materialGenerator.ts';
import css from './material-lab.css?inline';

const labels:Record<string,string>={baseColor:'Base color',shadowColor:'Shadow color',grassColor:'Grass color',fringeDepthMeters:'Grass fringe depth (metres)',fringeVariation:'Fringe variation',edgeSoftnessMeters:'Edge softness (metres)',grassDensity:'Grass density',showSlash:'Show slash',slashWidthMeters:'Slash width (metres)',slashDepthMeters:'Slash depth (metres)',exposedColor:'Exposed inner color',tileMeters:'Tile size (metres)',blockMeters:'Block size (metres)',mortarMeters:'Mortar width (metres)',plankMeters:'Plank width (metres)',grainMeters:'Grain size (metres)',gapMeters:'Plank gap (metres)',stoneMeters:'Stone size (metres)',bladeMeters:'Blade size (metres)',sizeVariation:'Size variation',secondaryColor:'Shadow color',reliefMeters:'Relief depth (metres)',paletteSteps:'Palette colors'};
const label=(key:string)=>labels[key]??key.charAt(0).toUpperCase()+key.slice(1);
const choice:Record<string,string[]>={family:['masonry','rock','wood','dirt','gravel','grass','metal','plaster'],shape:['rectangle','square','triangle'],bond:['stack','staggered'],direction:['vertical','horizontal'],style:['realistic','stylized','pixel']};
type Example='material'|'grass'|'slash';
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
  let mode:Example='material',surfaceRecipe=objectSurfaceSchema.parse(OBJECT_SURFACE_EXAMPLES.grass),surfaceBake:ObjectSurfaceBake|undefined,surfaceView:ObjectSurfaceView|undefined,inspectFace:BoxSurface='front';
  const surfaceDrafts={grass:surfaceRecipe,slash:objectSurfaceSchema.parse(OBJECT_SURFACE_EXAMPLES.slash)};
  for(const id of ['grass','slash'] as const)try{const saved=localStorage.getItem('patchgames-object-surface-'+id);if(saved)surfaceDrafts[id]=objectSurfaceSchema.parse(JSON.parse(saved));}catch{}
  const root=node('section','','ml');root.setAttribute('aria-label','Material generator lab');const style=node('style');style.textContent=css;root.append(style);
  const header=node('header'),brand=node('div');brand.append(node('div','PATCHGAMES ENGINE / MATERIALS','eyebrow'),node('div','Material Lab','brand'));
  header.append(brand,node('p','Make a surface. Shape its character. Keep the recipe.'),node('div','','spacer'),node('span','50 materials + 2 surface examples','badge'));
  if(onClose){const close=node('button','Close lab','close');close.onclick=onClose;header.append(close);}root.append(header);
  const body=node('div','','body'),library=node('aside','','library'),workspace=node('main','','workspace'),controls=node('aside','','controls');body.append(library,workspace,controls);root.append(body);
  const examples=node('div','','surface-examples');
  for(const[id,text]of [['grass','Grass-topped dirt block'],['slash','Brick wall + editable slash'],['material','Material swatches']]){const button=node('button',text);button.onclick=()=>setExample(id as Example);examples.append(button);}library.append(node('h2','Object surface recipes'),examples,node('h2','Material library'));const search=node('input');search.type='search';search.placeholder='Search materials…';search.setAttribute('aria-label','Search materials');
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
  const faceChoice=select([...BOX_SURFACES],inspectFace);faceChoice.setAttribute('aria-label','Inspect geometric face');faceChoice.hidden=true;faceChoice.onchange=()=>{inspectFace=faceChoice.value as BoxSurface;if(surfaceBake)baked=surfaceBake.faces[inspectFace];showMap();};
  toolbar.append(faceChoice,shapeChoice,light,node('label','Repeats'),tiling,rotateLabel);workspace.append(toolbar);
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
  function showMap(){canvas.hidden=mapTab!=='3d';mapCanvas.hidden=mapTab==='3d';hint.textContent=mapTab==='3d'?'Drag to orbit · scroll to zoom':'Texture map · export with PNG map';for(const[id,button]of tabButtons)button.setAttribute('aria-pressed',String(id===mapTab));if(baked&&mapTab!=='3d'){paint(mapCanvas,baked[mapTab as MapName]);mapCanvas.style.objectFit='contain';mapCanvas.style.imageRendering=(mode==='material'?recipe.output.style:surfaceRecipe.output.style)==='pixel'?'pixelated':'auto';}render();}
  function showRecipe(){if(mode!=='material'){title.textContent=surfaceRecipe.name;subtitle.textContent=mode==='grass'?'Model +Y top / continuous side fringe / '+surfaceRecipe.output.style:'Model front / one non-repeating slash / '+surfaceRecipe.output.style;editor.value=JSON.stringify(surfaceRecipe,null,2);return;}title.textContent=recipe.name;subtitle.textContent=`${label(recipe.pattern.family)} / seed ${recipe.seed} / ${recipe.output.style}`;editor.value=JSON.stringify(recipe,null,2);}
  function schedule(){showRecipe();clearTimeout(debounce);worker?.terminate();worker=undefined;sequence++;exportMap.disabled=true;busy.hidden=false;busy.textContent='Waiting for preview…';debounce=window.setTimeout(generate,180);}
  function generate(){
    if(disposed)return;const id=sequence,started=performance.now();
    if(mode==='material'){const parsed=materialGeneratorSchema.safeParse(recipe);if(!parsed.success){busy.hidden=true;announce(parsed.error.issues.map(i=>i.path.join('.')+': '+i.message).join(' · '),true);return;}recipe=parsed.data;}
    else{const parsed=objectSurfaceSchema.safeParse(surfaceRecipe);if(!parsed.success){busy.hidden=true;announce(parsed.error.issues.map(i=>i.path.join('.')+': '+i.message).join(' · '),true);return;}surfaceRecipe=parsed.data;surfaceDrafts[mode]=surfaceRecipe;}
    busy.textContent=mode==='material'?'Generating material…':'Generating six object surfaces…';
    worker=new Worker(new URL('./material-lab-worker.ts',import.meta.url),{type:'module'});
    worker.onerror=()=>{busy.hidden=true;announce('The preview worker failed. Try a lower resolution.',true);};
    worker.onmessage=event=>{
      if(disposed||event.data.id!==sequence||id!==sequence)return;busy.hidden=true;
      if(event.data.error){announce(event.data.error,true);worker?.terminate();worker=undefined;return;}
      exportMap.disabled=false;
      if(event.data.surface){surfaceBake=event.data.surface;if(surfaceView)surfaceView.update(surfaceBake!);else{surfaceView=new ObjectSurfaceView(surfaceBake!);group.add(surfaceView.root);}surfaceView.root.scale.setScalar((mode==='grass'?2.2:3.5)/Math.max(...surfaceRecipe.sizeMeters));surfaceView.root.visible=true;for(const mesh of Object.values(meshes))mesh.visible=false;baked=surfaceBake!.faces[inspectFace];}
      else{baked=event.data.baked;const next=createGeneratedMaterialFromPixels(baked!);for(const mesh of Object.values(meshes))mesh.material=next.material;handle?.dispose();handle=next;}
      setRepeats();showMap();
      const bytes=mode==='material'?baked!.diagnostics.bytes:surfaceBake!.diagnostics.bytes;
      announce(baked!.color.width+' × '+baked!.color.height+' · '+(mode==='material'?'6 maps':'6 faces / 36 maps')+' · '+(bytes/1048576).toFixed(1)+' MiB · '+Math.round(performance.now()-started)+' ms bake'+(mode==='slash'?' · Shading relief; collision unchanged':''));
      worker?.terminate();worker=undefined;
    };worker.postMessage(mode==='material'?{id,recipe}:{id,surfaceRecipe});
  }
  function setRepeats(){if(mode==='material'&&handle)for(const map of Object.values(handle.maps))map.repeat.set(repeat,repeat);render();}
  function field(key:string,value:unknown,change:(v:unknown)=>void,range?:[number,number,number]){
    const wrap=node('label','','field');wrap.append(node('span',label(key)));
    if(typeof value==='boolean'){const input=node('input');input.type='checkbox';input.checked=value;input.onchange=()=>change(input.checked);wrap.append(input);}
    else if(choice[key]){const control=select(choice[key],String(value));control.onchange=()=>change(control.value);wrap.append(control);}
    else if(Array.isArray(value)){const pair=node('div','','pair'),values=[...value];value.forEach((part,i)=>{const input=node('input');input.type='number';input.min='0.002';input.max='100';input.step='0.01';input.value=String(part);input.setAttribute('aria-label',`${label(key)} ${i===0?'width':'height'}`);input.onchange=()=>{values[i]=input.valueAsNumber;change([...values]);};pair.append(input);});wrap.append(pair);}
    else if(typeof value==='string'){const input=node('input');input.type=key.toLowerCase().includes('color')?'color':'text';input.value=value;input.onchange=()=>change(input.value);wrap.append(input);}
    else if(typeof value==='number'){
      const meter=key.endsWith('Meters'),seed=key==='seed',palette=key==='paletteSteps';
      const min=range?range[0]:seed?-2147483648:palette?2:meter&& !['gapMeters','mortarMeters','reliefMeters'].includes(key)?0.002:0;
      const max=range?range[1]:seed?2147483647:palette?32:meter?key==='reliefMeters'?0.2:key==='gapMeters'?0.05:key==='mortarMeters'?0.1:2:1;
      const step=range?range[2]:seed||palette?1:meter?0.001:0.01,row=node('div','','range-row'),input=node('input');input.type='number';input.min=String(min);input.max=String(max);input.step=String(step);input.value=String(value);input.setAttribute('aria-label',label(key));
      if(!seed){const slider=node('input');slider.type='range';slider.min=String(min);slider.max=String(max);slider.step=String(step);slider.value=String(value);slider.setAttribute('aria-label',label(key)+' slider');slider.oninput=()=>{input.value=slider.value;change(slider.valueAsNumber);};input.onchange=()=>{slider.value=input.value;change(input.valueAsNumber);};row.append(slider);}else input.onchange=()=>change(input.valueAsNumber);
      row.append(input);wrap.append(row);
    }fields.append(wrap);
  }
  function buildFields(){
    fields.replaceChildren();if(mode!=='material'){buildSurfaceFields();return;}field('name',recipe.name,value=>{recipe.name=String(value);showRecipe();});
    field('family',recipe.pattern.family,value=>{const preset=MATERIAL_GENERATOR_PRESETS.find(p=>p.recipe.pattern.family===value)!;recipe=materialGeneratorSchema.parse({...recipe,pattern:preset.recipe.pattern});buildFields();schedule();});
    const set=(key:string)=>(value:unknown)=>{recipe={...recipe,[key]:value};schedule();};
    fields.append(node('h3','Palette & surface'));for(const key of ['color','secondaryColor','roughness','variation','weathering','reliefMeters','tileMeters','seed']as const)field(key,recipe[key],set(key));
    fields.append(node('h3',label(recipe.pattern.family)+' controls'));for(const[key,value]of Object.entries(recipe.pattern))if(key!=='family')field(key,value,next=>{recipe={...recipe,pattern:{...recipe.pattern,[key]:next}as ResolvedMaterialGenerator['pattern']};schedule();});
    fields.append(node('h3','Output quality'));const res=node('label','','field');res.append(node('span','Resolution'));const sizes=select(['32','64','128','256','512','1024','2048'],String(recipe.output.resolution));sizes.onchange=()=>{recipe.output.resolution=Number(sizes.value)as ResolvedMaterialGenerator['output']['resolution'];schedule();};res.append(sizes);fields.append(res);
    field('style',recipe.output.style,value=>{recipe.output.style=value as ResolvedMaterialGenerator['output']['style'];schedule();});field('paletteSteps',recipe.output.paletteSteps,value=>{recipe.output.paletteSteps=Number(value);schedule();});
  }
  function syncMode(){
    shapeChoice.disabled=tiling.disabled=mode!=='material';faceChoice.hidden=mode==='material';
    for(const[id,mesh]of Object.entries(meshes))mesh.visible=mode==='material'&&id===shape;
    if(surfaceView)surfaceView.root.visible=mode!=='material';
    for(const [index,id]of ['grass','slash','material'].entries())examples.children[index].setAttribute('aria-pressed',String(mode===id));
  }
  function setExample(next:Example){
    if(mode!=='material')surfaceDrafts[mode]=surfaceRecipe;
    mode=next;activeId=mode==='material'?activeId:'';
    if(mode!=='material'){
      surfaceRecipe=surfaceDrafts[mode];
      group.rotation.set(mode==='grass'?0.35:0.12,mode==='grass'?-0.5:-0.12,0);camera.position.z=5.8;
      inspectFace=mode==='grass'?'right':'front';faceChoice.value=inspectFace;
    }
    syncMode();buildCards();buildFields();schedule();
  }
  function buildSurfaceFields(){
    field('name',surfaceRecipe.name,value=>{surfaceRecipe.name=String(value);showRecipe();});
    fields.append(node('h3','Base surface'));
    field('baseColor',surfaceRecipe.base.color,value=>{surfaceRecipe.base.color=String(value);schedule();});
    field('shadowColor',surfaceRecipe.base.secondaryColor,value=>{surfaceRecipe.base.secondaryColor=String(value);schedule();});
    field('roughness',surfaceRecipe.base.roughness,value=>{surfaceRecipe.base.roughness=Number(value);schedule();});
    field('tileMeters',surfaceRecipe.base.tileMeters,value=>{surfaceRecipe.base.tileMeters=value as [number,number];schedule();});
    field('seed',surfaceRecipe.seed,value=>{surfaceRecipe.seed=Number(value);surfaceRecipe.base.seed=Number(value);surfaceRecipe.layers.forEach(layer=>layer.material.seed=Number(value));schedule();});
    if(mode==='grass'){
      fields.append(node('h3','Grass coverage / model +Y'));
      if(surfaceRecipe.layers[0]?.coverage.kind==='top-fringe'){
      const fringe=()=>surfaceRecipe.layers[0].coverage as Extract<ResolvedObjectSurface['layers'][number]['coverage'],{kind:'top-fringe'}>;
      field('grassColor',surfaceRecipe.layers[0].material.color,value=>{surfaceRecipe.layers[0].material.color=String(value);schedule();});
      field('fringeDepthMeters',fringe().depthMeters,value=>{fringe().depthMeters=Number(value);schedule();},[0,surfaceRecipe.sizeMeters[1],0.01]);
      field('fringeVariation',fringe().variation,value=>{fringe().variation=Number(value);schedule();});
      field('edgeSoftnessMeters',fringe().featherMeters,value=>{fringe().featherMeters=Number(value);schedule();},[0,0.1,0.001]);
      field('grassDensity',(surfaceRecipe.layers[0].material.pattern as {density:number}).density,value=>{(surfaceRecipe.layers[0].material.pattern as {density:number}).density=Number(value);schedule();});
      }
      const toggle=node('button',surfaceRecipe.layers.length?'Remove grass layer':'Add grass layer');
      toggle.onclick=()=>{surfaceRecipe.layers=surfaceRecipe.layers.length?[]:objectSurfaceSchema.parse(OBJECT_SURFACE_EXAMPLES.grass).layers;buildFields();schedule();};fields.append(toggle);
      fields.append(node('p','Grass follows model +Y. All sides share one fringe field so corners connect. Rotate the preview to check.','note'));
    }else{
      fields.append(node('h3','Localized slash / model front'));
      const effect=()=>surfaceRecipe.effects[0];
      if(effect()){
        field('showSlash',effect().enabled,value=>{effect().enabled=Boolean(value);schedule();});
        field('slashWidthMeters',effect().widthMeters,value=>{effect().widthMeters=Number(value);schedule();},[0.005,0.2,0.005]);
        field('slashDepthMeters',effect().depthMeters,value=>{effect().depthMeters=Number(value);schedule();},[0,0.08,0.001]);
        field('branching',effect().branching,value=>{effect().branching=Number(value);schedule();});
        field('chipping',effect().chipping,value=>{effect().chipping=Number(value);schedule();});
        field('exposedColor',effect().exposedColor,value=>{effect().exposedColor=String(value);schedule();});
        fields.append(node('h3','Path / metres from lower left'));
        effect().pathMeters.forEach((point,index)=>{for(const axis of [0,1] as const)field(`Point ${index+1} ${axis===0?'X':'Y'} (metres)`,point[axis],value=>{effect().pathMeters[index][axis]=Number(value);schedule();},[0,surfaceRecipe.sizeMeters[axis],0.01]);});
      }
      const toggle=node('button',surfaceRecipe.effects.length?'Remove slash':'Add slash');toggle.onclick=()=>{surfaceRecipe.effects=surfaceRecipe.effects.length?[]:objectSurfaceSchema.parse(OBJECT_SURFACE_EXAMPLES.slash).effects;buildFields();schedule();};fields.append(toggle);
      fields.append(node('p','Slash coverage is bounded to the front and independent of brick repeats. Surface relief does not cut a hole.','note'));
    }
    fields.append(node('h3','Output quality'));
    const resolution=node('label','','field');resolution.append(node('span','Resolution per face'));const sizes=select(['32','64','128','256','512'],String(surfaceRecipe.output.resolution));sizes.setAttribute('aria-label','Resolution per face');sizes.onchange=()=>{surfaceRecipe.output.resolution=Number(sizes.value) as ResolvedObjectSurface['output']['resolution'];schedule();};resolution.append(sizes);fields.append(resolution);
    field('style',surfaceRecipe.output.style,value=>{surfaceRecipe.output.style=value as ResolvedObjectSurface['output']['style'];schedule();});
    field('paletteSteps',surfaceRecipe.output.paletteSteps,value=>{surfaceRecipe.output.paletteSteps=Number(value);schedule();});
  }
  const thumbWorker=new Worker(new URL('./material-lab-worker.ts',import.meta.url),{type:'module'}),thumbQueue:{id:string;recipe:ResolvedMaterialGenerator}[]=[],thumbs=new Map<string,HTMLCanvasElement>();let thumbBusy=false;
  function nextThumb(){if(disposed||thumbBusy||!thumbQueue.length)return;thumbBusy=true;const item=thumbQueue.shift()!;thumbWorker.postMessage({...item,resolution:96,thumbnail:true});}
  thumbWorker.onmessage=event=>{const target=thumbs.get(event.data.id);if(target&&event.data.color)paint(target,event.data.color);thumbBusy=false;nextThumb();};thumbWorker.onerror=()=>{thumbBusy=false;announce('Some library thumbnails could not load. Select a material to preview it.',true);};
  function buildCards(){cards.replaceChildren();const query=search.value.toLowerCase(),shown=entries.filter(item=>(filter.value==='all'||filter.value===item.recipe.pattern.family)&&(item.recipe.name+' '+item.recipe.pattern.family).toLowerCase().includes(query));count.textContent=`${shown.length} materials · 50 engine examples`;
    for(const item of shown){const button=node('button','','card');button.setAttribute('aria-pressed',String(item.id===activeId));button.setAttribute('aria-label',item.recipe.name);let thumb=thumbs.get(item.id);if(!thumb){thumb=node('canvas');thumbs.set(item.id,thumb);thumbQueue.push(item);}button.append(thumb,node('span',item.recipe.name));button.onclick=()=>{mode='material';syncMode();activeId=item.id;recipe=structuredClone(item.recipe);buildCards();buildFields();schedule();};cards.append(button);}if(!shown.length)cards.append(node('p','No matching materials.','empty'));nextThumb();
  }
  search.oninput=buildCards;filter.onchange=buildCards;shuffle.onclick=()=>{const seed=Math.floor(Math.random()*2147483647);if(mode==='material')recipe.seed=seed;else{surfaceRecipe.seed=seed;surfaceRecipe.base.seed=seed;surfaceRecipe.layers.forEach(layer=>layer.material.seed=seed);}buildFields();schedule();};
  shapeChoice.onchange=()=>{shape=shapeChoice.value;for(const[id,mesh]of Object.entries(meshes))mesh.visible=id===shape;render();};
  light.onchange=()=>{key.color.set(light.value==='warm'?0xffc57c:light.value==='cool'?0xa4caff:0xffedcc);render();};tiling.onchange=()=>{repeat=Number(tiling.value);setRepeats();};
  function animate(){if(disposed||!rotate.checked)return;group.rotation.y+=0.004;render();raf=requestAnimationFrame(animate);}rotate.onchange=()=>{cancelAnimationFrame(raf);if(rotate.checked)animate();};
  let drag:{x:number;y:number}|undefined;canvas.onpointerdown=event=>{canvas.setPointerCapture(event.pointerId);drag={x:event.clientX,y:event.clientY};};canvas.onpointermove=event=>{if(!drag)return;group.rotation.y+=(event.clientX-drag.x)*0.008;group.rotation.x=Math.max(-1.3,Math.min(1.3,group.rotation.x+(event.clientY-drag.y)*0.008));drag={x:event.clientX,y:event.clientY};render();};canvas.onpointerup=canvas.onpointercancel=()=>{drag=undefined;};canvas.onwheel=event=>{event.preventDefault();camera.position.z=Math.max(3.2,Math.min(10,camera.position.z+event.deltaY*0.003));render();};
  exportRecipe.onclick=()=>{const data=mode==='material'?recipe:surfaceRecipe;download(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),data.name+'.json');};
  exportMap.onclick=()=>{if(!baked)return;const temp=node('canvas'),id=mapTab==='3d'?'color':mapTab as MapName;paint(temp,baked[id]);temp.toBlob(blob=>{if(blob)download(blob,(mode==='material'?recipe.name:surfaceRecipe.name+'-'+inspectFace)+'-'+id+'.png');});};
  save.onclick=()=>{if(mode!=='material'){try{localStorage.setItem('patchgames-object-surface-'+mode,JSON.stringify(objectSurfaceSchema.parse(surfaceRecipe)));announce('Surface recipe saved in this browser. Export JSON for a portable copy.');}catch(error){announce(String(error),true);}return;}try{const parsed=materialGeneratorSchema.parse(recipe),item={id:'saved-'+Date.now(),recipe:parsed};entries.push(item);const saved=entries.filter(item=>item.id.startsWith('saved-')).slice(-50);localStorage.setItem('patchgames-material-lab-v1',JSON.stringify(saved));activeId=item.id;search.value='';filter.value='all';buildCards();announce('Saved in this browser. Export JSON to keep a portable copy.');}catch(error){announce(String(error),true);}};
  apply.onclick=()=>{try{if(mode==='material')recipe=materialGeneratorSchema.parse(JSON.parse(editor.value));else{surfaceRecipe=objectSurfaceSchema.parse(JSON.parse(editor.value));surfaceDrafts[mode]=surfaceRecipe;}buildFields();schedule();}catch(error){announce(String(error),true);}};
  buildCards();buildFields();showMap();schedule();
  return()=>{disposed=true;clearTimeout(debounce);cancelAnimationFrame(raf);worker?.terminate();thumbWorker.terminate();resize.disconnect();surfaceView?.dispose();handle?.dispose();fallback.dispose();for(const mesh of Object.values(meshes))mesh.geometry.dispose();renderer.dispose();renderer.forceContextLoss();root.remove();};
}
