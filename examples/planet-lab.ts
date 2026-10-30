import * as THREE from 'three';
import {compilePlanet,createPlanetRecipe,type CompiledPlanet,type PlanetVector} from '../src/shared/planet.ts';
import {PlanetView} from '../src/sandbox/planetView.ts';
import {createPlanetPreparationSource} from '../src/client/game/planetPreparation.ts';

type FlightMode='auto'|'orbit'|'descend'|'surface';
interface FlightSample {
  seconds:number;intervalMs:number;updateCpuMs:number;renderCpuMs:number;callbackCpuMs:number;
  altitudeMeters:number;sourceHeightMeters:number;displayedHeightMeters:number|null;
  coarseClearanceAdjustmentMeters:number;triangles:number;drawCalls:number;focused:boolean;streaming:unknown;
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
  const root=element('main',undefined,'planetlab');
  const style=element('style',`
    .planetlab{font:14px/1.5 system-ui,sans-serif;background:#071017;color:#e4edf2;height:100dvh;display:flex;flex-direction:column;overflow:hidden}
    .planetlab *{box-sizing:border-box}.planetlab header{padding:14px 20px;border-bottom:1px solid #24424c;display:flex;align-items:center;gap:24px}
    .planetlab h1{font-size:22px;line-height:1.2;margin:2px 0}.planetlab small{font-size:10px;letter-spacing:.12em;color:#8db9c8}.planetlab p{margin:8px 0}
    .planetlab a{color:#a6dbe6}.planetlab header a{margin-left:auto;white-space:nowrap}.planetlab header p{color:#a7c0cc;font-size:12px}
    .planetlab section{display:grid;grid-template-columns:minmax(0,1fr) 318px;min-height:0;flex:1}.planetlab .flight{position:relative;min-height:280px;overflow:hidden;background:#030810}
    .planetlab canvas{display:block;width:100%;height:100%}.planetlab .telemetry{position:absolute;left:20px;top:18px;background:#06121bc7;border:1px solid #254956;padding:12px 16px;border-radius:8px;pointer-events:none;min-width:220px}
    .planetlab .altitude{font-size:28px;font-weight:650;letter-spacing:-.025em}.planetlab .hint{position:absolute;left:18px;bottom:16px;font-size:11px;background:#06121bc7;color:#bad0db;padding:7px 10px;border-radius:6px;max-width:90%}
    .planetlab aside{overflow:auto;padding:16px;border-left:1px solid #24424c}.planetlab h2{font-size:13px;margin:20px 0 8px;color:#b9dce7}.planetlab .buttons{display:flex;gap:7px;flex-wrap:wrap}
    .planetlab button,.planetlab select{background:#132832;color:#def0f6;border:1px solid #385b69;border-radius:6px;padding:8px 10px;font:inherit;font-size:12px;cursor:pointer}
    .planetlab button:hover,.planetlab button[aria-pressed=true]{background:#254954;border-color:#7abac8}.planetlab button:disabled{opacity:.4;cursor:default}.planetlab .primary{background:#416a62;border-color:#85c6b1;color:#f1fff9}
    .planetlab label{display:block;margin-top:14px;font-size:12px;color:#bad0db}.planetlab input[type=range]{display:block;width:100%;accent-color:#9bd8c1;margin:8px 0}.planetlab select{display:block;width:100%;margin-top:5px}
    .planetlab pre{white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.5 ui-monospace,monospace;color:#bcd6df;background:#07131b;border:1px solid #1d3944;padding:9px;border-radius:6px;margin:5px 0}
    .planetlab .muted{font-size:11px;color:#8eafb9}.planetlab footer{padding:8px 18px;font-size:11px;color:#acd6c9;border-top:1px solid #24424c;min-height:34px}
    @media(max-width:850px){.planetlab section{grid-template-columns:minmax(0,1fr) 260px}.planetlab header p{display:none}.planetlab aside{padding:12px}.planetlab .telemetry{left:10px;top:10px;min-width:180px;padding:8px 10px}.planetlab .altitude{font-size:23px}}
    @media(max-width:560px){.planetlab header{padding:10px}.planetlab h1{font-size:18px}.planetlab section{grid-template-columns:1fr;grid-template-rows:minmax(280px,1fr) 260px}.planetlab aside{border-left:0;border-top:1px solid #24424c}.planetlab header a{font-size:11px}}
  `);root.append(style);
  const header=element('header'),brand=element('div');brand.append(element('small','PATCHGAMES ENGINE / ONE PLANET, CONTINUOUS COVERAGE'),element('h1','Planet Flight Lab'));
  const back=element('a','World LOD Lab');back.href='lod-lab.html';header.append(brand,element('p','Fly from orbit to the surface while bounded workers refine the same procedural world.'),back);root.append(header);
  const section=element('section'),viewport=element('div',undefined,'flight'),canvas=element('canvas'),sidebar=element('aside');
  const telemetry=element('div',undefined,'telemetry'),altitude=element('div','Orbit','altitude'),phaseLabel=element('div','Six-root globe • camera-relative precision'),scaleLabel=element('div',undefined,'muted');telemetry.append(altitude,phaseLabel,scaleLabel);
  viewport.append(canvas,telemetry,element('div','Drag to look around · wheel adjusts altitude · coarse ground stays visible while detail arrives','hint'));section.append(viewport,sidebar);root.append(section);
  const buttons=element('div',undefined,'buttons'),modeButtons=new Map<FlightMode,HTMLButtonElement>();
  for(const [mode,label] of [['orbit','Orbit'],['descend','Descend'],['surface','Surface'],['auto','Auto flight']] as const){const button=element('button',label);button.setAttribute('aria-pressed',String(mode==='auto'));buttons.append(button);modeButtons.set(mode,button);}sidebar.append(buttons);
  const radiusSelect=element('select');radiusSelect.setAttribute('aria-label','Planet radius');for(const [value,label] of [[EARTH_RADIUS,'Earth scale · 6,371 km radius'],[80_000,'Small world · 80 km radius']] as const){const option=element('option',label);option.value=String(value);radiusSelect.append(option);}const radiusControl=element('label','Planet scale');radiusControl.append(radiusSelect);sidebar.append(radiusControl);
  const detail=element('input');detail.type='range';detail.min='2';detail.max='16';detail.step='1';detail.value='6';detail.setAttribute('aria-label','Target terrain cell pixels');const detailLabel=element('label','Target cell footprint: 6 px');detailLabel.append(detail);sidebar.append(detailLabel);
  sidebar.append(element('p','Smaller targets request finer terrain. Patch and memory budgets still cap detail.','muted'));
  const benchmark=element('button','Measure 40 s round trip', 'primary'),exportButton=element('button','Export report');benchmark.disabled=true;exportButton.disabled=true;const benchmarkButtons=element('div',undefined,'buttons');benchmarkButtons.append(benchmark,exportButton);sidebar.append(benchmarkButtons);
  sidebar.append(element('h2','Streaming and precision'));const counters=element('pre');counters.setAttribute('aria-label','Planet streaming counters');sidebar.append(counters);
  sidebar.append(element('h2','Recent frame intervals'));const frames=element('pre');frames.setAttribute('aria-label','Planet live frame timings');sidebar.append(frames,element('p','RAF intervals and CPU submission are measured here. These are not physical display FPS or GPU completion timings.','muted'));
  sidebar.append(element('h2','Retained round trip'));const report=element('pre','No measured trip yet.');report.setAttribute('aria-label','Planet benchmark report');sidebar.append(report,element('p','This flight validates visual terrain streaming. Buildings, foliage, water simulation and multiplayer surface physics need their own local adapters.','muted'));
  const status=element('footer','Preparing six globe roots asynchronously. Flight remains active while detail is requested.');status.setAttribute('aria-live','polite');root.append(status);parent.append(root);

  const renderer=new THREE.WebGLRenderer({canvas,antialias:true,powerPreference:'high-performance',logarithmicDepthBuffer:true});renderer.setPixelRatio(Math.min(devicePixelRatio,1.25));renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.setClearColor('#030810');
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(60,1,.1,EARTH_RADIUS*8);scene.add(new THREE.HemisphereLight('#b9dcf1','#183147',1.5));const sun=new THREE.DirectionalLight('#fff0d8',2.4);sun.position.set(2,4,3);scene.add(sun);
  let planet:CompiledPlanet,view:PlanetView;
  let disposed=false,raf=0,previousNow=0,routeSeconds=0,lastUi=0,lastUpdateCpu=0,lastRenderCpu=0,lastCallbackCpu=0,mode:FlightMode='auto',wheelOffset=0,yaw=0,pitch=0;
  let benchmarkState:{seconds:number;samples:FlightSample[];startedAt:string;initialStreaming:unknown}|undefined;
  let retained:unknown;
  const recent:number[]=[];
  const direction=new THREE.Vector3(),tangent=new THREE.Vector3(),north=new THREE.Vector3(),absolute=new THREE.Vector3(),target=new THREE.Vector3(),nearTarget=new THREE.Vector3(),up=new THREE.Vector3(),forward=new THREE.Vector3(),right=new THREE.Vector3();
  let altitudeMeters=EARTH_RADIUS*1.4,lastSurface=0,lastDisplaySurface:number|undefined,lastClearanceAdjustment=0,lastDirection:PlanetVector=[0,1,0];
  function replacePlanet(radius:number){
    if(view){scene.remove(view.root);view.dispose();}
    const recipe=createPlanetRecipe(412,radius);planet=compilePlanet(recipe);view=new PlanetView(planet,createPlanetPreparationSource(recipe),{maxResidentPatches:512,maxSelectedPatches:192,maxInFlight:2,maxUploadsPerFrame:2,targetCellPixels:Number(detail.value),maxResidentBytes:96*1024*1024});scene.add(view.root);
    camera.far=radius*8;camera.updateProjectionMatrix();routeSeconds=0;wheelOffset=0;recent.length=0;previousNow=0;benchmark.disabled=true;
    scaleLabel.textContent='Radius '+(radius/1000).toLocaleString()+' km · local Float32 meshes';
  }
  replacePlanet(EARTH_RADIUS);
  function setMode(value:FlightMode){mode=value;modeButtons.forEach((button,key)=>button.setAttribute('aria-pressed',String(key===value)));if(value==='auto'||value==='descend')routeSeconds=value==='descend'?6:0;wheelOffset=0;}
  modeButtons.forEach((button,key)=>button.onclick=()=>{if(benchmarkState)return;setMode(key);});
  radiusSelect.onchange=()=>{if(!benchmarkState)replacePlanet(Number(radiusSelect.value));};
  detail.oninput=()=>{detailLabel.firstChild!.textContent='Target cell footprint: '+detail.value+' px';};
  detail.onchange=()=>{if(!benchmarkState)replacePlanet(Number(radiusSelect.value));};
  let drag:{x:number;y:number}|undefined;
  const pointerDown=(event:PointerEvent)=>{if(benchmarkState)return;drag={x:event.clientX,y:event.clientY};canvas.setPointerCapture(event.pointerId);};
  const pointerMove=(event:PointerEvent)=>{if(!drag)return;yaw+=(event.clientX-drag.x)*.003;pitch=clamp(pitch+(event.clientY-drag.y)*.003,-.8,.8);drag={x:event.clientX,y:event.clientY};};
  const pointerUp=()=>{drag=undefined;};
  const wheel=(event:WheelEvent)=>{event.preventDefault();if(!benchmarkState)wheelOffset=clamp(wheelOffset+event.deltaY*.002,-4,4);};
  canvas.addEventListener('pointerdown',pointerDown);canvas.addEventListener('pointermove',pointerMove);canvas.addEventListener('pointerup',pointerUp);canvas.addEventListener('pointercancel',pointerUp);canvas.addEventListener('wheel',wheel,{passive:false});
  const resize=new ResizeObserver(()=>{const width=viewport.clientWidth,height=viewport.clientHeight;renderer.setSize(width,height,false);camera.aspect=width/Math.max(1,height);camera.updateProjectionMatrix();});resize.observe(viewport);
  const visibilityChanged=()=>{previousNow=0;if(document.visibilityState==='hidden'&&benchmarkState)status.textContent='Measurement paused while this tab is hidden.';};document.addEventListener('visibilitychange',visibilityChanged);

  function flight(seconds:number,forced:boolean){
    const t=forced?Math.min(seconds,ROUND_TRIP_SECONDS):seconds%ROUND_TRIP_SECONDS;
    const surfaceAltitude=75,orbitalAltitude=planet.radius*1.4;
    let requested:number,phase:string;
    if(!forced&&mode==='orbit'){requested=orbitalAltitude;phase='Orbit';}
    else if(!forced&&mode==='surface'){requested=surfaceAltitude;phase='Surface flyover';}
    else if(t<6){requested=orbitalAltitude;phase='Orbit';}
    else if(t<18){requested=Math.exp(lerp(Math.log(orbitalAltitude),Math.log(surfaceAltitude),smooth((t-6)/12)));phase='Descending';}
    else if(t<28){requested=surfaceAltitude;phase='Surface flyover';}
    else{requested=Math.exp(lerp(Math.log(surfaceAltitude),Math.log(orbitalAltitude),smooth((t-28)/12)));phase='Ascending';}
    altitudeMeters=Math.max(5,requested*Math.exp(wheelOffset));
    // Stay near the same landing district during descent. Surface movement is
    // measured in metres, rather than racing degrees of latitude each frame.
    const metres=seconds*35,longitude=.42+metres/planet.radius,latitude=.48;
    direction.set(Math.cos(latitude)*Math.sin(longitude),Math.sin(latitude),Math.cos(latitude)*Math.cos(longitude));
    const sampled=planet.sample(tuple(direction));lastSurface=sampled.heightMeters;lastDirection=tuple(direction);
    lastDisplaySurface=view.displayedSurface(tuple(direction))?.heightMeters;lastClearanceAdjustment=Math.max(0,(lastDisplaySurface??lastSurface)-lastSurface);
    absolute.copy(direction).multiplyScalar(planet.radius+sampled.heightMeters+lastClearanceAdjustment+altitudeMeters);
    view.update({position:tuple(absolute),origin:tuple(absolute),viewportHeight:canvas.height,fovDegrees:camera.fov});
    const published=view.displayedSurface(tuple(direction));
    if(published){lastDisplaySurface=published.heightMeters;const clearance=Math.max(0,published.heightMeters-lastSurface);if(clearance>lastClearanceAdjustment){lastClearanceAdjustment=clearance;absolute.copy(direction).multiplyScalar(planet.radius+lastSurface+clearance+altitudeMeters);view.rebase(tuple(absolute));}}
    tangent.set(Math.cos(longitude),0,-Math.sin(longitude));
    const lookAhead=Math.max(200,Math.min(planet.radius*.05,altitudeMeters*7));
    nearTarget.copy(direction).addScaledVector(tangent,lookAhead/planet.radius).normalize();
    const ahead=planet.sample(tuple(nearTarget));nearTarget.multiplyScalar(planet.radius+ahead.heightMeters+altitudeMeters*.35);
    const orbital=smooth((Math.log10(altitudeMeters)-3)/2.6);
    target.copy(nearTarget).multiplyScalar(1-orbital).sub(absolute);
    north.set(0,1,0).addScaledVector(direction,-direction.y).normalize();up.copy(direction).multiplyScalar(1-orbital).addScaledVector(north,orbital).normalize();
    camera.position.set(0,0,0);camera.up.copy(up);camera.lookAt(target);
    if(!forced&&(yaw!==0||pitch!==0)){forward.copy(target).normalize();right.crossVectors(forward,up).normalize();forward.applyAxisAngle(up,yaw).applyAxisAngle(right,pitch);camera.lookAt(forward);}
    return phase;
  }
  function finalizeBenchmark(){
    const run=benchmarkState;if(!run)return;
    const samples=run.samples;
    retained={version:1,startedAt:run.startedAt,route:'40-second deterministic orbit → descent → 75 m surface flyover → ascent',metric:'RAF callback intervals and CPU submission; not physical display FPS or GPU completion',radiusMeters:planet.radius,recipe:planet.recipe,viewport:{width:canvas.width,height:canvas.height,pixelRatio:renderer.getPixelRatio()},samples:samples.length,intervalMs:distribution(samples.map(s=>s.intervalMs)),updateCpuMs:distribution(samples.map(s=>s.updateCpuMs)),renderCpuMs:distribution(samples.map(s=>s.renderCpuMs)),callbackCpuMs:distribution(samples.map(s=>s.callbackCpuMs)),focusedSamples:samples.filter(s=>s.focused).length,triangles:{min:Math.min(...samples.map(s=>s.triangles)),max:Math.max(...samples.map(s=>s.triangles))},initialStreaming:run.initialStreaming,finalStreaming:view.inspection(),longIntervals:samples.filter(s=>s.intervalMs>33).slice(0,100),trace:samples};
    report.textContent=JSON.stringify({...retained as Record<string,unknown>,recipe:undefined,trace:undefined},null,2);exportButton.disabled=false;benchmarkState=undefined;benchmark.disabled=false;radiusSelect.disabled=false;detail.disabled=false;modeButtons.forEach(button=>button.disabled=false);status.textContent='Round trip measured. Export includes the bounded frame trace and streaming counters.';
  }
  benchmark.onclick=()=>{setMode('auto');yaw=pitch=0;recent.length=0;benchmarkState={seconds:0,samples:[],startedAt:new Date().toISOString(),initialStreaming:view.inspection()};benchmark.disabled=true;radiusSelect.disabled=true;detail.disabled=true;modeButtons.forEach(button=>button.disabled=true);exportButton.disabled=true;previousNow=0;};
  exportButton.onclick=()=>{if(!retained)return;const url=URL.createObjectURL(new Blob([JSON.stringify(retained,null,2)],{type:'application/json'})),a=element('a');a.href=url;a.download='planet-flight-round-trip.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  function render(now:number){
    if(disposed)return;raf=requestAnimationFrame(render);const started=performance.now(),interval=previousNow?now-previousNow:0;previousNow=now;
    if(document.visibilityState==='hidden')return;
    const dt=interval/1000;if(benchmarkState)benchmarkState.seconds+=dt;else routeSeconds+=dt;
    const updateStarted=performance.now(),phase=flight(benchmarkState?.seconds??routeSeconds,!!benchmarkState);lastUpdateCpu=performance.now()-updateStarted;
    const renderStarted=performance.now();renderer.render(scene,camera);lastRenderCpu=performance.now()-renderStarted;lastCallbackCpu=performance.now()-started;
    if(interval>0){recent.push(interval);if(recent.length>600)recent.shift();}
    if(benchmarkState&&interval>0&&benchmarkState.samples.length<MAX_SAMPLES)benchmarkState.samples.push({seconds:rounded(benchmarkState.seconds),intervalMs:rounded(interval),updateCpuMs:rounded(lastUpdateCpu),renderCpuMs:rounded(lastRenderCpu),callbackCpuMs:rounded(lastCallbackCpu),altitudeMeters:rounded(altitudeMeters),sourceHeightMeters:rounded(lastSurface),displayedHeightMeters:lastDisplaySurface===undefined?null:rounded(lastDisplaySurface),coarseClearanceAdjustmentMeters:rounded(lastClearanceAdjustment),triangles:renderer.info.render.triangles,drawCalls:renderer.info.render.calls,focused:document.hasFocus(),streaming:view.inspection()});
    if(now-lastUi>350){lastUi=now;const streaming=view.inspection();if(!benchmarkState)benchmark.disabled=!streaming.coverageReady;altitude.textContent=altitudeLabel(altitudeMeters);phaseLabel.textContent=phase+' · clearance above source/displayed terrain';counters.textContent=JSON.stringify({radiusMeters:planet.radius,sourceHeightMeters:rounded(lastSurface),displayedHeightMeters:lastDisplaySurface===undefined?null:rounded(lastDisplaySurface),coarseClearanceAdjustmentMeters:rounded(lastClearanceAdjustment),actualAltitudeAboveSourceMeters:rounded(altitudeMeters+lastClearanceAdjustment),absoluteCameraMetres:tuple(absolute).map(rounded),direction:lastDirection.map(n=>rounded(n)),origin:'camera position (double)',triangles:renderer.info.render.triangles,drawCalls:renderer.info.render.calls,streaming},null,2);frames.textContent=JSON.stringify({rollingSamples:recent.length,intervalMs:distribution(recent),latestCpuMs:{update:rounded(lastUpdateCpu),renderSubmit:rounded(lastRenderCpu),callback:rounded(lastCallbackCpu)}},null,2);if(benchmarkState)status.textContent='Measuring '+phase.toLowerCase()+' · '+Math.ceil(Math.max(0,ROUND_TRIP_SECONDS-benchmarkState.seconds))+' s remaining';else status.textContent=phase+' · asynchronous detail requests retain the last complete parent coverage.';}
    if(benchmarkState&&benchmarkState.seconds>=ROUND_TRIP_SECONDS)finalizeBenchmark();
  }
  raf=requestAnimationFrame(render);
  return()=>{disposed=true;cancelAnimationFrame(raf);resize.disconnect();document.removeEventListener('visibilitychange',visibilityChanged);canvas.removeEventListener('pointerdown',pointerDown);canvas.removeEventListener('pointermove',pointerMove);canvas.removeEventListener('pointerup',pointerUp);canvas.removeEventListener('pointercancel',pointerUp);canvas.removeEventListener('wheel',wheel);view.dispose();renderer.dispose();renderer.forceContextLoss();root.remove();};
}
