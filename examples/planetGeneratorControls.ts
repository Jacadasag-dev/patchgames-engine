import {createPlanetGeneratorRecipe,type PlanetGeneratorRecipe,type PlanetGeneratorPreset} from '../src/shared/planetGenerator.ts';

/** Physical authoring inputs; clouds and circulation evolve without authored
 * coverage targets or storm counts. */
export function createPlanetGeneratorControls(parent:HTMLElement,onGenerate:(recipe:PlanetGeneratorRecipe)=>Promise<void>) {
  const panel=document.createElement('details');panel.open=true;
  const summary=document.createElement('summary');summary.textContent='Physical planet generator';panel.append(summary);
  const description=document.createElement('p');description.className='muted';description.textContent='Choose the planet’s physical conditions. The simulation transports air, heat, water and dust; clouds are a result. Experimental two-layer atmosphere; high cirrus can be too widespread.';panel.append(description);
  const preset=document.createElement('select');preset.setAttribute('aria-label','Planet preset');
  for(const [value,name]of [['earthlike','Earth-like'],['marslike','Mars-like dry world'],['stormworld','Warm ocean storm world']]){const option=document.createElement('option');option.value=value;option.textContent=name;preset.append(option);}
  const presetLabel=document.createElement('label');presetLabel.textContent='Starting conditions';presetLabel.append(preset);panel.append(presetLabel);
  const inputs=new Map<keyof PlanetGeneratorRecipe,{input:HTMLInputElement;scale:number}>();
  const add=(key:keyof PlanetGeneratorRecipe,name:string,min:number,max:number,step:number,scale=1,container:HTMLElement=panel)=>{
    const label=document.createElement('label');label.textContent=name;const input=document.createElement('input');input.type='number';input.min=String(min);input.max=String(max);input.step=key==='seed'?String(step):'any';input.required=true;input.setAttribute('aria-label',name);label.append(input);container.append(label);inputs.set(key,{input,scale});
  };
  add('radiusMeters','Planet radius (km)',500,100000,10,1000);
  add('gravityMetersPerSecondSquared','Surface gravity (m/s²)',.3,50,.1);
  add('rotationPeriodSeconds','Rotation period (hours)',1,277777,1,3600);
  add('surfacePressurePascals','Surface pressure (bar)',.00001,20,.01,100000);
  add('waterCoverage','Surface water (%)',0,100,1,.01);
  add('initialRelativeHumidity','Initial atmospheric humidity (%)',0,100,1,.01);
  add('stellarFluxWattsPerSquareMeter','Starlight (W/m²)',10,5000,10);
  const advanced=document.createElement('details'),advancedTitle=document.createElement('summary');advancedTitle.textContent='Composition and surface';advanced.append(advancedTitle);panel.append(advanced);
  const gas=document.createElement('select');gas.setAttribute('aria-label','Atmosphere composition');
  for(const [value,name]of [['earthlike','Nitrogen / oxygen'],['carbon-dioxide','Carbon dioxide']]){const option=document.createElement('option');option.value=value;option.textContent=name;gas.append(option);}
  const gasLabel=document.createElement('label');gasLabel.textContent='Atmosphere composition';gasLabel.append(gas);advanced.append(gasLabel);
  add('axialTiltDegrees','Axial tilt (degrees)',0,90,1,1,advanced);
  add('orbitalPeriodSeconds','Orbital period (Earth days)',1,11574074,1,86400,advanced);
  add('orbitalPhaseTurns','Starting orbital phase (%)',0,100,1,.01,advanced);
  add('surfaceMoisture','Soil moisture availability (%)',0,100,1,.01,advanced);
  add('surfaceAlbedo','Surface albedo',0,1,.01,1,advanced);
  add('greenhouseOpticalDepth','Infrared optical depth',0,10,.05,1,advanced);
  add('oceanMixedLayerDepthMeters','Ocean mixed layer depth (m)',1,200,1,1,advanced);
  add('dustAvailability','Loose dust availability (%)',0,100,1,.01,advanced);
  add('terrainReliefMeters','Terrain relief (km)',.001,5000,1,1000,advanced);
  add('seed','Planet seed',-2147483648,2147483647,1,1,advanced);
  const generate=document.createElement('button');generate.textContent='Generate planet';generate.className='primary';generate.style.marginTop='16px';panel.append(generate);
  const status=document.createElement('p');status.className='muted';status.setAttribute('aria-live','polite');panel.append(status);parent.append(panel);
  const apply=(recipe:PlanetGeneratorRecipe)=>{gas.value=recipe.gas;for(const [key,{input,scale}]of inputs)input.value=String(Number(recipe[key])/scale);};
  const read=():PlanetGeneratorRecipe=>{const recipe=createPlanetGeneratorRecipe(preset.value as PlanetGeneratorPreset);for(const [key,{input,scale}]of inputs){if(!input.checkValidity())throw Error('Check '+input.getAttribute('aria-label')+'.');(recipe as unknown as Record<string,unknown>)[key]=Number(input.value)*scale;}recipe.gas=gas.value as PlanetGeneratorRecipe['gas'];return recipe;};
  preset.onchange=()=>{apply(createPlanetGeneratorRecipe(preset.value as PlanetGeneratorPreset));status.textContent='Press Generate planet to apply these starting conditions.';};
  generate.onclick=async()=>{try{generate.disabled=true;status.textContent='Preparing the planet and initializing its atmosphere…';await onGenerate(read());status.textContent='Planet ready. Run the clock to evolve its atmosphere.';}catch(error){status.textContent=error instanceof Error?error.message:String(error);}finally{generate.disabled=false;}};
  apply(createPlanetGeneratorRecipe());
  return {element:panel,read,setBusy(busy:boolean,message=''){generate.disabled=busy;status.textContent=message;},dispose(){panel.remove();}};
}
