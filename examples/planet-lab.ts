import * as THREE from 'three';
import {compilePlanet,createPlanetRecipe,type CompiledPlanet,type PlanetVector} from '../src/shared/planet.ts';
import {PlanetView} from '../src/sandbox/planetView.ts';
import {createPlanetPreparationSource} from '../src/client/game/planetPreparation.ts';
import {compilePlanetSky,createPlanetSkyRecipe,type ResolvedPlanetSkyRecipe,type CompiledPlanetSky} from '../src/shared/planetSky.ts';
import {PlanetSkyView,type PlanetSkyDiagnostic} from '../src/sandbox/planetSkyView.ts';
import {preparePlanetSky} from '../src/client/game/planetSkyPreparation.ts';
import {WebGPURenderer} from 'three/webgpu';
import {PlanetSkyWebGPUView} from '../src/sandbox/planetSkyWebGPU.ts';
import {compilePlanetBiomes,createPlanetBiomeRecipe,type CompiledPlanetBiomes} from '../src/shared/planetBiomes.ts';
import {preparePlanetSurface} from '../src/client/game/planetSurfacePreparation.ts';
import {createGeneratedMaterialFromPixels} from '../src/sandbox/materialGenerator.ts';
import {PlanetWaterView} from '../src/sandbox/planetWaterView.ts';
import {PlanetPopulationView,createPreparedPlanetPopulation,type PreparedPlanetPopulation} from '../src/sandbox/planetPopulationView.ts';
import {preparePlanetPopulation,createPlanetPopulationPreparationSource} from '../src/client/game/planetPopulationPreparation.ts';
import {samplePlanetCelestial,samplePlanetSunlight} from '../src/shared/planetCelestial.ts';
import {type PlanetGeneratorRecipe,type CompiledPlanetGenerator} from '../src/shared/planetGenerator.ts';
import {createPlanetGeneratorControls} from './planetGeneratorControls.ts';
import {createPlanetAtmosphereSession,type PlanetAtmosphereSession,type PlanetAtmosphereUpdate} from '../src/client/game/planetAtmospherePreparation.ts';
import {samplePlanetAtmosphereCelestial} from '../src/shared/planetAtmosphere.ts';
import {planetAtmosphereColumnOpticalDepth} from '../src/shared/planetAtmosphereSnapshot.ts';

type FlightMode='auto'|'orbit'|'descend'|'surface'|'ground'|'clouds'|'cirrus'|'free';
interface FlightSample {
  seconds:number;intervalMs:number;updateCpuMs:number;renderCpuMs:number;callbackCpuMs:number;
  altitudeMeters:number;sourceHeightMeters:number;displayedHeightMeters:number|null;
  coarseClearanceAdjustmentMeters:number;triangles:number;drawCalls:number;focused:boolean;streaming:unknown;sky:unknown;world:unknown;weatherTimeSeconds:number;sunDirection:PlanetVector;
}
const ROUND_TRIP_SECONDS=40;
const MAX_SAMPLES=12_000;
const EARTH_RADIUS=6_371_000;
const clamp=(n:number,min:number,max:number)=>Math.max(min,Math.min(max,n));
const smooth=(n:number)=>{n=clamp(n,0,1);return n*n*(3-2*n);};
const lerp=(a:number,b:number,t:number)=>a+(b-a)*t;
const tuple=(v:THREE.Vector3):PlanetVector=>[v.x,v.y,v.z];
const rounded=(n:number)=>Math.round(n*100)/100;
const percentile=(values:number[],q:number)=>{if(!values.length)return 0;const sorted=[...values].sort((a,b)=>a-b);return rounded(sorted[Math.floor((sorted.length-1)*q)]);};
function distribution(values:number[]){return{p50:percentile(values,.5),p95:percentile(values,.95),p99:percentile(values,.99),max:values.length?rounded(Math.max(...values)):0,over33:values.filter(n=>n>33).length,over50:values.filter(n=>n>50).length};}
function element<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,className?:string){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;}
function altitudeLabel(metres:number){return metres>=1_000_000?(metres/1_000_000).toFixed(2)+' Mm':metres>=1000?(metres/1000).toFixed(2)+' km':metres.toFixed(1)+' m';}

/** A host application demo. The renderer receives local floats; the recipe,
 * camera route and deterministic surface sampler retain absolute metre doubles. */
export function mountPlanetLab(parent:HTMLElement):()=>void {
  let cancelled=false,dispose=()=>{};
  void startPlanetLab(parent).then(result=>{if(cancelled)result();else dispose=result;}).catch(error=>{const message=element('pre','Planet lab could not start: '+(error instanceof Error?error.message:String(error)));message.setAttribute('role','alert');parent.append(message);});
  return()=>{cancelled=true;dispose();};
}
async function startPlanetLab(parent:HTMLElement):Promise<()=>void> {
  const simulationMode=new URL(location.href).searchParams.get('mode')!=='art';
  if(simulationMode)document.title='Planet Simulator · PatchGames Engine';
  const root=element('main',undefined,'planetlab');
  const style=element('style',`
    .planetlab{font:14px/1.5 system-ui,sans-serif;background:#071017;color:#e4edf2;height:100dvh;display:flex;flex-direction:column;overflow:hidden}
    .planetlab *{box-sizing:border-box}.planetlab [hidden]{display:none!important}.planetlab header{padding:14px 20px;border-bottom:1px solid #24424c;display:flex;align-items:center;gap:24px}
    .planetlab h1{font-size:22px;line-height:1.2;margin:2px 0}.planetlab small{font-size:10px;letter-spacing:.12em;color:#8db9c8}.planetlab p{margin:8px 0}
    .planetlab a{color:#a6dbe6}.planetlab header a{margin-left:auto;white-space:nowrap}.planetlab header p{color:#a7c0cc;font-size:12px}
    .planetlab section{display:grid;grid-template-columns:minmax(0,1fr) 318px;min-height:0;flex:1}.planetlab .flight{position:relative;min-height:280px;overflow:hidden;background:#030810}
    .planetlab canvas{display:block;width:100%;height:100%}.planetlab .telemetry{position:absolute;left:20px;top:18px;background:#06121bc7;border:1px solid #254956;padding:12px 16px;border-radius:8px;pointer-events:none;min-width:220px}
    .planetlab .altitude{font-size:28px;font-weight:650;letter-spacing:-.025em}.planetlab .hint{position:absolute;left:18px;bottom:16px;font-size:11px;background:#06121bc7;color:#bad0db;padding:7px 10px;border-radius:6px;max-width:90%}
    .planetlab aside{overflow:auto;padding:16px;border-left:1px solid #24424c}.planetlab h2{font-size:13px;margin:20px 0 8px;color:#b9dce7}.planetlab .buttons{display:flex;gap:7px;flex-wrap:wrap}
    .planetlab button,.planetlab select,.planetlab input[type=number]{background:#132832;color:#def0f6;border:1px solid #385b69;border-radius:6px;padding:8px 10px;font:inherit;font-size:12px;cursor:pointer}
    .planetlab button:hover,.planetlab button[aria-pressed=true]{background:#254954;border-color:#7abac8}.planetlab button:disabled{opacity:.4;cursor:default}.planetlab .primary{background:#416a62;border-color:#85c6b1;color:#f1fff9}
    .planetlab label{display:block;margin-top:14px;font-size:12px;color:#bad0db}.planetlab input[type=range]{display:block;width:100%;accent-color:#9bd8c1;margin:8px 0}.planetlab select,.planetlab input[type=number]{display:block;width:100%;margin-top:5px}.planetlab .switches{display:flex;gap:18px}.planetlab .switches label{margin-top:9px}.planetlab details{border-top:1px solid #24424c;margin-top:16px;padding-top:12px}.planetlab summary{cursor:pointer;color:#b9dce7;font-weight:600}
    .planetlab pre{height:240px;overflow:auto;contain:strict;white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.5 ui-monospace,monospace;color:#bcd6df;background:#07131b;border:1px solid #1d3944;padding:9px;border-radius:6px;margin:5px 0}
    .planetlab .muted{font-size:11px;color:#8eafb9}.planetlab footer{padding:8px 18px;font-size:11px;color:#acd6c9;border-top:1px solid #24424c;min-height:34px}
    @media(max-width:850px){.planetlab section{grid-template-columns:minmax(0,1fr) 260px}.planetlab header p{display:none}.planetlab aside{padding:12px}.planetlab .telemetry{left:10px;top:10px;min-width:180px;padding:8px 10px}.planetlab .altitude{font-size:23px}}
    @media(max-width:560px){.planetlab header{padding:10px}.planetlab h1{font-size:18px}.planetlab section{grid-template-columns:1fr;grid-template-rows:minmax(280px,1fr) 260px}.planetlab aside{border-left:0;border-top:1px solid #24424c}.planetlab header a{font-size:11px}}
  `);root.append(style);
  const header=element('header'),brand=element('div');brand.append(element('small','PATCHGAMES ENGINE / ONE PLANET, CONTINUOUS COVERAGE'),element('h1',simulationMode?'Planet Simulator':'Planet Flight Lab'));
  const back=element('a','World LOD Lab');back.href='lod-lab.html';header.append(brand,element('p','Fly from orbit to the surface while bounded workers refine the same procedural world.'),back);root.append(header);
  const section=element('section'),viewport=element('div',undefined,'flight'),canvas=element('canvas'),sidebar=element('aside');
  const telemetry=element('div',undefined,'telemetry'),altitude=element('div','Orbit','altitude'),phaseLabel=element('div','Six-root globe • camera-relative precision'),scaleLabel=element('div',undefined,'muted'),weatherSummary=element('div',undefined,'muted');weatherSummary.title='Cloud-bearing area counts coarse atmospheric cells with condensate; it is not measured screen coverage.';const cloudHeightSummary=element('div',undefined,'muted');cloudHeightSummary.setAttribute('aria-label','Cloud formation heights');telemetry.append(altitude,phaseLabel,scaleLabel,weatherSummary,cloudHeightSummary);
  const flightHint=element('div','Drag to look around · wheel adjusts altitude · coarse ground stays visible while detail arrives','hint');flightHint.id='planet-flight-help';canvas.tabIndex=0;canvas.setAttribute('aria-label','Planet flight view');canvas.setAttribute('aria-describedby',flightHint.id);canvas.style.touchAction='none';
  viewport.append(canvas,telemetry,flightHint);section.append(viewport,sidebar);root.append(section);
  const generatorControls=simulationMode?createPlanetGeneratorControls(sidebar,generatePhysicalPlanet):undefined;
  generatorControls?.setBusy(true,'Initializing the physical atmosphere…');
  const buttons=element('div',undefined,'buttons'),modeButtons=new Map<FlightMode,HTMLButtonElement>();
  for(const [mode,label] of [['free','Free flight'],['orbit','Orbit'],['descend','Descend'],['surface','Surface'],['ground','Ground'],['clouds','Inside clouds'],['cirrus','Above clouds'],['auto','Auto flight']] as const){const button=element('button',label);button.setAttribute('aria-pressed',String(mode==='auto'));buttons.append(button);modeButtons.set(mode,button);}sidebar.append(buttons);
  const autoSpeed=element('input');autoSpeed.type='checkbox';autoSpeed.checked=true;autoSpeed.setAttribute('aria-label','Scale flight speed with altitude');const autoSpeedLabel=element('label',' Scale flight speed with altitude');autoSpeedLabel.prepend(autoSpeed);
  const manualSpeed=element('input');manualSpeed.type='number';manualSpeed.min='1';manualSpeed.max='5000000';manualSpeed.step='10';manualSpeed.value='50';manualSpeed.setAttribute('aria-label','Manual flight speed in metres per second');const manualSpeedLabel=element('label','Manual flight speed (m/s)');manualSpeedLabel.append(manualSpeed);
  const speedReadout=element('p','Free flight keeps your current position and viewing direction.','muted');sidebar.append(autoSpeedLabel,manualSpeedLabel,speedReadout);
  const nativeGPU=new URL(location.href).searchParams.get('backend')==='webgpu',backendSelect=element('select');backendSelect.setAttribute('aria-label','Renderer backend');
  for(const [value,label] of [['webgl','WebGL 2'],['webgpu','Native WebGPU']]){const option=element('option',label);option.value=value;backendSelect.append(option);}backendSelect.value=nativeGPU?'webgpu':'webgl';
  const backendControl=element('label','Renderer');backendControl.append(backendSelect);sidebar.append(backendControl);backendSelect.onchange=()=>{const url=new URL(location.href);url.searchParams.set('backend',backendSelect.value);location.href=url.href;};
  const districtSelect=element('select');districtSelect.setAttribute('aria-label','Landing biome');for(const [value,label] of [['temperate-forest','Temperate forest'],['taiga','Conifer forest'],['tropical-forest','Tropical forest'],['desert','Desert'],['beach','Coast'],['ocean','Ocean'],['grassland','Grassland'],['tundra','Tundra'],['alpine','Alpine']]){const option=element('option',label);option.value=value;districtSelect.append(option);}const districtControl=element('label','Explore a biome');districtControl.append(districtSelect);sidebar.append(districtControl);
  const radiusSelect=element('select');radiusSelect.setAttribute('aria-label','Planet radius');for(const [value,label] of [[EARTH_RADIUS,'Earth scale · 6,371 km radius'],[80_000,'Small world · 80 km radius']] as const){const option=element('option',label);option.value=String(value);radiusSelect.append(option);}const radiusControl=element('label','Planet scale');radiusControl.append(radiusSelect);sidebar.append(radiusControl);
  const detail=element('input');detail.type='range';detail.min='2';detail.max='16';detail.step='1';detail.value='6';detail.setAttribute('aria-label','Target terrain cell pixels');const detailLabel=element('label','Target cell footprint: 6 px');detailLabel.append(detail);sidebar.append(detailLabel);
  sidebar.append(element('p','Smaller targets request finer terrain. Patch and memory budgets still cap detail.','muted'));
  const skyPanel=element('details');skyPanel.open=true;skyPanel.append(element('summary','Atmosphere and volumetric clouds'));sidebar.append(skyPanel);
  const skyControls:(HTMLInputElement|HTMLSelectElement|HTMLButtonElement)[]=[];
  const check=(name:string)=>{const input=element('input');input.type='checkbox';input.checked=true;input.setAttribute('aria-label',name);const label=element('label',' '+name);label.prepend(input);skyControls.push(input);return{input,label};};
  const atmosphereToggle=check('Atmosphere'),cloudToggle=check('Clouds'),switches=element('div',undefined,'switches');switches.append(atmosphereToggle.label,cloudToggle.label);skyPanel.append(switches);
  const choose=(name:string,options:readonly (readonly [string,string])[])=>{const select=element('select');select.setAttribute('aria-label',name);for(const [value,text] of options){const option=element('option',text);option.value=value;select.append(option);}const label=element('label',name);label.append(select);skyPanel.append(label);skyControls.push(select);return select;};
  const skyStyle=choose('Sky style',[['realistic','Realistic'],['pixel','Pixelated']]),skyQuality=choose('Sky quality',[['low','Low'],['balanced','Balanced'],['high','High']]);skyQuality.value='balanced';
  const skyDiagnostic=choose('Sky inspection',[['composite','Final composite'],['scene','Captured scene'],['radiance','Scattered light'],['transmittance','Optical thickness'],['depth-rejection','Depth acceptance'],['unweighted','Unweighted composite'],['nearest','Nearest composite'],['cloud-shadow','Cloud shadow mask']]);
  const ranges=new Map<HTMLInputElement,{label:HTMLLabelElement;name:string;format:(value:number)=>string}>();
  const range=(name:string,min:number,max:number,step:number,value:number,format:(value:number)=>string=(n=>String(n)))=>{const input=element('input');input.type='range';input.min=String(min);input.max=String(max);input.step=String(step);input.value=String(value);input.setAttribute('aria-label',name);const label=element('label');label.append(element('span'),input);ranges.set(input,{label,name,format});skyPanel.append(label);skyControls.push(input);return input;};
  const percent=(n:number)=>Math.round(n*100)+'%',scaledKm=(n:number)=>{const metres=n*1000*(Number(radiusSelect.value)/EARTH_RADIUS);return metres>=1000?(metres/1000).toFixed(1)+' km':Math.round(metres)+' m';};
  const coverage=range('Cloud coverage',0,1,.01,.67,percent),cloudDensity=range('Cloud density',0,3,.05,1.25,n=>n.toFixed(2));
  const moisture=range('Atmospheric moisture',0,2,.05,1,n=>n.toFixed(2)),pressureStrength=range('Pressure systems',0,2,.05,1,n=>n.toFixed(2));
  const cloudBase=range('Cumulus base',.8,4,.1,1.2,scaledKm),cloudThickness=range('Cumulus thickness',.5,8,.1,5.8,scaledKm);
  const atmosphereHeight=range('Atmosphere height',20,160,1,80,scaledKm),haze=range('Atmospheric haze',0,3,.05,1,n=>n.toFixed(2));
  const windSpeed=range('Extra cloud drift',0,100,1,0,n=>(n*Number(radiusSelect.value)/EARTH_RADIUS).toFixed(1)+' m/s'),sunElevation=range('Sun elevation',-15,85,1,35,n=>n+'°');
  const fogDensity=range('Sea-level fog density',0,3,.05,.35,n=>n.toFixed(2)),cirrusDensity=range('Cirrus density',0,2,.05,.22,n=>n.toFixed(2));
  const cloudShadows=range('Cloud shadows',0,1,.05,.8,percent),godRays=range('God rays',0,1,.05,.8,percent);
  const sunMotion=choose('Sun motion',[['rotation','Planet rotation'],['fixed','Fixed elevation']]);
  const clockRunning=check('Run weather and rotation'),starsToggle=check('Stars'),clockSwitches=element('div',undefined,'switches');clockSwitches.append(clockRunning.label,starsToggle.label);skyPanel.append(clockSwitches);
  skyPanel.append(element('p','Pause the clock to compare the same clouds from orbit and the ground. Moving the camera changes detail, while the weather remains frozen.','muted'));
  const trackSun=check('Look toward sun');trackSun.input.checked=false;skyPanel.append(trackSun.label);
  const orbitalViews=element('div',undefined,'buttons');
  const orbitalViewButtons=new Map<'sunlit'|'twilight',HTMLButtonElement>();
  for(const [kind,label] of [['sunlit','Sunlit orbit'],['twilight','Twilight limb']] as const){const button=element('button',label);button.disabled=true;orbitalViewButtons.set(kind,button);orbitalViews.append(button);skyControls.push(button);}skyPanel.append(orbitalViews);
  skyPanel.append(element('p','With planet rotation enabled, these viewpoints pause playback and move the camera relative to the current sun. Resume weather playback when ready. Twilight helps reveal cloud shadows and atmospheric light shafts.','muted'));
  const dayDuration=range('Day duration',30,1800,10,300,n=>n+' real seconds'),timeOfDay=range('Reference time',0,24,.05,12,n=>{const hour=Math.floor(n)%24;return String(hour).padStart(2,'0')+':'+String(Math.floor((n%1)*60)).padStart(2,'0');});
  const axialTilt=range('Axial tilt',0,60,.1,23.4,n=>n.toFixed(1)+'°'),season=range('Season',0,1,.01,0,n=>Math.round(n*100)+'% of orbit');
  const timePresets=element('div',undefined,'buttons'),solarNotice=element('p','', 'muted');
  for(const name of ['Noon','Sunset','Night','Dawn'] as const){const button=element('button',name);button.onclick=()=>{
    if(benchmarkState)return;solarNotice.textContent='';const latitude=Math.asin(lastDirection[1]),declination=samplePlanetCelestial(skyRecipe.celestial,0).declinationRadians;
    let hourAngle=name==='Night'?Math.PI:0;
    if(name==='Sunset'||name==='Dawn'){
      const cosine=-Math.tan(latitude)*Math.tan(declination);
      if(cosine< -1||cosine>1){solarNotice.textContent='This latitude has polar day or night in this season. Change the season or landing location for a sunrise or sunset.';return;}
      hourAngle=Math.acos(cosine)*(name==='Dawn'?-1:1);
    }
    simulationSeconds=(hourAngle/(2*Math.PI)-Math.atan2(lastDirection[0],lastDirection[2])/(2*Math.PI)+skyRecipe.celestial.phaseTurns)*skyRecipe.celestial.dayLengthSeconds;clockRunning.input.checked=false;sunMotion.value='rotation';trackSun.input.checked=name!=='Night';yaw=0;pitch=name==='Night'?.55:0;refreshClockLabel();applySkyControls();
  };timePresets.append(button);skyControls.push(button);}skyPanel.append(timePresets,solarNotice);
  const pixelSize=range('Pixel size',2,12,1,6,n=>n+' screen pixels'),paletteSteps=range('Palette levels',2,24,1,8,n=>String(n));
  const seed=element('input');seed.type='number';seed.min='-2147483648';seed.max='2147483647';seed.step='1';seed.value='73';seed.setAttribute('aria-label','Sky seed');const seedLabel=element('label','Sky seed');seedLabel.append(seed);skyPanel.append(seedLabel);skyControls.push(seed);
  const exportSky=element('button','Export sky recipe');skyPanel.append(exportSky);skyControls.push(exportSky);
  const advanceDay=element('button','Simulate one more day');
  if(simulationMode){
    radiusControl.hidden=true;seedLabel.hidden=true;switches.hidden=true;timePresets.hidden=true;
    for(const input of [coverage,cloudDensity,moisture,pressureStrength,cloudBase,cloudThickness,atmosphereHeight,haze,windSpeed,sunElevation,fogDensity,cirrusDensity,cloudShadows,godRays,timeOfDay,axialTilt,season])ranges.get(input)!.label.hidden=true;
    sunMotion.parentElement!.hidden=true;exportSky.textContent='Export planet recipe';skyPanel.querySelector('summary')!.textContent='Weather playback and rendering';
    ranges.get(dayDuration)!.name='Real seconds per planet rotation';
    skyPanel.append(advanceDay,element('p','The solver advances in fixed physical steps. Its achieved time and any backlog are shown below. Initial conditions are not a mature climate; let several rotations develop.','muted'));
  }
  skyPanel.append(element('p',simulationMode?'Cloud bases and tops follow local temperature, moisture, pressure, gravity and terrain. The displayed heights describe the same uploaded weather seen from orbit and the ground. Two-layer vertical structure remains an approximation.':'Clouds follow latitude circulation, coasts, terrain and sunlight. Fog, cumulus and cirrus share the same weather on both renderers. Sky rotation changes light and stars while world coordinates remain stable.','muted'));
  const benchmark=element('button','Measure 40 s round trip', 'primary'),exportButton=element('button','Export report');benchmark.disabled=true;exportButton.disabled=true;const benchmarkButtons=element('div',undefined,'buttons');benchmarkButtons.append(benchmark,exportButton);sidebar.append(benchmarkButtons);
  sidebar.append(element('h2','Streaming and precision'));const counters=element('pre');counters.setAttribute('aria-label','Planet streaming counters');sidebar.append(counters);
  sidebar.append(element('h2','Sky rendering'));const skyCounters=element('pre','Preparing reusable density volumes…');skyCounters.setAttribute('aria-label','Planet sky counters');sidebar.append(skyCounters);
  sidebar.append(element('h2','Weather at camera latitude / longitude'));const weatherCounters=element('pre');weatherCounters.setAttribute('aria-label','Planet weather probe');sidebar.append(weatherCounters);
  sidebar.append(element('h2','Biomes, population and ocean'));const worldCounters=element('pre','Preparing engine material and foliage recipes…');worldCounters.setAttribute('aria-label','Planet world counters');sidebar.append(worldCounters);
  sidebar.append(element('h2','Recent frame intervals'));const frames=element('pre');frames.setAttribute('aria-label','Planet live frame timings');sidebar.append(frames,element('p','RAF intervals and CPU submission are measured here. These are not physical display FPS or GPU completion timings.','muted'));
  sidebar.append(element('h2','Retained round trip'));const report=element('pre','No measured trip yet.');report.setAttribute('aria-label','Planet benchmark report');sidebar.append(report,element('p','Visual terrain, foliage, buildings and radial engine water. This lab does not implement spherical multiplayer physics or planet-wide fluid simulation.','muted'));
  const status=element('footer','Preparing six globe roots asynchronously. Flight remains active while detail is requested.');status.setAttribute('aria-live','polite');root.append(status);parent.append(root);

  const renderer=nativeGPU?new WebGPURenderer({canvas,antialias:true,powerPreference:'high-performance',logarithmicDepthBuffer:true,forceWebGL:false}):new THREE.WebGLRenderer({canvas,antialias:true,powerPreference:'high-performance',logarithmicDepthBuffer:true});
  if(renderer instanceof WebGPURenderer){await renderer.init();if(!(renderer.backend as unknown as {isWebGPUBackend?:boolean}).isWebGPUBackend){renderer.dispose();throw Error('Native WebGPU is unavailable; choose WebGL explicitly.');}}
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.25));renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.setClearColor('#000000');
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(60,1,.1,EARTH_RADIUS*8);const ambient=new THREE.HemisphereLight('#b9dcf1','#183147',1.5);scene.add(ambient);const sun=new THREE.DirectionalLight('#fff0d8',2.4);scene.add(sun);
  let planet:CompiledPlanet,view:PlanetView;
  let biomes:CompiledPlanetBiomes,water:PlanetWaterView,population:PlanetPopulationView|undefined,library:PreparedPlanetPopulation|undefined;
  let surfaceMaterials:ReturnType<typeof createGeneratedMaterialFromPixels>[]=[],worldAbort=new AbortController(),worldVersion=0,worldPreparing=true,worldReady:Promise<void>=Promise.resolve(),worldError='',landing:PlanetVector=[-1,0,0],biomeSearch:Worker|undefined;
  const terrainMaterials:THREE.Material[]=Array.from({length:9},()=>new THREE.MeshStandardMaterial({vertexColors:true,roughness:1}));
  const gpuDevice=(renderer as unknown as {backend?:{device?:GPUDevice}}).backend?.device,gpuCompletions:number[]=[],gpuErrors:string[]=[];let gpuPending=false;
  gpuDevice?.addEventListener('uncapturederror',event=>{const error=String(event.error.message).slice(0,500);if(gpuErrors.length<32&&!gpuErrors.includes(error))gpuErrors.push(error);});
  let disposed=false,raf=0,previousNow=0,routeSeconds=0,lastUi=0,lastUpdateCpu=0,lastRenderCpu=0,lastCallbackCpu=0,mode:FlightMode='auto',wheelOffset=0,yaw=0,pitch=0;
  const contextLost=()=>{if(!disposed&&!gpuErrors.includes('WebGL context lost'))gpuErrors.push('WebGL context lost');};
  canvas.addEventListener('webglcontextlost',contextLost);
  void gpuDevice?.lost.then(info=>{if(!disposed)gpuErrors.push('WebGPU device lost: '+info.reason+' '+info.message);});
  let benchmarkState:{seconds:number;samples:FlightSample[];startedAt:string;initialStreaming:unknown;initialSky:unknown;skyRecipe:ResolvedPlanetSkyRecipe;sunElevationDegrees:number}|undefined;
  let retained:unknown;
  let sky:PlanetSkyView|PlanetSkyWebGPUView|undefined,skyRecipe:ResolvedPlanetSkyRecipe,skyAbort:AbortController|undefined,skyBakeKey='',pendingBakeKey='',skyPreparing=false,skyError='',skyVersion=0,skySeconds=0;
  let skyReference:CompiledPlanetSky|undefined;
  let generatedPlanet:CompiledPlanetGenerator|undefined,atmosphereSession:PlanetAtmosphereSession|undefined,atmosphereAbort:AbortController|undefined,pendingAtmosphereAbort:AbortController|undefined,atmosphereEpoch=0,activeAtmosphereEpoch=0;
  let previousAtmosphere:PlanetAtmosphereUpdate|undefined,currentAtmosphere:PlanetAtmosphereUpdate|undefined,desiredSimulationSeconds=0,simulationError='',lastAtmosphereRequest=0;
  let lastTriangles=0,lastDrawCalls=0;
  let firstSkyRenderCpuMs:number|null=null;
  let simulationSeconds=0,renderSimulationSeconds=0,starRotationRadians=0;
  const recent:number[]=[];
  const direction=new THREE.Vector3(),tangent=new THREE.Vector3(),north=new THREE.Vector3(),absolute=new THREE.Vector3(),target=new THREE.Vector3(),nearTarget=new THREE.Vector3(),up=new THREE.Vector3(),forward=new THREE.Vector3(),right=new THREE.Vector3(),sunDirection=new THREE.Vector3();
  // Absolute positions stay in JavaScript doubles; only the rebased scene uses
  // GPU floats. This is a visual inspection camera, not a physics controller.
  const freePosition=new THREE.Vector3(),freeForward=new THREE.Vector3(0,0,-1),freeUp=new THREE.Vector3(0,1,0),freeMove=new THREE.Vector3(),freeRadial=new THREE.Vector3(),freePreviousRadial=new THREE.Vector3(),freeTransport=new THREE.Quaternion(),flightKeys=new Set<string>();
  let freeRadius=0,freeSpeedScale=1;
  let altitudeMeters=EARTH_RADIUS*1.4,lastSurface=0,lastDisplaySurface:number|undefined,lastClearanceAdjustment=0,lastDirection:PlanetVector=[0,1,0];
  function refreshSkyLabels(){
    for(const [input,{label,name,format}] of ranges){(label.firstElementChild as HTMLSpanElement).textContent=name+': '+format(Number(input.value));}
    pixelSize.disabled=!!benchmarkState||skyStyle.value!=='pixel';paletteSteps.disabled=pixelSize.disabled;
    orbitalViewButtons.forEach(button=>{button.disabled=!!benchmarkState||sunMotion.value!=='rotation';});
    sunElevation.disabled=!!benchmarkState||sunMotion.value==='rotation';dayDuration.disabled=!!benchmarkState||sunMotion.value!=='rotation';timeOfDay.disabled=!!benchmarkState||sunMotion.value!=='rotation';
  }
  function refreshClockLabel(){timeOfDay.value=String(((simulationSeconds/3600+12)%24+24)%24);const info=ranges.get(timeOfDay)!;(info.label.firstElementChild as HTMLSpanElement).textContent=info.name+': '+info.format(Number(timeOfDay.value));}
  function readSkyControls():ResolvedPlanetSkyRecipe {
    const radius=planet.radius,scale=radius/EARTH_RADIUS;
    if(simulationMode&&generatedPlanet)return compilePlanetSky({...generatedPlanet.sky,style:skyStyle.value as 'realistic'|'pixel',quality:skyQuality.value as 'low'|'balanced'|'high',pixelSize:Number(pixelSize.value),paletteSteps:Number(paletteSteps.value),celestial:{...generatedPlanet.sky.celestial,starsEnabled:starsToggle.input.checked}},radius).recipe;
    const base=skyRecipe?.seed===Number(seed.value)?skyRecipe:compilePlanetSky(createPlanetSkyRecipe(Number(seed.value),radius),radius).recipe;
    const cumulusTop=(Number(cloudBase.value)+Number(cloudThickness.value))*1000*scale,cirrusBase=Math.max(8500*scale,cumulusTop+400*scale);
    return compilePlanetSky({...base,surface:planet.recipe,seed:Number(seed.value),style:skyStyle.value as 'realistic'|'pixel',quality:skyQuality.value as 'low'|'balanced'|'high',pixelSize:Number(pixelSize.value),paletteSteps:Number(paletteSteps.value),
      celestial:{...base.celestial,axialTiltDegrees:Number(axialTilt.value),seasonTurns:Number(season.value),starsEnabled:starsToggle.input.checked},
      atmosphere:{...base.atmosphere,enabled:atmosphereToggle.input.checked,heightMeters:Number(atmosphereHeight.value)*1000*scale,mieStrength:Number(haze.value)},
      clouds:{...base.clouds,enabled:cloudToggle.input.checked,bottomMeters:Number(cloudBase.value)*1000*scale,thicknessMeters:Number(cloudThickness.value)*1000*scale,coverage:.67,density:Number(cloudDensity.value),windMetersPerSecond:[Number(windSpeed.value)*scale,0,Number(windSpeed.value)*scale*.2],shadowStrength:Number(cloudShadows.value),godRayStrength:Number(godRays.value),circulation:{...base.clouds.circulation,coverageTarget:Number(coverage.value),moisture:Number(moisture.value),pressureStrength:Number(pressureStrength.value),itczLatitudeDegrees:Math.sin(Number(season.value)*2*Math.PI)*7},layers:{fog:{...base.clouds.layers.fog,density:Number(fogDensity.value)},cumulus:{...base.clouds.layers.cumulus,bottomMeters:Number(cloudBase.value)*1000*scale,thicknessMeters:Number(cloudThickness.value)*1000*scale},cirrus:{...base.clouds.layers.cirrus,bottomMeters:cirrusBase,density:Number(cirrusDensity.value)}}}},radius).recipe;
  }
  function applySkyControls(){
    if(disposed||benchmarkState)return;
    refreshSkyLabels();
    try{
      const recipe=readSkyControls(),compiled=compilePlanetSky(recipe,planet.radius);skyRecipe=recipe;skyReference=compiled;
      if(sky&&skyBakeKey===compiled.bakeKey){sky.setRecipe(recipe);sky.setDiagnostic(skyDiagnostic.value as PlanetSkyDiagnostic);skyError='';return;}
      if(skyPreparing&&pendingBakeKey===compiled.bakeKey)return;
      void replaceSky(recipe,compiled.bakeKey);
    }catch(error){skyError=error instanceof Error?error.message:String(error);status.textContent='Sky recipe rejected: '+skyError;}
  }
  async function replaceSky(recipe:ResolvedPlanetSkyRecipe,bakeKey:string){
    skyAbort?.abort();const abort=new AbortController(),version=++skyVersion,radius=planet.radius;skyAbort=abort;skyPreparing=true;pendingBakeKey=bakeKey;skyError='';benchmark.disabled=true;
    try{
      const bake=await preparePlanetSky(recipe,radius,abort.signal);
      if(disposed||abort.signal.aborted||version!==skyVersion)return;
      const replacement=nativeGPU?new PlanetSkyWebGPUView(bake):new PlanetSkyView(bake);
      if(simulationMode){replacement.enableSimulation();if(currentAtmosphere)replacement.setWeatherSnapshots(previousAtmosphere?.snapshot??currentAtmosphere.snapshot,currentAtmosphere.snapshot);}
      const discard=()=>replacement.dispose();abort.signal.addEventListener('abort',discard,{once:true});
      try{
        replacement.setRecipe(skyRecipe);replacement.setDiagnostic(skyDiagnostic.value as PlanetSkyDiagnostic);
        if(replacement instanceof PlanetSkyView){
          // Generated surface materials replace the placeholders asynchronously.
          // Warm their HDR capture variants before the first completed sky pass.
          await worldReady;
          if(worldError)throw Error('Scene materials are unavailable: '+worldError);
          if(disposed||abort.signal.aborted||version!==skyVersion){replacement.dispose();return;}
          await replacement.prepare(renderer as THREE.WebGLRenderer,scene,camera);
        }
        if(disposed||abort.signal.aborted||version!==skyVersion){replacement.dispose();return;}
        // Uniform controls may change while the driver compiles. Publish the
        // latest valid recipe only after this candidate is ready to draw.
        replacement.setRecipe(skyRecipe);replacement.setDiagnostic(skyDiagnostic.value as PlanetSkyDiagnostic);
      }catch(error){replacement.dispose();throw error;}finally{abort.signal.removeEventListener('abort',discard);}
      const previous=sky;sky=replacement;skyBakeKey=bake.bakeKey;previous?.dispose();
      skyPreparing=false;pendingBakeKey='';skyAbort=undefined;
    }catch(error){
      if(disposed||abort.signal.aborted||version!==skyVersion)return;
      skyPreparing=false;pendingBakeKey='';skyAbort=undefined;skyError=error instanceof Error?error.message:String(error);
      status.textContent='Sky preparation failed; terrain remains available. '+skyError;
    }
  }
  function replacePlanet(radius:number,generated?:CompiledPlanetGenerator){
    const radiusChanged=!planet||planet.radius!==radius;
    if(view){scene.remove(view.root);view.dispose();}
    worldAbort.abort();worldAbort=new AbortController();const signal=worldAbort.signal,version=++worldVersion;biomeSearch?.terminate();biomeSearch=undefined;population?.dispose();population=undefined;library?.dispose();library=undefined;water?.dispose();worldPreparing=true;worldError='';
    const recipe=generated?.planet??createPlanetRecipe(412,radius),biomeRecipe=createPlanetBiomeRecipe(recipe.seed,radius),barren=!!generated&&(generated.physics.equilibriumTemperatureKelvin<260||generated.recipe.waterCoverage===0);if(barren){biomeRecipe.forestDensity=0;biomeRecipe.settlementDensity=0;}
    planet=compilePlanet(recipe);biomes=compilePlanetBiomes(planet,biomeRecipe);
    view=new PlanetView(planet,createPlanetPreparationSource(recipe,barren?undefined:biomeRecipe),{material:terrainMaterials,maxResidentPatches:512,maxSelectedPatches:192,maxInFlight:2,maxUploadsPerFrame:2,targetCellPixels:Number(detail.value),maxResidentBytes:96*1024*1024});scene.add(view.root);
    water=new PlanetWaterView(planet);scene.add(water.root);
    if(generated?.recipe.waterCoverage===0)water.root.visible=false;
    worldReady=Promise.all([preparePlanetSurface(412,128,signal),preparePlanetPopulation(412,{resolution:64,signal})]).then(([materials,bake])=>{
      if(disposed||signal.aborted||version!==worldVersion)return;
      const replacement=materials.map(pixels=>{const generated=createGeneratedMaterialFromPixels(pixels,{uvSpace:'metres',anisotropy:4});generated.material.vertexColors=true;return generated;});
      for(const material of terrainMaterials)material.dispose();surfaceMaterials.forEach(material=>material.dispose());surfaceMaterials=replacement;terrainMaterials.splice(0,terrainMaterials.length,...replacement.map(generated=>generated.material));
      library=createPreparedPlanetPopulation(bake);population=new PlanetPopulationView({planet,biomes},library,createPlanetPopulationPreparationSource(recipe,biomeRecipe));scene.add(population.root);worldPreparing=false;
    }).catch(error=>{if(signal.aborted||version!==worldVersion)return;worldPreparing=false;worldError=error instanceof Error?error.message:String(error);});
    if(barren){landing=[0,0,1];districtControl.hidden=true;}else{districtControl.hidden=false;findDistrict();}
    camera.far=radius*8;camera.updateProjectionMatrix();routeSeconds=0;wheelOffset=0;recent.length=0;previousNow=0;benchmark.disabled=true;
    scaleLabel.textContent='Radius '+(radius/1000).toLocaleString()+' km · local Float32 meshes';
    if(radiusChanged||generated){skyAbort?.abort();skyVersion++;sky?.dispose();sky=undefined;skyBakeKey='';pendingBakeKey='';skyPreparing=false;skyRecipe=generated?.sky??compilePlanetSky(createPlanetSkyRecipe(Number(seed.value),radius),radius).recipe;applySkyControls();}
    refreshSkyLabels();
  }
  async function generatePhysicalPlanet(recipe:PlanetGeneratorRecipe){
    pendingAtmosphereAbort?.abort();const abort=new AbortController(),epoch=++atmosphereEpoch;pendingAtmosphereAbort=abort;
    const session=await createPlanetAtmosphereSession(recipe,{epoch,signal:abort.signal,resolution:16,onUpdate(update){
      if(epoch!==activeAtmosphereEpoch||disposed)return;
      previousAtmosphere=currentAtmosphere??update;currentAtmosphere=update;
      try{if(clockRunning.input.checked||benchmarkState)sky?.setWeatherSnapshots(previousAtmosphere.snapshot,update.snapshot);}catch(error){simulationError=String(error);}
    },onError(error){if(epoch===activeAtmosphereEpoch)simulationError=error.message;}});
    if(disposed||abort.signal.aborted||epoch!==atmosphereEpoch){session.dispose();return;}
    activeAtmosphereEpoch=epoch;atmosphereAbort?.abort();atmosphereSession?.dispose();atmosphereAbort=abort;pendingAtmosphereAbort=undefined;simulationError='';weatherSummary.textContent='';atmosphereSession=session;generatedPlanet=session.generator;currentAtmosphere=session.initial;previousAtmosphere=session.initial;desiredSimulationSeconds=simulationSeconds=renderSimulationSeconds=session.initial.snapshot.timeSeconds;
    const option=element('option',String(recipe.radiusMeters));option.value=String(recipe.radiusMeters);radiusSelect.append(option);radiusSelect.value=option.value;
    replacePlanet(recipe.radiusMeters,generatedPlanet);
  }
  function findDistrict(){
    worldError='';
    biomeSearch?.terminate();const search=new Worker(new URL('../src/client/game/planetBiomeSearchWorker.ts',import.meta.url),{type:'module'});biomeSearch=search;
    search.onmessage=(event:MessageEvent<{direction?:PlanetVector;error?:string}>)=>{if(disposed||biomeSearch!==search)return;if(event.data.direction){landing=event.data.direction;routeSeconds=0;if(mode==='free')relocateFreeFlight();}else worldError=event.data.error??'Biome search failed.';search.terminate();biomeSearch=undefined;};search.onerror=event=>{worldError=event.message;search.terminate();if(biomeSearch===search)biomeSearch=undefined;};
    search.postMessage({planet:planet.recipe,biomes:biomes.recipe,id:districtSelect.value});
  }
  if(simulationMode){await generatePhysicalPlanet(generatorControls!.read());generatorControls!.setBusy(false,'Planet ready. Let the atmosphere evolve, or simulate another day.');}else replacePlanet(EARTH_RADIUS);
  districtSelect.onchange=()=>{if(!benchmarkState)findDistrict();};
  for(const control of skyControls){if(control===exportSky)continue;if(control instanceof HTMLInputElement&&control.type==='range')control.oninput=applySkyControls;else control.onchange=applySkyControls;}
  if(simulationMode){clockRunning.input.onchange=()=>{if(clockRunning.input.checked&&currentAtmosphere)sky?.setWeatherSnapshots(previousAtmosphere?.snapshot??currentAtmosphere.snapshot,currentAtmosphere.snapshot);};dayDuration.oninput=refreshSkyLabels;}
  timeOfDay.oninput=()=>{if(benchmarkState)return;simulationSeconds=(Number(timeOfDay.value)-12)*3600;clockRunning.input.checked=false;refreshClockLabel();};
  exportSky.onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(simulationMode?generatedPlanet!.recipe:{recipe:skyRecipe,sunElevationDegrees:Number(sunElevation.value)},null,2)],{type:'application/json'})),anchor=element('a');anchor.href=url;anchor.download=simulationMode?'planet-generator-recipe.json':'planet-sky-recipe.json';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  advanceDay.onclick=()=>{if(!generatedPlanet||benchmarkState)return;desiredSimulationSeconds+=generatedPlanet.recipe.rotationPeriodSeconds;atmosphereSession?.advanceTo(desiredSimulationSeconds,lastDirection);clockRunning.input.checked=true;};
  function flightSpeed(){return clamp((autoSpeed.checked?Math.max(10,altitudeMeters*.35):clamp(Number(manualSpeed.value)||50,1,5_000_000))*freeSpeedScale,1,5_000_000);}
  function refreshFlightControls(){autoSpeed.disabled=!!benchmarkState||mode!=='free';manualSpeed.disabled=autoSpeed.disabled||autoSpeed.checked;speedReadout.textContent=mode==='free'?'Flight speed '+altitudeLabel(flightSpeed())+'/s · wheel multiplier '+freeSpeedScale.toFixed(2)+'× · Shift boosts 4×':'Free flight keeps your current position and viewing direction.';flightHint.textContent=mode==='free'?'Click view · WASD fly · Q/E down/up · drag to look · Shift boost · wheel changes speed':'Drag to look around · wheel adjusts altitude · coarse ground stays visible while detail arrives';}
  function relocateFreeFlight(){freePreviousRadial.copy(freePosition).normalize();freeRadial.set(...landing);if(freePreviousRadial.lengthSq()>.5){freeTransport.setFromUnitVectors(freePreviousRadial,freeRadial);freeForward.applyQuaternion(freeTransport);freeUp.applyQuaternion(freeTransport);}const ground=Math.max(planet.sample(landing).heightMeters,planet.recipe.seaLevelMeters),clearance=clamp(altitudeMeters*(freeRadius&&freeRadius!==planet.radius?planet.radius/freeRadius:1),1.7,planet.radius*4);freePosition.copy(freeRadial).multiplyScalar(planet.radius+ground+clearance);freeRadius=planet.radius;}
  function setMode(value:FlightMode){if(value==='free'&&mode!=='free'){freePosition.copy(absolute);camera.getWorldDirection(freeForward);freeUp.set(0,1,0).applyQuaternion(camera.quaternion).normalize();freeRadius=planet.radius;if(freePosition.length()<planet.radius)relocateFreeFlight();trackSun.input.checked=false;yaw=pitch=0;canvas.focus({preventScroll:true});}mode=value;flightKeys.clear();modeButtons.forEach((button,key)=>button.setAttribute('aria-pressed',String(key===value)));if(value==='auto'||value==='descend')routeSeconds=value==='descend'?6:0;wheelOffset=0;refreshFlightControls();}
  function inspectOrbitalLighting(kind:'sunlit'|'twilight'){
    if(benchmarkState||!sky||skyPreparing||sunMotion.value!=='rotation')return;
    clockRunning.input.checked=false;
    const light=new THREE.Vector3(...(generatedPlanet?samplePlanetAtmosphereCelestial(generatedPlanet.physics,renderSimulationSeconds):samplePlanetCelestial(skyRecipe.celestial,renderSimulationSeconds)).sunDirection).normalize();
    const axis=new THREE.Vector3(0,Math.abs(light.y)<.95?1:0,Math.abs(light.y)<.95?0:1),side=new THREE.Vector3().crossVectors(axis,light).normalize();
    const height=kind==='sunlit'?planet.radius*.18:Math.max(50,Math.min(planet.radius*.018,skyRecipe.atmosphere.heightMeters*1.5));
    // Inspect existing cloud edges; only move the observer. A fixed equatorial
    // viewpoint otherwise repeatedly targets the featureless centre of a deck.
    const across=new THREE.Vector3().crossVectors(light,side).normalize(),mu=kind==='sunlit'?.55:.06;
    let target=light.clone().multiplyScalar(mu).addScaledVector(side,Math.sqrt(1-mu*mu)),best=-Infinity;
    const opacity=(direction:THREE.Vector3)=>{const column=sky!.sampleWeather(tuple(direction),renderSimulationSeconds);if(!column)return 0;const tau=planetAtmosphereColumnOpticalDepth(column);return 1-Math.exp(-Math.min(40,tau.lowerCloud+tau.upperCloud));};
    for(let i=0;i<48;i++){
      const angle=i*Math.PI*2/48,candidate=light.clone().multiplyScalar(mu).addScaledVector(side,Math.sqrt(1-mu*mu)*Math.cos(angle)).addScaledVector(across,Math.sqrt(1-mu*mu)*Math.sin(angle)).normalize();
      const tangent=light.clone().addScaledVector(candidate,-mu).normalize(),center=opacity(candidate),ahead=opacity(candidate.clone().addScaledVector(tangent,.04).normalize()),behind=opacity(candidate.clone().addScaledVector(tangent,-.04).normalize());
      const score=Math.abs(ahead-behind)+4*center*(1-center);
      if(score>best){best=score;target=candidate;}
    }
    let radial=target.clone(),lookAt:THREE.Vector3|undefined;
    if(kind==='twilight'){
      const column=sky.sampleWeather(tuple(target),renderSimulationSeconds),top=column?Math.max(column.lowerProfileTopMetersAsl,column.upperProfileTopMetersAsl):skyRecipe.clouds.bottomMeters+skyRecipe.clouds.thicknessMeters;
      const targetHeight=Math.min(top,height*.8),dip=.92*Math.acos(clamp((planet.radius+targetHeight)/(planet.radius+height),0,1)),towardSun=light.clone().addScaledVector(target,-light.dot(target)).normalize();
      radial=target.clone().multiplyScalar(Math.cos(dip)).addScaledVector(towardSun,-Math.sin(dip)).normalize();
      lookAt=target.multiplyScalar(planet.radius+targetHeight);
    }
    setMode('free');trackSun.input.checked=false;yaw=pitch=0;freeRadius=planet.radius;freePosition.copy(radial).multiplyScalar(planet.radius+height);
    if(lookAt)freeForward.copy(lookAt).sub(freePosition).normalize();else freeForward.copy(radial).negate();
    freeUp.copy(kind==='sunlit'?axis:radial).addScaledVector(freeForward,-(kind==='sunlit'?axis:radial).dot(freeForward)).normalize();
    skyDiagnostic.value='composite';sky.setDiagnostic('composite');freeSpeedScale=1;refreshFlightControls();
  }
  orbitalViewButtons.forEach((button,kind)=>button.onclick=()=>inspectOrbitalLighting(kind));
  autoSpeed.onchange=refreshFlightControls;manualSpeed.onchange=()=>{manualSpeed.value=String(clamp(Number(manualSpeed.value)||50,1,5_000_000));refreshFlightControls();};refreshFlightControls();
  modeButtons.forEach((button,key)=>button.onclick=()=>{if(benchmarkState)return;setMode(key);});
  radiusSelect.onchange=()=>{if(!benchmarkState)replacePlanet(Number(radiusSelect.value));};
  detail.oninput=()=>{detailLabel.firstChild!.textContent='Target cell footprint: '+detail.value+' px';};
  detail.onchange=()=>{if(!benchmarkState)replacePlanet(Number(radiusSelect.value),generatedPlanet);};
  let drag:{x:number;y:number}|undefined;
  const pointerDown=(event:PointerEvent)=>{if(benchmarkState||event.button!==0)return;canvas.focus({preventScroll:true});drag={x:event.clientX,y:event.clientY};canvas.setPointerCapture(event.pointerId);};
  const pointerMove=(event:PointerEvent)=>{if(!drag)return;const dx=(event.clientX-drag.x)*.003,dy=(event.clientY-drag.y)*.003;if(mode==='free'){trackSun.input.checked=false;freeForward.applyAxisAngle(freeUp,-dx).normalize();right.crossVectors(freeForward,freeUp).normalize();freeForward.applyAxisAngle(right,-dy).normalize();freeUp.applyAxisAngle(right,-dy).normalize();}else{yaw+=dx;pitch=clamp(pitch+dy,-.8,.8);}drag={x:event.clientX,y:event.clientY};};
  const pointerUp=()=>{drag=undefined;};
  const wheel=(event:WheelEvent)=>{event.preventDefault();if(benchmarkState)return;if(mode==='free'){freeSpeedScale=clamp(freeSpeedScale*Math.exp(-event.deltaY*.001),.125,128);refreshFlightControls();}else wheelOffset=clamp(wheelOffset+event.deltaY*.002,-4,4);};
  const flightKeyCodes=new Set(['KeyW','KeyA','KeyS','KeyD','KeyQ','KeyE','ShiftLeft','ShiftRight']);
  const keyDown=(event:KeyboardEvent)=>{if(mode!=='free'||benchmarkState||event.target!==canvas||event.altKey||event.ctrlKey||event.metaKey||!flightKeyCodes.has(event.code))return;event.preventDefault();flightKeys.add(event.code);};
  const keyUp=(event:KeyboardEvent)=>{flightKeys.delete(event.code);};
  const clearFlightInput=()=>{flightKeys.clear();drag=undefined;};
  canvas.addEventListener('pointerdown',pointerDown);canvas.addEventListener('pointermove',pointerMove);canvas.addEventListener('pointerup',pointerUp);canvas.addEventListener('pointercancel',pointerUp);canvas.addEventListener('wheel',wheel,{passive:false});
  canvas.addEventListener('keydown',keyDown);canvas.addEventListener('blur',clearFlightInput);window.addEventListener('keyup',keyUp);window.addEventListener('blur',clearFlightInput);
  const resize=new ResizeObserver(()=>{const width=viewport.clientWidth,height=viewport.clientHeight;renderer.setSize(width,height,false);camera.aspect=width/Math.max(1,height);camera.updateProjectionMatrix();});resize.observe(viewport);
  const visibilityChanged=()=>{previousNow=0;if(document.visibilityState==='hidden'){clearFlightInput();if(benchmarkState)status.textContent='Measurement paused while this tab is hidden.';}};document.addEventListener('visibilitychange',visibilityChanged);

  function updateFreeCamera(deltaSeconds:number){
    if(freeRadius!==planet.radius)relocateFreeFlight();
    freePreviousRadial.copy(freePosition).normalize();right.crossVectors(freeForward,freeUp).normalize();
    freeMove.set(0,0,0).addScaledVector(freeForward,Number(flightKeys.has('KeyW'))-Number(flightKeys.has('KeyS'))).addScaledVector(right,Number(flightKeys.has('KeyD'))-Number(flightKeys.has('KeyA'))).addScaledVector(freePreviousRadial,Number(flightKeys.has('KeyE'))-Number(flightKeys.has('KeyQ')));
    if(freeMove.lengthSq()>1)freeMove.normalize();
    // A resumed or stalled frame never teleports the inspection camera. Terrain
    // checks are bounded even at orbital speeds, with an analytic sea shell
    // intersection preventing a large step from tunnelling through the globe.
    freeMove.multiplyScalar(flightSpeed()*clamp(deltaSeconds,0,.05)*(flightKeys.has('ShiftLeft')||flightKeys.has('ShiftRight')?4:1));
    const distance=freeMove.length(),steps=Math.min(8,Math.max(1,Math.ceil(distance/Math.max(100,altitudeMeters*.25))));freeMove.multiplyScalar(1/steps);
    for(let step=0;step<steps;step++){
      const shell=planet.radius+planet.recipe.seaLevelMeters+1.7,a=freeMove.lengthSq(),b=2*freePosition.dot(freeMove),c=freePosition.lengthSq()-shell*shell,discriminant=b*b-4*a*c;
      let portion=1;if(a>0&&c>=0&&b<0&&discriminant>=0){const intersection=(-b-Math.sqrt(discriminant))/(2*a);if(intersection>=0&&intersection<=1)portion=Math.max(0,intersection-1e-8);}
      freePosition.addScaledVector(freeMove,portion);freeRadial.copy(freePosition).normalize();
      const ground=Math.max(planet.sample(tuple(freeRadial)).heightMeters,planet.recipe.seaLevelMeters,view.displayedSurface(tuple(freeRadial))?.heightMeters??-Infinity);
      freePosition.multiplyScalar(Math.max(freePosition.length(),planet.radius+ground+1.7)/freePosition.length());
    }
    if(freePosition.length()>planet.radius*6)freePosition.setLength(planet.radius*6);
    freeRadial.copy(freePosition).normalize();freeTransport.setFromUnitVectors(freePreviousRadial,freeRadial);freeForward.applyQuaternion(freeTransport).normalize();freeUp.applyQuaternion(freeTransport).normalize();
    direction.copy(freeRadial);lastDirection=tuple(direction);lastSurface=Math.max(planet.sample(lastDirection).heightMeters,planet.recipe.seaLevelMeters);lastDisplaySurface=view.displayedSurface(lastDirection)?.heightMeters;lastClearanceAdjustment=Math.max(0,(lastDisplaySurface??lastSurface)-lastSurface);
    absolute.copy(freePosition);view.update({position:tuple(absolute),origin:tuple(absolute),viewportHeight:canvas.height,fovDegrees:camera.fov});
    const published=view.displayedSurface(lastDirection);if(published){lastDisplaySurface=published.heightMeters;lastClearanceAdjustment=Math.max(0,published.heightMeters-lastSurface);const floor=planet.radius+lastSurface+lastClearanceAdjustment+1.7;if(absolute.length()<floor){absolute.copy(direction).multiplyScalar(floor);freePosition.copy(absolute);view.rebase(tuple(absolute));}}
    altitudeMeters=Math.max(1.7,absolute.length()-planet.radius-lastSurface-lastClearanceAdjustment);target.copy(freeForward);up.copy(freeUp);
  }
  function flight(seconds:number,forced:boolean,deltaSeconds:number){
    let phase:string;
    if(!forced&&mode==='free'){updateFreeCamera(deltaSeconds);phase='Free flight';}
    else{
    const t=forced?Math.min(seconds,ROUND_TRIP_SECONDS):seconds%ROUND_TRIP_SECONDS;
    const surfaceAltitude=75,orbitalAltitude=planet.radius*1.4;
    let requested:number,cloudTargetAsl:number|undefined;
    if(!forced&&mode==='orbit'){requested=orbitalAltitude;phase='Orbit';}
    else if(!forced&&mode==='ground'){requested=2;phase='Ground sky';}
    else if(!forced&&mode==='clouds'){requested=simulationMode?1000:Math.max(2,(skyRecipe.clouds.layers.cumulus.bottomMeters+skyRecipe.clouds.layers.cumulus.thicknessMeters*.38)-lastSurface);phase='Inside cloud layer';}
    else if(!forced&&mode==='cirrus'){requested=simulationMode?1000:Math.max(2,skyRecipe.clouds.layers.cirrus.bottomMeters+skyRecipe.clouds.layers.cirrus.thicknessMeters+1000*planet.radius/EARTH_RADIUS-lastSurface);phase='Above cloud layers';}
    else if(!forced&&mode==='surface'){requested=surfaceAltitude;phase='Surface flyover';}
    else if(t<6){requested=orbitalAltitude;phase='Orbit';}
    else if(t<18){requested=Math.exp(lerp(Math.log(orbitalAltitude),Math.log(surfaceAltitude),smooth((t-6)/12)));phase='Descending';}
    else if(t<28){requested=surfaceAltitude;phase='Surface flyover';}
    else{requested=Math.exp(lerp(Math.log(surfaceAltitude),Math.log(orbitalAltitude),smooth((t-28)/12)));phase='Ascending';}
    altitudeMeters=Math.max(mode==='ground'?1.7:5,requested*Math.exp(wheelOffset));
    // Stay near the same landing district during descent. Surface movement is
    // measured in metres, rather than racing degrees of latitude each frame.
    const orbitBlend=smooth((altitudeMeters-skyRecipe.atmosphere.heightMeters*2)/(planet.radius*.15)),bodyRotation=2*Math.PI*(renderSimulationSeconds/skyRecipe.celestial.dayLengthSeconds-skyRecipe.celestial.phaseTurns);
    const metres=seconds*35,surfaceLongitude=Math.atan2(landing[0],landing[2])+metres/planet.radius,orbitalLongitude=-bodyRotation+Math.PI/5;
    const longitude=simulationMode?surfaceLongitude+Math.atan2(Math.sin(orbitalLongitude-surfaceLongitude),Math.cos(orbitalLongitude-surfaceLongitude))*orbitBlend:surfaceLongitude-(sunMotion.value==='rotation'?bodyRotation*orbitBlend:0),latitude=Math.asin(landing[1]);
    direction.set(Math.cos(latitude)*Math.sin(longitude),Math.sin(latitude),Math.cos(latitude)*Math.cos(longitude));
    const sampled=planet.sample(tuple(direction));lastSurface=Math.max(sampled.heightMeters,planet.recipe.seaLevelMeters);lastDirection=tuple(direction);
    lastDisplaySurface=view.displayedSurface(tuple(direction))?.heightMeters;lastClearanceAdjustment=Math.max(0,(lastDisplaySurface??lastSurface)-lastSurface);
    if(simulationMode&&!forced&&(mode==='clouds'||mode==='cirrus')){
      const column=sky?.sampleWeather(lastDirection,renderSimulationSeconds),lower=column&&(column.liquidLowerKgM2+column.iceLowerKgM2)>0,upper=column&&(column.liquidUpperKgM2+column.iceUpperKgM2)>0;
      if(column&&(lower||upper)){
        const optical=planetAtmosphereColumnOpticalDepth(column),targetLower=optical.lowerCloud>=optical.upperCloud,base=targetLower?column.lowerBaseMetersAsl:column.upperBaseMetersAsl,top=targetLower?column.lowerProfileTopMetersAsl:column.upperProfileTopMetersAsl;
        if(mode==='clouds')phase=targetLower?'Inside lower cloud layer':'Inside upper cloud layer';
        const height=mode==='clouds'?base+(top-base)*.5:Math.max(lower?column.lowerProfileTopMetersAsl:0,upper?column.upperProfileTopMetersAsl:0)+generatedPlanet!.physics.scaleHeightMeters*.1;
        altitudeMeters=Math.max(5,(height-lastSurface-lastClearanceAdjustment)*Math.exp(wheelOffset));cloudTargetAsl=lastSurface+lastClearanceAdjustment+altitudeMeters;
      }else phase='Clear column · no formed cloud here';
    }
    absolute.copy(direction).multiplyScalar(planet.radius+lastSurface+lastClearanceAdjustment+altitudeMeters);
    view.update({position:tuple(absolute),origin:tuple(absolute),viewportHeight:canvas.height,fovDegrees:camera.fov});
    const published=view.displayedSurface(tuple(direction));
    if(published){lastDisplaySurface=published.heightMeters;const clearance=Math.max(0,published.heightMeters-lastSurface);if(clearance>lastClearanceAdjustment){lastClearanceAdjustment=clearance;if(cloudTargetAsl!==undefined){altitudeMeters=Math.max(5,cloudTargetAsl-lastSurface-clearance);if(cloudTargetAsl<lastSurface+clearance+5)phase='Cloud target behind terrain · waiting for surface detail';}absolute.copy(direction).multiplyScalar(planet.radius+lastSurface+clearance+altitudeMeters);view.rebase(tuple(absolute));}}
    tangent.set(Math.cos(longitude),0,-Math.sin(longitude));
    const lookAhead=Math.max(200,Math.min(planet.radius*.05,altitudeMeters*7));
    nearTarget.copy(direction).addScaledVector(tangent,lookAhead/planet.radius).normalize();
    const ahead=planet.sample(tuple(nearTarget));nearTarget.multiplyScalar(planet.radius+Math.max(ahead.heightMeters,planet.recipe.seaLevelMeters)+altitudeMeters*.35);
    const aerialInspection=!forced&&['ground','surface','clouds','cirrus'].includes(mode);
    const orbital=aerialInspection?0:smooth((Math.log10(altitudeMeters)-3)/2.6);
    // Blend viewing directions, not absolute planet positions. The latter
    // unintentionally points an atmospheric camera almost straight down.
    target.copy(nearTarget).sub(absolute).normalize().multiplyScalar(1-orbital).addScaledVector(direction,-orbital).normalize();
    north.set(0,1,0).addScaledVector(direction,-direction.y).normalize();up.copy(direction).multiplyScalar(1-orbital).addScaledVector(north,orbital).normalize();
    }
    north.set(0,1,0).addScaledVector(direction,-direction.y);if(north.lengthSq()<1e-10)north.set(0,0,1);north.normalize();
    const celestial=generatedPlanet?samplePlanetAtmosphereCelestial(generatedPlanet.physics,renderSimulationSeconds):samplePlanetCelestial(skyRecipe.celestial,renderSimulationSeconds);starRotationRadians=celestial.rotationRadians;
    if(sunMotion.value==='rotation')sunDirection.set(...celestial.sunDirection);
    else{const elevation=Number(sunElevation.value)*Math.PI/180;sunDirection.copy(direction).multiplyScalar(Math.sin(elevation)).addScaledVector(north,Math.cos(elevation)).normalize();}
    const sunlight=samplePlanetSunlight(tuple(direction),tuple(sunDirection)),outside=smooth((altitudeMeters-skyRecipe.atmosphere.heightMeters)/skyRecipe.atmosphere.heightMeters);sun.position.copy(sunDirection);sun.intensity=skyRecipe.atmosphere.sunIntensity*lerp(sunlight.visibility,1,outside);sun.color.setRGB(...sunlight.color.map(v=>lerp(v,1,outside)) as [number,number,number]);ambient.intensity=lerp(.018+1.25*Math.max(0,Math.sin(sunlight.elevationRadians)),.075,outside);
    // The space-facing camera exposes for a sunlit globe. A continuous exposure
    // change preserves the same scene/atmosphere irradiance through descent.
    renderer.toneMappingExposure=lerp(1,.25,outside);
    const time=benchmarkState?.seconds??skySeconds;water.update({position:tuple(absolute),origin:tuple(absolute),timeSeconds:time,sunDirection:tuple(sunDirection)});population?.update(tuple(absolute),tuple(absolute),time);
    camera.position.set(0,0,0);camera.up.copy(up);camera.lookAt(target);
    if(!forced&&mode!=='free'&&(yaw!==0||pitch!==0)){forward.copy(target).normalize();right.crossVectors(forward,up).normalize();forward.applyAxisAngle(up,yaw).applyAxisAngle(right,pitch);camera.lookAt(forward);}
    if(!forced&&trackSun.input.checked){camera.lookAt(sunDirection);if(mode==='free'){camera.getWorldDirection(freeForward);freeUp.set(0,1,0).applyQuaternion(camera.quaternion).normalize();}}
    return phase;
  }
  function finalizeBenchmark(){
    const run=benchmarkState;if(!run)return;
    const samples=run.samples;
    retained={version:5,renderValid:gpuErrors.length===0&&!skyError&&samples.every(s=>s.drawCalls>0),planetGenerator:generatedPlanet?.recipe,atmosphere:atmosphereSession?.latest().diagnostics,simulationError,dayDurationSeconds:Number(dayDuration.value),sunMotion:sunMotion.value,backend:nativeGPU?'webgpu':'webgl2',world:worldFacts(),gpuQueueCompletionMs:distribution(gpuCompletions),gpuQueueCompletionScope:'Asynchronous queue completion latency, includes scheduling and queued work; not a GPU timestamp or physical FPS.',gpuErrors,startedAt:run.startedAt,route:'40-second deterministic orbit → descent → 75 m surface flyover → ascent',metric:'RAF callback intervals and CPU submission; not physical display FPS or GPU completion',callbackCpuScope:'Includes rendering, frame sampling and live telemetry/UI updates; excludes one-time final report construction.',radiusMeters:planet.radius,recipe:planet.recipe,skyRecipe:run.skyRecipe,sunElevationDegrees:run.sunElevationDegrees,viewport:{width:canvas.width,height:canvas.height,pixelRatio:renderer.getPixelRatio()},samples:samples.length,intervalMs:distribution(samples.map(s=>s.intervalMs)),updateCpuMs:distribution(samples.map(s=>s.updateCpuMs)),renderCpuMs:distribution(samples.map(s=>s.renderCpuMs)),callbackCpuMs:distribution(samples.map(s=>s.callbackCpuMs)),focusedSamples:samples.filter(s=>s.focused).length,triangles:{min:Math.min(...samples.map(s=>s.triangles)),max:Math.max(...samples.map(s=>s.triangles))},initialStreaming:run.initialStreaming,finalStreaming:view.inspection(),initialSky:run.initialSky,finalSky:sky?.inspection(),skyError,longIntervals:samples.filter(s=>s.intervalMs>33).slice(0,100),trace:samples};
    report.textContent=JSON.stringify({...retained as Record<string,unknown>,recipe:undefined,skyRecipe:undefined,trace:undefined},null,2);exportButton.disabled=false;benchmarkState=undefined;advanceDay.disabled=false;generatorControls?.setBusy(false);benchmark.disabled=false;radiusSelect.disabled=false;detail.disabled=false;districtSelect.disabled=false;backendSelect.disabled=false;modeButtons.forEach(button=>button.disabled=false);skyControls.forEach(control=>control.disabled=false);refreshSkyLabels();refreshFlightControls();status.textContent='Round trip measured. Export includes the sky recipe, bounded frame trace and streaming counters.';
  }
  benchmark.onclick=()=>{if(gpuErrors.length||!sky||skyPreparing||skyError||worldPreparing||worldError||biomeSearch||!view.inspection().coverageReady)return;skyDiagnostic.value='composite';sky.setDiagnostic('composite');setMode('auto');trackSun.input.checked=false;yaw=pitch=0;recent.length=0;benchmarkState={seconds:0,samples:[],startedAt:new Date().toISOString(),initialStreaming:view.inspection(),initialSky:sky.inspection(),skyRecipe,sunElevationDegrees:Number(sunElevation.value)};benchmark.disabled=true;advanceDay.disabled=true;generatorControls?.setBusy(true,'Measuring flight…');radiusSelect.disabled=true;detail.disabled=true;districtSelect.disabled=true;backendSelect.disabled=true;gpuCompletions.length=0;modeButtons.forEach(button=>button.disabled=true);skyControls.forEach(control=>control.disabled=true);exportButton.disabled=true;report.textContent='Measuring flight. Retaining the previous report while this run completes.';previousNow=0;};
  exportButton.onclick=()=>{if(!retained)return;const url=URL.createObjectURL(new Blob([JSON.stringify(retained,null,2)],{type:'application/json'})),a=element('a');a.href=url;a.download='planet-flight-round-trip.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  function worldFacts(){return {preparing:worldPreparing,error:worldError,searchingDistrict:!!biomeSearch,startup:{firstSkyRenderCpuMs,metric:'First sky render CPU submission, including synchronous shader compilation; excludes asynchronous driver work.'},biome:biomes.sample(lastDirection),biomeRevision:biomes.revision,materialRecipes:surfaceMaterials.length,population:population?.inspection(),water:water.inspection()};}
  function render(now:number){
    if(disposed)return;raf=requestAnimationFrame(render);const started=performance.now(),interval=previousNow?now-previousNow:0;previousNow=now;
    if(document.visibilityState==='hidden')return;
    const dt=interval/1000;skySeconds+=dt;
    if(simulationMode){
      const rate=generatedPlanet!.recipe.rotationPeriodSeconds/Number(dayDuration.value),running=!!benchmarkState||clockRunning.input.checked;
      if(running||!sky?.inspection().simulation.active)sky?.stageWeather(renderer);
      if(running)desiredSimulationSeconds+=dt*rate;
      if(running&&now-lastAtmosphereRequest>=250){lastAtmosphereRequest=now;atmosphereSession?.advanceTo(desiredSimulationSeconds,lastDirection);}
      const staged=sky?.inspection().simulation;
      if(running&&staged?.active&&staged.fromTime!==null&&staged.toTime!==null){
        // Sun, weather and volume detail share one achieved physical clock.
        // Never extrapolate a moving sun beyond completed weather snapshots.
        simulationSeconds=clamp(simulationSeconds+dt*rate,staged.fromTime,staged.toTime);
      }
      renderSimulationSeconds=simulationSeconds;
    }else{
      if(!benchmarkState&&clockRunning.input.checked)simulationSeconds+=dt*86400/Number(dayDuration.value);
      renderSimulationSeconds=benchmarkState?benchmarkState.seconds*86400/Number(dayDuration.value):simulationSeconds;
    }
    if(benchmarkState)benchmarkState.seconds+=dt;else routeSeconds+=dt;
    const updateStarted=performance.now(),phase=flight(benchmarkState?.seconds??routeSeconds,!!benchmarkState,dt);lastUpdateCpu=performance.now()-updateStarted;
    const renderStarted=performance.now();renderer.info.reset();
    try{if(sky){if(nativeGPU)(sky as PlanetSkyWebGPUView).render(renderer as WebGPURenderer,scene,camera,{position:tuple(absolute),timeSeconds:renderSimulationSeconds,sunDirection:tuple(sunDirection),starRotationRadians,presentationTimeSeconds:skySeconds,weatherPrepared:simulationMode});else (sky as PlanetSkyView).render(renderer as THREE.WebGLRenderer,scene,camera,{position:tuple(absolute),timeSeconds:renderSimulationSeconds,sunDirection:tuple(sunDirection),starRotationRadians,presentationTimeSeconds:skySeconds,weatherPrepared:simulationMode});}else renderer.render(scene,camera);}
    catch(error){skyError=error instanceof Error?error.message:String(error);sky?.dispose();sky=undefined;skyBakeKey='';renderer.render(scene,camera);}
    lastRenderCpu=performance.now()-renderStarted;
    if(sky&&firstSkyRenderCpuMs===null)firstSkyRenderCpuMs=rounded(lastRenderCpu);
    if(gpuDevice&&!gpuPending&&gpuCompletions.length<1800){gpuPending=true;const queued=performance.now();void gpuDevice.queue.onSubmittedWorkDone().then(()=>{gpuCompletions.push(performance.now()-queued);gpuPending=false;}).catch(error=>{gpuErrors.push(String(error));gpuPending=false;});}
    const skyFacts=sky?.inspection(),sceneFacts=skyFacts as {sceneTriangles?:number;sceneDrawCalls?:number}|undefined;
    lastTriangles=sceneFacts?.sceneTriangles??renderer.info.render.triangles;lastDrawCalls=sceneFacts?.sceneDrawCalls??renderer.info.render.calls;
    if(interval>0){recent.push(interval);if(recent.length>600)recent.shift();}
    let sample:FlightSample|undefined;
    if(benchmarkState&&interval>0&&benchmarkState.samples.length<MAX_SAMPLES){sample={seconds:rounded(benchmarkState.seconds),intervalMs:rounded(interval),updateCpuMs:rounded(lastUpdateCpu),renderCpuMs:rounded(lastRenderCpu),callbackCpuMs:0,altitudeMeters:rounded(altitudeMeters),sourceHeightMeters:rounded(lastSurface),displayedHeightMeters:lastDisplaySurface===undefined?null:rounded(lastDisplaySurface),coarseClearanceAdjustmentMeters:rounded(lastClearanceAdjustment),triangles:lastTriangles,drawCalls:lastDrawCalls,focused:document.hasFocus(),streaming:view.inspection(),sky:skyFacts??{ready:false,error:skyError},world:worldFacts(),weatherTimeSeconds:rounded(renderSimulationSeconds),sunDirection:tuple(sunDirection)};benchmarkState.samples.push(sample);}
    if(now-lastUi>350){lastUi=now;if(simulationMode){const update=atmosphereSession?.latest(),renderedColumn=sky?.sampleWeather(lastDirection,renderSimulationSeconds);if(renderedColumn){const ranges:string[]=[];if(renderedColumn.liquidLowerKgM2+renderedColumn.iceLowerKgM2>0)ranges.push('Lower '+altitudeLabel(Math.max(0,renderedColumn.lowerBaseMetersAsl-renderedColumn.surfaceHeightMetersAsl))+'–'+altitudeLabel(Math.max(0,renderedColumn.lowerProfileTopMetersAsl-renderedColumn.surfaceHeightMetersAsl)));if(renderedColumn.liquidUpperKgM2+renderedColumn.iceUpperKgM2>0)ranges.push('Upper '+altitudeLabel(Math.max(0,renderedColumn.upperBaseMetersAsl-renderedColumn.surfaceHeightMetersAsl))+'–'+altitudeLabel(Math.max(0,renderedColumn.upperProfileTopMetersAsl-renderedColumn.surfaceHeightMetersAsl)));cloudHeightSummary.textContent=ranges.length?ranges.join(' | ')+' above local ground/ocean':'No formed cloud in this column';}if(update&&(clockRunning.input.checked||benchmarkState||!weatherSummary.textContent))weatherSummary.textContent='Model day '+(renderSimulationSeconds/generatedPlanet!.recipe.rotationPeriodSeconds).toFixed(2)+' | Cloud-bearing area '+Math.round(Number(update.diagnostics.cloudyAreaFraction)*100)+'% | Peak wind '+Number(update.diagnostics.maxWindMetersPerSecond).toFixed(1)+' m/s';atmosphereSession?.probe(lastDirection);weatherCounters.textContent=JSON.stringify({error:simulationError,clockPaused:!clockRunning.input.checked,requestedSeconds:rounded(desiredSimulationSeconds),renderSeconds:rounded(renderSimulationSeconds),solverBacklogSeconds:rounded(Math.max(0,desiredSimulationSeconds-(update?.snapshot.timeSeconds??0))),planet:generatedPlanet?.diagnostics,physics:generatedPlanet?.physics,simulation:update?.diagnostics,atCamera:update?.probe,renderedColumn},null,2);}const weather=!simulationMode?skyReference?.weather.sample(lastDirection,renderSimulationSeconds,tuple(sunDirection)):undefined;if(weather)weatherCounters.textContent=JSON.stringify({clockPaused:!clockRunning.input.checked,targetCoverage:Number(coverage.value),columnCloudSupport:rounded(weather.support),pressureHectopascals:rounded(weather.pressureHectopascals),temperatureCelsius:rounded(weather.temperatureKelvin-273.15),relativeHumidity:rounded(weather.relativeHumidity),windEastMetersPerSecond:rounded(weather.windEastMetersPerSecond),windNorthMetersPerSecond:rounded(weather.windNorthMetersPerSecond),coldFrontLift:rounded(weather.coldFront),warmFrontLift:rounded(weather.warmFront),condensation:rounded(weather.condensation),layers:{low:rounded(weather.low),cumulus:rounded(weather.cumulus),cirrus:rounded(weather.cirrus)},model:'Earth-inspired procedural weather, not a forecast'},null,2);refreshFlightControls();if(!benchmarkState)refreshClockLabel();const streaming=view.inspection();if(!benchmarkState)benchmark.disabled=gpuErrors.length>0||!streaming.coverageReady||!sky||skyPreparing||!!skyError||worldPreparing||!!worldError||!!biomeSearch;altitude.textContent=altitudeLabel(altitudeMeters);phaseLabel.textContent=phase+' · clearance above source/displayed terrain';counters.textContent=JSON.stringify({radiusMeters:planet.radius,sourceHeightMeters:rounded(lastSurface),displayedHeightMeters:lastDisplaySurface===undefined?null:rounded(lastDisplaySurface),coarseClearanceAdjustmentMeters:rounded(lastClearanceAdjustment),actualAltitudeAboveSourceMeters:rounded(altitudeMeters+lastClearanceAdjustment),absoluteCameraMetres:tuple(absolute).map(rounded),direction:lastDirection.map(n=>rounded(n)),origin:'camera position (double)',triangles:lastTriangles,drawCalls:lastDrawCalls,streaming},null,2);skyCounters.textContent=JSON.stringify({preparing:skyPreparing,error:skyError,style:skyRecipe.style,quality:skyRecipe.quality,sunElevationDegrees:Number(sunElevation.value),...(skyFacts??{})},null,2);worldCounters.textContent=JSON.stringify({...worldFacts(),solar:{simulationSeconds:rounded(renderSimulationSeconds),sunDirection:tuple(sunDirection),rotationRadians:starRotationRadians,clockRunning:clockRunning.input.checked,dayDurationSeconds:Number(dayDuration.value)}},null,2);frames.textContent=JSON.stringify({rollingSamples:recent.length,intervalMs:distribution(recent),backend:nativeGPU?'webgpu':'webgl2',gpuQueueCompletions:gpuCompletions.length,gpuErrors,latestCpuMs:{update:rounded(lastUpdateCpu),renderSubmit:rounded(lastRenderCpu),previousCompleteCallback:rounded(lastCallbackCpu)}},null,2);if(benchmarkState)status.textContent='Measuring '+phase.toLowerCase()+' · '+Math.ceil(Math.max(0,ROUND_TRIP_SECONDS-benchmarkState.seconds))+' s remaining';else if(gpuErrors.length)status.textContent='Rendering failed; reload before measuring: '+gpuErrors[0];else if(simulationError)status.textContent='Atmosphere simulation stopped: '+simulationError;else if(worldError)status.textContent='World preparation error: '+worldError;else if(skyError)status.textContent='Sky unavailable: '+skyError;else status.textContent=phase+' · '+(skyPreparing?'preparing replacement sky in a worker; ':'')+'asynchronous detail requests retain the last complete parent coverage.';}
    lastCallbackCpu=performance.now()-started;if(sample)sample.callbackCpuMs=rounded(lastCallbackCpu);
    if(benchmarkState&&benchmarkState.seconds>=ROUND_TRIP_SECONDS)finalizeBenchmark();
  }
  raf=requestAnimationFrame(render);
  return()=>{disposed=true;pendingAtmosphereAbort?.abort();atmosphereAbort?.abort();atmosphereSession?.dispose();generatorControls?.dispose();skyAbort?.abort();skyVersion++;sky?.dispose();cancelAnimationFrame(raf);resize.disconnect();document.removeEventListener('visibilitychange',visibilityChanged);canvas.removeEventListener('webglcontextlost',contextLost);canvas.removeEventListener('pointerdown',pointerDown);canvas.removeEventListener('pointermove',pointerMove);canvas.removeEventListener('pointerup',pointerUp);canvas.removeEventListener('pointercancel',pointerUp);canvas.removeEventListener('wheel',wheel);canvas.removeEventListener('keydown',keyDown);canvas.removeEventListener('blur',clearFlightInput);window.removeEventListener('keyup',keyUp);window.removeEventListener('blur',clearFlightInput);flightKeys.clear();worldAbort.abort();biomeSearch?.terminate();population?.dispose();library?.dispose();water.dispose();view.dispose();surfaceMaterials.forEach(material=>material.dispose());if(!surfaceMaterials.length)terrainMaterials.forEach(material=>material.dispose());renderer.dispose();if(renderer instanceof THREE.WebGLRenderer)renderer.forceContextLoss();root.remove();};
}
