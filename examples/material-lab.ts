import {objectSurfaceSchema,OBJECT_SURFACE_EXAMPLES,BOX_SURFACES,boxSurfaceFrame,type ResolvedObjectSurface,type BoxSurface,type ObjectSurfaceBake} from '../src/shared/objectSurface.ts';
import {ObjectSurfaceView} from '../src/sandbox/objectSurface.ts';
import * as THREE from 'three';
import {materialGeneratorSchema,MATERIAL_GENERATOR_PRESETS,type ResolvedMaterialGenerator,type GeneratedMaterialPixels} from '../src/shared/materialGenerator.ts';
import {MATERIAL_LAB_PRESETS} from '../src/shared/materialLabPresets.ts';
import {createGeneratedMaterialFromPixels} from '../src/sandbox/materialGenerator.ts';
import {mapBoxMaterialMeters,inspectTextureDensity,createMaterialMappingDebug} from '../src/sandbox/materialMapping.ts';
import {MATERIAL_PATTERN_TYPES,parseMaterialPattern,inspectMaterialPatternDistribution} from '../src/shared/materialPatterns.ts';
import css from './material-lab.css?inline';

const labels:Record<string,string>={density:'Feature density (centres/m² or m³)',coverage:'Feature fill / width',generationMode:'Generation mode',baseColor:'Base color',shapeVariation:'Shape variation',clumping:'Clumping',placementRegularity:'Placement regularity',groupSizeMeters:'Group size (metres)',sizeVariation:'Size variation',concentrationSpace:'Concentration space',concentrationAxes:'Concentration axes',type:'Pattern type',sizeMeters:'Pattern size (metres)',heightOffsetMeters:'Layer recess / raise (metres)',angleRadians:'Pattern angle (radians)',lengthMeters:'Length (metres)',widthMeters:'Width (metres)',veinSpacingMeters:'Vein spacing (metres)',ridgeMeters:'Bark ridge spacing (metres)',ringMeters:'Growth-ring spacing (metres)',edgeSerration:'Edge serration',shadowColor:'Shadow color',grassColor:'Grass color',fringeDepthMeters:'Grass fringe depth (metres)',fringeVariation:'Fringe variation',edgeSoftnessMeters:'Edge softness (metres)',grassDensity:'Grass density',showSlash:'Show slash',slashWidthMeters:'Slash width (metres)',slashDepthMeters:'Slash depth (metres)',exposedColor:'Exposed inner color',tileMeters:'Tile size (metres)',blockMeters:'Block size (metres)',mortarMeters:'Mortar width (metres)',plankMeters:'Plank width (metres)',grainMeters:'Grain size (metres)',gapMeters:'Plank gap (metres)',stoneMeters:'Stone size (metres)',bladeMeters:'Blade size (metres)',secondaryColor:'Shadow color',reliefMeters:'Relief depth (metres)',paletteSteps:'Palette colors'};
const label=(key:string)=>labels[key]??key.charAt(0).toUpperCase()+key.slice(1);
const choice:Record<string,string[]>={generationMode:['features','solid'],family:MATERIAL_GENERATOR_PRESETS.map(p=>p.recipe.pattern.family),shape:['rectangle','square','triangle'],bond:['stack','staggered'],direction:['vertical','horizontal'],style:['realistic','stylized','pixel'],outline:['pointed','oval','lobed'],cut:['end','lengthwise'],type:[...MATERIAL_PATTERN_TYPES],concentrationSpace:['face','model'],concentrationAxes:['x','y','z','xy','xz','yz','xyz']};
type SurfaceExample=keyof typeof OBJECT_SURFACE_EXAMPLES;
type Example='material'|SurfaceExample;
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
  let baked:GeneratedMaterialPixels|undefined,worker:Worker|undefined,mapTab='3d',shape='cube',repeat=1,raf=0;
  let mode:Example='material',surfaceRecipe=objectSurfaceSchema.parse(OBJECT_SURFACE_EXAMPLES.grass),surfaceBake:ObjectSurfaceBake|undefined,surfaceView:ObjectSurfaceView|undefined,inspectFace:BoxSurface='front',maskFaces:Record<string,{width:number;height:number;data:Uint8Array}>|undefined;
  let inspection='material';const shapeHandles=new Map<string,Handle>(),debugMaterials:THREE.ShaderMaterial[]=[];
  let surfaceMaterials:THREE.MeshStandardMaterial[]=[];
  const surfaceDrafts=Object.fromEntries(Object.entries(OBJECT_SURFACE_EXAMPLES).map(([id,r])=>[id,objectSurfaceSchema.parse(r)])) as Record<SurfaceExample,ResolvedObjectSurface>;
  for(const id of Object.keys(surfaceDrafts))try{const saved=localStorage.getItem('patchgames-object-surface-'+id);if(saved)surfaceDrafts[id as SurfaceExample]=objectSurfaceSchema.parse(JSON.parse(saved));}catch{}
  const root=node('section','','ml');root.setAttribute('aria-label','Material generator lab');const style=node('style');style.textContent=css;root.append(style);
  const header=node('header'),brand=node('div');brand.append(node('div','PATCHGAMES ENGINE / MATERIALS','eyebrow'),node('div','Material Lab','brand'));
  header.append(brand,node('p','Make a surface. Shape its character. Keep the recipe.'),node('div','','spacer'),node('span','54 materials + 7 surface examples','badge'));
  if(onClose){const close=node('button','Close lab','close');close.onclick=onClose;header.append(close);}root.append(header);
  const body=node('div','','body'),library=node('aside','','library'),workspace=node('main','','workspace'),controls=node('aside','','controls');body.append(library,workspace,controls);root.append(body);
  const examples=node('div','','surface-examples');
  for(const[id,text]of [...Object.entries(OBJECT_SURFACE_EXAMPLES).map(([id,r])=>[id,r.name]),['material','Material swatches']]){const button=node('button',text);button.dataset.example=id;button.onclick=()=>setExample(id as Example);examples.append(button);}library.append(node('h2','Object surface recipes'),examples,node('h2','Material library'));const search=node('input');search.type='search';search.placeholder='Search materials…';search.setAttribute('aria-label','Search materials');
  const filter=select(['all',...choice.family],'all');filter.setAttribute('aria-label','Filter material family');const count=node('p','','library-count'),cards=node('div','','cards');library.append(search,filter,count,cards);
  const entries=structuredClone([...MATERIAL_LAB_PRESETS,...MATERIAL_GENERATOR_PRESETS.filter(p=>['bark','leaf','needle','exposed-wood'].includes(p.recipe.pattern.family))].map(item=>({id:item.id,recipe:materialGeneratorSchema.parse(item.recipe)})));
  try{const saved=JSON.parse(localStorage.getItem('patchgames-material-lab-v1')??'[]');if(Array.isArray(saved))for(const item of saved.slice(0,50)){const parsed=materialGeneratorSchema.safeParse(item.recipe);if(parsed.success&&typeof item.id==='string')entries.push({id:item.id,recipe:parsed.data});}}catch{}
  const titlebar=node('div','','titlebar'),heading=node('div'),title=node('h1'),subtitle=node('div','','sub');heading.append(title,subtitle);const shuffle=node('button','New seed');titlebar.append(heading,shuffle);workspace.append(titlebar);
  const viewport=node('div','','viewport'),canvas=node('canvas'),mapCanvas=node('canvas'),hint=node('span','Drag to orbit · scroll to zoom','hint'),busy=node('span','Generating…','busy');mapCanvas.hidden=true;viewport.append(canvas,mapCanvas,hint,busy);workspace.append(viewport);
  const tabs=node('div','','tabs');tabs.setAttribute('role','group');tabs.setAttribute('aria-label','Preview map');const tabButtons=new Map<string,HTMLButtonElement>();
  for(const id of ['3d',...mapNames,'mask','opacity']){const button=node('button',id==='3d'?'3D material':id==='ao'?'Occlusion':id==='mask'?'Blend mask':id==='opacity'?'Opacity':label(id));button.onclick=()=>{mapTab=id;showMap();};tabs.append(button);tabButtons.set(id,button);}workspace.append(tabs);
  const toolbar=node('div','','toolbar'),shapeChoice=select(['sphere','cube','plane','card'],shape),light=select(['studio','warm','cool'],'studio'),tiling=select(['1','2','4'],'1');
  shapeChoice.setAttribute('aria-label','Preview geometry');light.setAttribute('aria-label','Lighting');tiling.setAttribute('aria-label','Tile repeats');
  const rotate=node('input');rotate.type='checkbox';rotate.id='ml-rotate';const rotateLabel=node('label','Auto rotate');rotateLabel.prepend(rotate);
  const faceChoice=select([...BOX_SURFACES],inspectFace);faceChoice.setAttribute('aria-label','Inspect geometric face');faceChoice.hidden=true;faceChoice.onchange=()=>{inspectFace=faceChoice.value as BoxSurface;if(surfaceBake)baked=surfaceBake.faces[inspectFace];showMap();};
  const inspectionChoice=select(['material','checker grid','texture density'],'material');inspectionChoice.setAttribute('aria-label','Surface inspection');
  const densityTarget=node('input');densityTarget.type='number';densityTarget.min='1';densityTarget.max='8192';densityTarget.value='256';densityTarget.setAttribute('aria-label','Target texels per metre');densityTarget.style.width='75px';
  toolbar.append(faceChoice,shapeChoice,light,node('label','Density multiplier'),tiling,inspectionChoice,node('label','Target texels/m'),densityTarget,rotateLabel);workspace.append(toolbar);
  const distributionStatus=node('output','','note');distributionStatus.setAttribute('aria-label','Feature generation diagnostics');workspace.append(distributionStatus);
  const mappingStatus=node('output','','note');mappingStatus.setAttribute('aria-label','Texture mapping diagnostics');workspace.append(mappingStatus);
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
  const meshes={sphere:new THREE.Mesh(new THREE.SphereGeometry(1.35,96,64),fallback),cube:new THREE.Mesh(new THREE.BoxGeometry(2.2,2.2,2.2,1,1,1),fallback),plane:new THREE.Mesh(new THREE.BoxGeometry(2.8,2.8,0.08),fallback),card:new THREE.Mesh(new THREE.PlaneGeometry(1,1),fallback)};
  const previewSizes:Record<string,[number,number,number]>={cube:[2.2,2.2,2.2],plane:[2.8,2.8,0.08]};
  mapBoxMaterialMeters(meshes.cube.geometry);mapBoxMaterialMeters(meshes.plane.geometry);
  for(const[id,mesh]of Object.entries(meshes)){mesh.visible=id===shape;group.add(mesh);}group.rotation.set(-0.12,0.35,0);
  const render=()=>{if(!disposed&&mapTab==='3d')renderer.render(scene,camera);};
  const resize=new ResizeObserver(()=>{const rect=viewport.getBoundingClientRect();renderer.setSize(Math.max(1,rect.width),Math.max(1,rect.height),false);camera.aspect=rect.width/Math.max(1,rect.height);camera.updateProjectionMatrix();render();});resize.observe(viewport);
  function announce(text:string,error=false){status.textContent=text;status.classList.toggle('error',error);}
  function displayedPixels(){
    if(!baked)return;
    if(mapTab==='mask')return mode==='material'?undefined:maskFaces?.[inspectFace];
    if(mapTab==='opacity'){const image=baked.color,data=new Uint8Array(image.data.length);for(let k=0;k<data.length;k+=4){data[k]=data[k+1]=data[k+2]=image.data[k+3];data[k+3]=255;}return{...image,data};}
    return baked[mapTab==='3d'?'color':mapTab as MapName];
  }
  function showMap(){distributionStatus.textContent=mode==='material'?'':surfaceRecipe.layers.filter(l=>l.coverage.kind==='pattern').map(l=>{if(l.coverage.kind!=='pattern')return '';const p=l.coverage.pattern,d=inspectMaterialPatternDistribution(p,{faceMeters:boxSurfaceFrame(surfaceRecipe.sizeMeters,inspectFace).span,modelMeters:surfaceRecipe.sizeMeters});return l.id+': '+(d.solid?'solid fill':(d.complete?'':'at least ')+d.count+' generated centres / '+d.groups+' groups ('+p.concentration.space+' domain; before gates and overlap)');}).join(' · ');canvas.hidden=mapTab!=='3d';mapCanvas.hidden=mapTab==='3d';hint.textContent=mapTab==='3d'?'Drag to orbit · scroll to zoom':mapTab==='mask'?'Combined layer coverage · black base / white layer':'Texture map · export with PNG map';for(const[id,button]of tabButtons){button.setAttribute('aria-pressed',String(id===mapTab));if(id==='mask')button.disabled=mode==='material';}if(baked&&mapTab!=='3d'){const image=displayedPixels();if(image)paint(mapCanvas,image);mapCanvas.style.objectFit='contain';mapCanvas.style.imageRendering=(mode==='material'?recipe.output.style:surfaceRecipe.output.style)==='pixel'?'pixelated':'auto';}render();}
  function showRecipe(){if(mode!=='material'){title.textContent=surfaceRecipe.name;subtitle.textContent=(mode==='grass'?'Model +Y top / continuous side fringe':mode==='slash'?'Model front / one non-repeating slash':'Model-space patterned material blend')+' / '+surfaceRecipe.output.style;editor.value=JSON.stringify(surfaceRecipe,null,2);return;}title.textContent=recipe.name;subtitle.textContent=`${label(recipe.pattern.family)} / seed ${recipe.seed} / ${recipe.output.style}`;editor.value=JSON.stringify(recipe,null,2);}
  function schedule(){showRecipe();clearTimeout(debounce);worker?.terminate();worker=undefined;sequence++;exportMap.disabled=true;busy.hidden=false;busy.textContent='Waiting for preview…';debounce=window.setTimeout(generate,180);}
  function generate(){
    if(disposed)return;const id=sequence,started=performance.now();
    if(mode==='material'){const parsed=materialGeneratorSchema.safeParse(recipe);if(!parsed.success){busy.hidden=true;announce(parsed.error.issues.map(i=>i.path.join('.')+': '+i.message).join(' · '),true);return;}recipe=parsed.data;}
    else{const parsed=objectSurfaceSchema.safeParse(surfaceRecipe);if(!parsed.success){busy.hidden=true;announce(parsed.error.issues.map(i=>i.path.join('.')+': '+i.message).join(' · '),true);return;}
      // Drafts are already resolved when selected/imported. Keep their identity:
      // controls close over layer/pattern objects, not the validation result.
      surfaceDrafts[mode]=surfaceRecipe;}
    busy.textContent=mode==='material'?'Generating material…':'Generating six object surfaces…';
    worker=new Worker(new URL('./material-lab-worker.ts',import.meta.url),{type:'module'});
    worker.onerror=()=>{busy.hidden=true;announce('The preview worker failed. Try a lower resolution.',true);};
    worker.onmessage=event=>{
      if(disposed||event.data.id!==sequence||id!==sequence)return;busy.hidden=true;
      if(event.data.error){announce(event.data.error,true);worker?.terminate();worker=undefined;return;}
      exportMap.disabled=false;
      if(event.data.surface){surfaceBake=event.data.surface;maskFaces=event.data.masks;if(surfaceView)surfaceView.update(surfaceBake!);else{surfaceView=new ObjectSurfaceView(surfaceBake!);group.add(surfaceView.root);}surfaceMaterials=surfaceView.root.material;surfaceView.root.scale.setScalar((mode==='slash'?3.5:2.2)/Math.max(...surfaceRecipe.sizeMeters));surfaceView.root.visible=true;for(const mesh of Object.values(meshes))mesh.visible=false;baked=surfaceBake!.faces[inspectFace];}
      else{baked=event.data.baked;meshes.card.geometry.dispose();meshes.card.geometry=new THREE.PlaneGeometry(...recipe.tileMeters);meshes.card.scale.setScalar(2.8/Math.max(...recipe.tileMeters));for(const h of shapeHandles.values())h.dispose();shapeHandles.clear();for(const[id,mesh]of Object.entries(meshes)){const next=createGeneratedMaterialFromPixels(baked!,id==='sphere'?{surfaceMeters:[2*Math.PI*1.35,Math.PI*1.35]}:id==='card'?{surfaceMeters:recipe.tileMeters}:{uvSpace:'metres'});shapeHandles.set(id,next);mesh.material=next.material;}}
      setRepeats();showMap();
      const bytes=mode==='material'?baked!.diagnostics.bytes:surfaceBake!.diagnostics.bytes;
      const fitWarnings=baked!.diagnostics.warnings.filter(w=>w.startsWith('Plant silhouette')||w.startsWith('Plant width'));
      announce(baked!.color.width+' × '+baked!.color.height+' · '+(mode==='material'?'6 maps':'6 faces / 36 maps')+' · '+(bytes/1048576).toFixed(1)+' MiB · '+Math.round(performance.now()-started)+' ms bake'+(mode==='slash'?' · Shading relief; collision unchanged':'')+(fitWarnings.length?' · '+fitWarnings.join(' '):''));
      worker?.terminate();worker=undefined;
    };worker.postMessage(mode==='material'?{id,recipe}:{id,surfaceRecipe});
  }
  function setRepeats(){if(mode==='material'&&baked)for(const[id,h]of shapeHandles)for(const map of Object.values(h.maps))map.repeat.set(id==='card'?repeat:repeat*(id==='sphere'?2*Math.PI*1.35:1)/baked.recipe.tileMeters[0],id==='card'?repeat:repeat*(id==='sphere'?Math.PI*1.35:1)/baked.recipe.tileMeters[1]);updateInspection();render();}
  function updateInspection(){
    for(const mat of debugMaterials)mat.dispose();debugMaterials.length=0;
    for(const[id,mesh]of Object.entries(meshes))mesh.material=shapeHandles.get(id)?.material??fallback;
    if(surfaceView)surfaceView.root.material=surfaceMaterials;
    if(!baked)return;
    const target=Number(densityTarget.value);if(!Number.isFinite(target)||target<=0){mappingStatus.textContent='Target density must be positive.';return;}
    const densities:ReturnType<typeof inspectTextureDensity>[]=[];
    const debug=(geometry:THREE.BufferGeometry,size:[number,number],repeats:[number,number],uvMeters:[number,number]=[1,1])=>{
      densities.push(inspectTextureDensity(geometry,size,repeats));
      const material=createMaterialMappingDebug({mode:inspection==='checker grid'?'checker':'density',textureSize:size,repeat:repeats,uvMeters,targetTexelsPerMeter:target});debugMaterials.push(material);return material;
    };
    if(mode==='material'){
      const mesh=meshes[shape as keyof typeof meshes],h=shapeHandles.get(shape);if(!h)return;
      const mat=debug(mesh.geometry,[baked.color.width,baked.color.height],h.maps.color.repeat.toArray() as [number,number],shape==='sphere'?[2*Math.PI*1.35,Math.PI*1.35]:shape==='card'?recipe.tileMeters:[1,1]);
      if(inspection!=='material')mesh.material=mat as unknown as THREE.MeshStandardMaterial;
    }else if(surfaceView&&surfaceBake){
      const materials=BOX_SURFACES.map((face,index)=>{
        const geometry=surfaceView!.root.geometry.clone();const group=geometry.groups[index];geometry.setIndex(Array.from({length:group.count},(_,i)=>geometry.index!.getX(group.start+i)));
        const image=surfaceBake!.faces[face].color,mat=debug(geometry,[image.width,image.height],[1,1],boxSurfaceFrame(surfaceRecipe.sizeMeters,face).span);geometry.dispose();return mat;
      });if(inspection!=='material')surfaceView.root.material=materials as unknown as THREE.MeshStandardMaterial[];
    }
    const low=Math.min(...densities.map(d=>d.minimum)),high=Math.max(...densities.map(d=>d.maximum)),stretch=Math.max(...densities.map(d=>d.anisotropy));
    mappingStatus.textContent=`${low.toFixed(0)}–${high.toFixed(0)} texels/model metre · ${stretch.toFixed(2)}× worst directional ratio · Checker squares: 0.25 m. Density: red below ${target}, green at target, blue above; magenta >2× distortion.`+(shape==='sphere'&&mode==='material'?' Sphere UVs compress at the poles; use authored UVs for curved assets.':'')+(mode!=='material'?' Bounded face maps; preview fit does not change model density.':shape==='card'?' Card uses physical tile dimensions; display fit does not change density.':' Box dimensions are baked into UVs; scale geometry before mapping.');
  }
  inspectionChoice.onchange=()=>{inspection=inspectionChoice.value;mapTab='3d';updateInspection();showMap();};densityTarget.onchange=()=>{updateInspection();render();};
  function field(key:string,value:unknown,change:(v:unknown)=>void,range?:[number,number,number]){
    const wrap=node('label','','field');wrap.append(node('span',label(key)));
    if(typeof value==='boolean'){const input=node('input');input.type='checkbox';input.checked=value;input.onchange=()=>change(input.checked);wrap.append(input);}
    else if(choice[key]){const control=select(choice[key],String(value));control.onchange=()=>change(control.value);wrap.append(control);}
    else if(Array.isArray(value)){const pair=node('div','','pair'),values=[...value];value.forEach((part,i)=>{const input=node('input');input.type='number';input.min='0.002';input.max='100';input.step='0.01';input.value=String(part);input.setAttribute('aria-label',`${label(key)} ${i===0?'width':'height'}`);input.onchange=()=>{values[i]=input.valueAsNumber;change([...values]);};pair.append(input);});wrap.append(pair);}
    else if(typeof value==='string'){const input=node('input');input.type=key.toLowerCase().includes('color')?'color':'text';input.value=value;input.onchange=()=>change(input.value);wrap.append(input);}
    else if(typeof value==='number'){
      const meter=key.endsWith('Meters'),seed=key.toLowerCase().endsWith('seed'),palette=key==='paletteSteps';
      const min=range?range[0]:seed?-2147483648:palette?2:meter&& !['gapMeters','mortarMeters','reliefMeters'].includes(key)?0.002:0;
      const max=range?range[1]:seed?2147483647:palette?32:meter?key==='reliefMeters'?0.2:key==='gapMeters'?0.05:key==='mortarMeters'?0.1:2:1;
      const step=range?range[2]:seed||palette?1:meter?0.001:0.01,row=node('div','','range-row'),input=node('input');input.type='number';input.min=String(min);input.max=String(max);input.step=String(step);input.value=String(value);input.setAttribute('aria-label',label(key));
      if(!seed){const slider=node('input');slider.type='range';slider.min=String(min);slider.max=String(max);slider.step=String(step);slider.value=String(value);slider.setAttribute('aria-label',label(key)+' slider');slider.oninput=()=>{input.value=slider.value;change(slider.valueAsNumber);};input.onchange=()=>{slider.value=input.value;change(input.valueAsNumber);};row.append(slider);}else input.onchange=()=>change(input.valueAsNumber);
      row.append(input);wrap.append(row);
    }fields.append(wrap);
  }
  function buildFields(){
    fields.replaceChildren();if(mode!=='material'){buildSurfaceFields();return;}field('name',recipe.name,value=>{recipe.name=String(value);showRecipe();});
    if(shape==='cube'||shape==='plane'){
      fields.append(node('h3','Preview size / metres'));
      for(const [axis,name] of ['Width','Height','Depth'].entries())field(name,previewSizes[shape][axis],value=>{
        const n=Number(value);if(!Number.isFinite(n)||n<0.01||n>5)return;previewSizes[shape][axis]=n;
        const mesh=meshes[shape as 'cube'|'plane'];mesh.geometry.dispose();mesh.geometry=new THREE.BoxGeometry(...previewSizes[shape]);mapBoxMaterialMeters(mesh.geometry);updateInspection();render();
      },[0.01,5,0.01]);
    }
    field('family',recipe.pattern.family,value=>{const preset=MATERIAL_GENERATOR_PRESETS.find(p=>p.recipe.pattern.family===value)!;recipe=materialGeneratorSchema.parse({...recipe,pattern:preset.recipe.pattern,tileMeters:preset.recipe.tileMeters,color:preset.recipe.color,secondaryColor:preset.recipe.secondaryColor});shape=['leaf','needle'].includes(recipe.pattern.family)?'card':'cube';shapeChoice.value=shape;syncMode();buildFields();schedule();});
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
    for(const button of examples.children)button.setAttribute('aria-pressed',String((button as HTMLButtonElement).dataset.example===mode));
    if(mode==='material'&&mapTab==='mask')mapTab='3d';
  }
  function setExample(next:Example){
    if(mode!=='material')surfaceDrafts[mode]=surfaceRecipe;
    mode=next;activeId=mode==='material'?activeId:'';
    if(mode!=='material'){
      surfaceRecipe=surfaceDrafts[mode];
      group.rotation.set(mode==='slash'?.12:.3,mode==='slash'?-.12:-.5,0);camera.position.z=5.8;
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
    if(mode!=='grass'&&mode!=='slash'){
      for(const layer of surfaceRecipe.layers){
        fields.append(node('h3','Blend layer / '+layer.id));
        field('family',layer.material.pattern.family,value=>{const preset=MATERIAL_GENERATOR_PRESETS.find(p=>p.recipe.pattern.family===value)!;layer.material=materialGeneratorSchema.parse(preset.recipe);buildFields();schedule();});
        field('Layer color',layer.material.color,value=>{layer.material.color=String(value);schedule();});
        field('Layer shadow color',layer.material.secondaryColor,value=>{layer.material.secondaryColor=String(value);schedule();});
        field('Layer tile metres',layer.material.tileMeters,value=>{layer.material.tileMeters=value as [number,number];schedule();});
        field('Layer roughness',layer.material.roughness,value=>{layer.material.roughness=Number(value);schedule();});
        if(layer.material.pattern.family==='metal')field('Layer metalness',layer.material.pattern.metalness,value=>{if(layer.material.pattern.family==='metal')layer.material.pattern.metalness=Number(value);schedule();});
        field('opacity',layer.opacity,value=>{layer.opacity=Number(value);schedule();});
        field('heightOffsetMeters',layer.heightOffsetMeters,value=>{layer.heightOffsetMeters=Number(value);schedule();},[-.1,.1,.001]);
        if(layer.coverage.kind==='pattern'){
          const pattern=layer.coverage.pattern;
          field('generationMode',pattern.mode,value=>{pattern.mode=value as 'features'|'solid';buildFields();schedule();});
          if(pattern.mode==='features'){
          for(const key of ['type','density','coverage','sizeMeters','irregularity','placementRegularity','shapeVariation','sizeVariation','clumping','groupSizeMeters','edgeSoftnessMeters','angleRadians','seed','invert'] as const){
            const range=key==='density'?[0,256,1] as [number,number,number]:key==='sizeMeters'?[.002,2,.002] as [number,number,number]:key==='groupSizeMeters'?[.004,5,.004] as [number,number,number]:key==='edgeSoftnessMeters'?[0,.2,.001] as [number,number,number]:key==='angleRadians'?[-6.28,6.28,.01] as [number,number,number]:undefined;
            field(key==='seed'?'Pattern seed':key,pattern[key],value=>{Object.assign(pattern,{[key]:value});schedule();},range);
          }
          fields.append(node('h3','Pattern concentration'));
          const focus=pattern.concentration;
          field('Concentration strength',focus.strength,value=>{focus.strength=Number(value);schedule();},[-1,1,.01]);
          field('concentrationSpace',focus.space,value=>{focus.space=value as 'face'|'model';schedule();});
          field('concentrationAxes',focus.axes,value=>{focus.axes=value as typeof focus.axes;schedule();});
          field('Concentration radius',focus.radius,value=>{focus.radius=Number(value);schedule();},[.01,2,.01]);
          field('Concentration falloff',focus.softness,value=>{focus.softness=Number(value);schedule();});
          for(const [axis,name] of ['X','Y','Z'].entries())field('Concentration center '+name,focus.center[axis],value=>{focus.center[axis]=Number(value);schedule();},[-1,1,.01]);
          fields.append(node('p','Placement regularity: 0 scattered, 1 grid. Intermediate settings mix both at similar density. Concentration: +1 inward, 0 uniform, -1 outward. Feature density sets the number of centres per square/cubic metre; feature size sets each shape. Clumping collects scattered features around parents; larger groups are fewer and wider. These controls do not fade surviving features.','note'));
          }
          if(pattern.boundary){
            fields.append(node('h3','Boundary mask / explicit fade'));
            const boundary=pattern.boundary;
            field('Boundary strength',boundary.strength,value=>{boundary.strength=Number(value);schedule();},[-1,1,.01]);
            for(const key of ['space','axes'] as const){const wrap=node('label','','field'),control=select(key==='space'?['face','model']:['x','y','z','xy','xz','yz','xyz'],boundary[key]);wrap.append(node('span','Boundary '+key),control);control.onchange=()=>{Object.assign(boundary,{[key]:control.value});schedule();};fields.append(wrap);}
            field('Boundary radius',boundary.radius,value=>{boundary.radius=Number(value);schedule();},[.01,2,.01]);
            field('Boundary falloff',boundary.softness,value=>{boundary.softness=Number(value);schedule();});
            for(const [axis,name] of ['X','Y','Z'].entries())field('Boundary center '+name,boundary.center[axis],value=>{boundary.center[axis]=Number(value);schedule();},[-1,1,.01]);
          }
          const boundaryToggle=node('button',pattern.boundary?'Remove boundary mask':'Add boundary mask');boundaryToggle.onclick=()=>{if(pattern.boundary)delete pattern.boundary;else pattern.boundary={...pattern.concentration,strength:1,center:[...pattern.concentration.center]};buildFields();schedule();};fields.append(boundaryToggle);
          const restrict=node('button',pattern.gates.length?'Remove vein restriction':'Restrict pattern to veins');restrict.onclick=()=>{const {gates,...gate}=parseMaterialPattern({type:'veins',sizeMeters:.3,coverage:.45,seed:pattern.seed});void gates;pattern.gates=pattern.gates.length?[]:[{operation:'intersect',pattern:gate}];buildFields();schedule();};fields.append(restrict);
        }
        const remove=node('button','Remove layer '+layer.id);remove.onclick=()=>{surfaceRecipe.layers=surfaceRecipe.layers.filter(item=>item!==layer);buildFields();schedule();};fields.append(remove);
      }
      const add=node('button','Add patterned material layer');add.disabled=surfaceRecipe.layers.length>=4;add.onclick=()=>{const layer=objectSurfaceSchema.parse(OBJECT_SURFACE_EXAMPLES.iron).layers[0];layer.id='layer-'+Date.now();surfaceRecipe.layers.push(layer);buildFields();schedule();};fields.append(add,node('p','Pattern coordinates stay in model metres. Source tile repeats are independent. Blend mask shows combined layer opacity.','note'));
    }
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
    }else if(mode==='slash'){
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
    const resolution=node('label','','field');resolution.append(node('span','Resolution (longest axis)'));const sizes=select(['32','64','128','256','512'],String(surfaceRecipe.output.resolution));sizes.setAttribute('aria-label','Resolution (longest axis)');sizes.onchange=()=>{surfaceRecipe.output.resolution=Number(sizes.value) as ResolvedObjectSurface['output']['resolution'];schedule();};resolution.append(sizes);fields.append(resolution);
    field('style',surfaceRecipe.output.style,value=>{surfaceRecipe.output.style=value as ResolvedObjectSurface['output']['style'];schedule();});
    field('paletteSteps',surfaceRecipe.output.paletteSteps,value=>{surfaceRecipe.output.paletteSteps=Number(value);schedule();});
  }
  const thumbWorker=new Worker(new URL('./material-lab-worker.ts',import.meta.url),{type:'module'}),thumbQueue:{id:string;recipe:ResolvedMaterialGenerator}[]=[],thumbs=new Map<string,HTMLCanvasElement>();let thumbBusy=false;
  function nextThumb(){if(disposed||thumbBusy||!thumbQueue.length)return;thumbBusy=true;const item=thumbQueue.shift()!;thumbWorker.postMessage({...item,resolution:96,thumbnail:true});}
  thumbWorker.onmessage=event=>{const target=thumbs.get(event.data.id);if(target&&event.data.color)paint(target,event.data.color);thumbBusy=false;nextThumb();};thumbWorker.onerror=()=>{thumbBusy=false;announce('Some library thumbnails could not load. Select a material to preview it.',true);};
  function buildCards(){cards.replaceChildren();const query=search.value.toLowerCase(),shown=entries.filter(item=>(filter.value==='all'||filter.value===item.recipe.pattern.family)&&(item.recipe.name+' '+item.recipe.pattern.family).toLowerCase().includes(query));count.textContent=`${shown.length} materials · 54 engine examples`;
    for(const item of shown){const button=node('button','','card');button.setAttribute('aria-pressed',String(item.id===activeId));button.setAttribute('aria-label',item.recipe.name);let thumb=thumbs.get(item.id);if(!thumb){thumb=node('canvas');thumbs.set(item.id,thumb);thumbQueue.push(item);}button.append(thumb,node('span',item.recipe.name));button.onclick=()=>{mode='material';activeId=item.id;recipe=materialGeneratorSchema.parse(structuredClone(item.recipe));shape=['leaf','needle'].includes(recipe.pattern.family)?'card':'cube';shapeChoice.value=shape;syncMode();buildCards();buildFields();schedule();};cards.append(button);}if(!shown.length)cards.append(node('p','No matching materials.','empty'));nextThumb();
  }
  search.oninput=buildCards;filter.onchange=buildCards;shuffle.onclick=()=>{const seed=Math.floor(Math.random()*2147483647);if(mode==='material')recipe.seed=seed;else{surfaceRecipe.seed=seed;surfaceRecipe.base.seed=seed;surfaceRecipe.layers.forEach(layer=>{layer.material.seed=seed;if(layer.coverage.kind==='pattern')layer.coverage.pattern.seed=seed;});}buildFields();schedule();};
  shapeChoice.onchange=()=>{shape=shapeChoice.value;for(const[id,mesh]of Object.entries(meshes))mesh.visible=id===shape;buildFields();updateInspection();render();};
  light.onchange=()=>{key.color.set(light.value==='warm'?0xffc57c:light.value==='cool'?0xa4caff:0xffedcc);render();};tiling.onchange=()=>{repeat=Number(tiling.value);setRepeats();};
  function animate(){if(disposed||!rotate.checked)return;group.rotation.y+=0.004;render();raf=requestAnimationFrame(animate);}rotate.onchange=()=>{cancelAnimationFrame(raf);if(rotate.checked)animate();};
  let drag:{x:number;y:number}|undefined;canvas.onpointerdown=event=>{canvas.setPointerCapture(event.pointerId);drag={x:event.clientX,y:event.clientY};};canvas.onpointermove=event=>{if(!drag)return;group.rotation.y+=(event.clientX-drag.x)*0.008;group.rotation.x=Math.max(-1.3,Math.min(1.3,group.rotation.x+(event.clientY-drag.y)*0.008));drag={x:event.clientX,y:event.clientY};render();};canvas.onpointerup=canvas.onpointercancel=()=>{drag=undefined;};canvas.onwheel=event=>{event.preventDefault();camera.position.z=Math.max(3.2,Math.min(10,camera.position.z+event.deltaY*0.003));render();};
  exportRecipe.onclick=()=>{const data=mode==='material'?recipe:surfaceRecipe;download(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),data.name+'.json');};
  exportMap.onclick=()=>{const pixels=displayedPixels();if(!pixels)return;const temp=node('canvas'),id=mapTab==='3d'?'color':mapTab;paint(temp,pixels);temp.toBlob(blob=>{if(blob)download(blob,(mode==='material'?recipe.name:surfaceRecipe.name+'-'+inspectFace)+'-'+id+'.png');});};
  save.onclick=()=>{if(mode!=='material'){try{localStorage.setItem('patchgames-object-surface-'+mode,JSON.stringify(objectSurfaceSchema.parse(surfaceRecipe)));announce('Surface recipe saved in this browser. Export JSON for a portable copy.');}catch(error){announce(String(error),true);}return;}try{const parsed=materialGeneratorSchema.parse(recipe),item={id:'saved-'+Date.now(),recipe:parsed};entries.push(item);const saved=entries.filter(item=>item.id.startsWith('saved-')).slice(-50);localStorage.setItem('patchgames-material-lab-v1',JSON.stringify(saved));activeId=item.id;search.value='';filter.value='all';buildCards();announce('Saved in this browser. Export JSON to keep a portable copy.');}catch(error){announce(String(error),true);}};
  apply.onclick=()=>{try{if(mode==='material')recipe=materialGeneratorSchema.parse(JSON.parse(editor.value));else{surfaceRecipe=objectSurfaceSchema.parse(JSON.parse(editor.value));surfaceDrafts[mode]=surfaceRecipe;}buildFields();schedule();}catch(error){announce(String(error),true);}};
  buildCards();buildFields();showMap();schedule();
  return()=>{disposed=true;clearTimeout(debounce);cancelAnimationFrame(raf);worker?.terminate();thumbWorker.terminate();resize.disconnect();surfaceView?.dispose();for(const h of shapeHandles.values())h.dispose();for(const mat of debugMaterials)mat.dispose();fallback.dispose();for(const mesh of Object.values(meshes))mesh.geometry.dispose();renderer.dispose();renderer.forceContextLoss();root.remove();};
}
