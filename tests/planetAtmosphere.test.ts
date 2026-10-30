import {describe,expect,it} from 'vitest';
import {compilePlanetGenerator,createPlanetGeneratorRecipe} from '../src/shared/planetGenerator.ts';
import {createPlanetAtmosphere,planetAtmosphereRadiativeColumn,planetAtmosphereTwoStreamLayer,planetAtmosphereSaturationSpecificHumidity,rotatePlanetAtmosphereCoriolis,samplePlanetAtmosphereCelestial,PLANET_ATMOSPHERE_LIMITS,type PlanetAtmosphereRecipe,type PlanetAtmosphereRadiativeColumn} from '../src/shared/planetAtmosphere.ts';
import {samplePlanetCelestial} from '../src/shared/planetCelestial.ts';
import {planetDirection,type PlanetVector} from '../src/shared/planet.ts';

const physics=compilePlanetGenerator(createPlanetGeneratorRecipe()).physics;
const recipe=(extra:Partial<typeof physics>={}):PlanetAtmosphereRecipe=>({kind:'planet-atmosphere',version:1,seed:42,resolution:16,physics:{...physics,...extra}});
const land=(d:PlanetVector)=>({heightMeters:1800*Math.max(0,d[0]),waterFraction:d[2]>0?1:0});
const finish=(simulation:ReturnType<typeof createPlanetAtmosphere>,time:number)=>{let info=simulation.inspection();while(info.timeSeconds+info.fixedTickSeconds<=time+1e-8)info=simulation.advanceTo(time,512);return info;};
describe('persistent finite-volume planet atmosphere',()=>{
  it('closes all cube edges, bounds memory/CFL work, and advances complete physical ticks',()=>{
    const simulation=createPlanetAtmosphere(recipe()),a=simulation.inspection();
    expect(a.cellCount).toBe(6*16*16);expect(a.edgeCount).toBe(a.cellCount*2);expect(a.stateBytes).toBeLessThan(PLANET_ATMOSPHERE_LIMITS.maxStateBytes);
    const b=simulation.advanceTo(86400,2);expect(b.tick).toBe(2);expect(b.timeSeconds).toBe(2*a.fixedTickSeconds);expect(b.pendingSeconds).toBe(86400-b.timeSeconds);expect(b.maxCourant).toBeLessThan(.45);
    expect(()=>simulation.advanceTo(86400,513)).toThrow(/maxSubsteps/);expect(()=>simulation.advanceTo(-1)).toThrow();expect(()=>simulation.advanceTo(0)).toThrow(/rewind/);
  });
  it('resolves the shorter radiative timescale of thin atmospheres without a giant catch-up tick',()=>{
    const simulation=createPlanetAtmosphere(recipe({surfacePressurePascals:1,initialRelativeHumidity:0,surfaceMoisture:0}),()=>({heightMeters:0,waterFraction:0})),before=simulation.inspection();
    expect(before.fixedTickSeconds).toBeLessThan(1);const after=simulation.advanceTo(100,32);expect(after.tick).toBe(32);expect(after.pendingSeconds).toBeGreaterThan(90);expect(after.airMassRelativeError).toBeLessThan(2e-12);expect(after.waterMassKg).toBe(0);
  });
  it('conserves total background air, water including surface reservoirs, and dust during evolving circulation',()=>{
    const simulation=createPlanetAtmosphere(recipe(),land),a=simulation.inspection(),b=finish(simulation,10800);
    expect(b.airMassRelativeError).toBeLessThan(2e-12);expect(b.waterMassRelativeError).toBeLessThan(2e-12);expect(b.dustMassRelativeError).toBeLessThan(2e-12);
    expect(b.absorbedStellarJoules).toBeGreaterThan(0);expect(b.outgoingRadiationJoules).toBeGreaterThan(0);expect(b.maxWindMetersPerSecond).toBeGreaterThan(.001);expect(b.meanSurfaceTemperatureKelvin).not.toBe(a.meanSurfaceTemperatureKelvin);
    for(const field of [simulation.snapshot().vapor,simulation.snapshot().liquid,simulation.snapshot().ice])expect(field.every(v=>Number.isFinite(v)&&v>=0)).toBe(true);
  },20000);
  it('does not manufacture clouds in dry air or regenerate weather when the camera samples it',()=>{
    const simulation=createPlanetAtmosphere(recipe({initialRelativeHumidity:0,surfaceMoisture:0}),()=>({heightMeters:0,waterFraction:0}));
    const info=finish(simulation,3600);expect(info.waterMassKg).toBe(0);expect(info.condensedWaterKg).toBe(0);expect(info.cloudyAreaFraction).toBe(0);
    const before=simulation.checkpoint();for(let i=0;i<100;i++){const a=i*.1,sample=simulation.sample([Math.sin(a),Math.cos(a),.3]);expect(sample.liquidLowerKgM2+sample.liquidUpperKgM2+sample.iceLowerKgM2+sample.iceUpperKgM2).toBe(0);expect(Math.hypot(...sample.materialLower)).toBeCloseTo(1,12);}
    expect(simulation.checkpoint()).toEqual(before);
  });
  it('mass-weights occupied cloud geometry and caches diagnosis until a tick or restore changes state',()=>{
    const simulation=createPlanetAtmosphere(recipe()),state=simulation.checkpoint(),resolution=16,index=4*resolution*resolution+8*resolution+8;
    state.liquid[index]=.1;state.surfaceWater[index]-=.1;simulation.restore(state);
    const center=planetDirection(4,-1+2*8.5/resolution,-1+2*8.5/resolution),occupied=simulation.sample(center),mixed=simulation.sample([0,0,1]),before=simulation.inspection().cloudColumnDiagnosisCount;
    expect(mixed.liquidLowerKgM2).toBeCloseTo(.025,12);expect(mixed.lowerBaseMetersAsl).toBeCloseTo(occupied.lowerBaseMetersAsl,8);expect(mixed.lowerTopMetersAsl).toBeCloseTo(occupied.lowerTopMetersAsl,8);
    for(let i=0;i<20;i++)simulation.sample([0,0,1]);expect(simulation.inspection().cloudColumnDiagnosisCount).toBe(before);
    simulation.advanceTo(simulation.inspection().fixedTickSeconds,1);simulation.sample([0,0,1]);const afterTick=simulation.inspection().cloudColumnDiagnosisCount;expect(afterTick).toBeGreaterThan(before);
    simulation.restore(state);const restored=simulation.sample([0,0,1]);expect(simulation.inspection().cloudColumnDiagnosisCount).toBeGreaterThan(afterTick);expect(restored.lowerBaseMetersAsl).toBeCloseTo(mixed.lowerBaseMetersAsl,8);expect(simulation.inspection().waterMassRelativeError).toBeLessThan(2e-12);
  });
  it('does not lift a lowland cloud because a clear neighboring hill raises interpolated terrain',()=>{
    const simulation=createPlanetAtmosphere(recipe(),d=>({heightMeters:d[0]>0&&d[1]>0?0:3000,waterFraction:d[0]>0&&d[1]>0?1:0})),state=simulation.checkpoint(),index=4*16*16+8*16+8,n=state.airMass.length/2,pressure=physics.gravityMetersPerSecondSquared*(state.airMass[index]+state.airMass[n+index]);
    const vapor=state.airMass[index]*planetAtmosphereSaturationSpecificHumidity(state.surfaceTemperature[index],pressure,physics.meanMolarMassKgPerMol);
    state.surfaceWater[index]-=vapor-state.vapor[index]+.1;state.vapor[index]=vapor;state.liquid[index]=.1;simulation.restore(state);
    const sample=simulation.sample([0,0,1]);expect(sample.liquidLowerKgM2).toBeCloseTo(.025,12);expect(sample.lowerBaseMetersAsl).toBeLessThan(sample.surfaceHeightMetersAsl);expect(sample.lowerBaseMetersAsl).toBeCloseTo(0,6);expect(sample.lowerTopMetersAsl).toBeGreaterThan(sample.lowerBaseMetersAsl);
  });
  it('does not leak vapor across a stably stratified atmosphere merely because six hours passed',()=>{
    const simulation=createPlanetAtmosphere(recipe());const info=finish(simulation,21600);
    expect(info.cloudyAreaFraction).toBeLessThan(.5);expect(info.waterMassRelativeError).toBeLessThan(2e-12);
  },20000);
  it('forms physical condensate and releases latent heat when saturated air cools',()=>{
    const wet=createPlanetAtmosphere(recipe({initialRelativeHumidity:1})),dry=createPlanetAtmosphere(recipe({initialRelativeHumidity:0}));
    expect(wet.inspection().condensedWaterKg).toBe(0);finish(wet,1800);finish(dry,1800);
    expect(wet.inspection().condensedWaterKg).toBeGreaterThan(0);expect(wet.inspection().waterMassRelativeError).toBeLessThan(2e-12);
    expect(wet.sample([0,0,1]).temperatureLowerKelvin).toBeGreaterThan(dry.sample([0,0,1]).temperatureLowerKelvin);
  });
  it.each([{phase:'liquid' as const,temperatureKelvin:290},{phase:'ice' as const,temperatureKelvin:240}])('returns an isolated $phase cloud to vapor in dry air',({phase,temperatureKelvin})=>{
    const simulation=createPlanetAtmosphere(recipe({initialRelativeHumidity:0,surfaceMoisture:0,greenhouseOpticalDepth:0})),state=simulation.checkpoint(),n=state.airMass.length/2,g=physics.gravityMetersPerSecondSquared,kappa=8.314462618/(physics.meanMolarMassKgPerMol*physics.specificHeatJoulesPerKgKelvin),cloudKgM2=.01;
    for(let i=0;i<n;i++){
      // A uniform, stably stratified dry column isolates phase removal from
      // new clouds generated by latitude-dependent heating or ascent.
      state.surfaceTemperature[i]=temperatureKelvin;
      for(let layer=0;layer<2;layer++){const j=i+layer*n,pressure=g*(layer?state.airMass[n+i]*.5:state.airMass[n+i]+state.airMass[i]*.5);state.potentialTemperatureMass[j]=temperatureKelvin*state.airMass[j]/((pressure/physics.surfacePressurePascals)**kappa);}
      state[phase][n+i]=cloudKgM2;(state.surfaceWater[i]>cloudKgM2?state.surfaceWater:state.surfaceIce)[i]-=cloudKgM2;
    }
    simulation.restore(state);finish(simulation,600);const after=simulation.snapshot(),condensate=after.liquid.reduce((sum,v)=>sum+v,0)+after.ice.reduce((sum,v)=>sum+v,0),upperVapor=after.vapor.subarray(n).reduce((sum,v)=>sum+v,0);
    expect(condensate).toBeLessThan(n*cloudKgM2*.05);
    // Precipitation alone must not satisfy this test: water must become vapor.
    expect(upperVapor).toBeGreaterThan(n*cloudKgM2*.9);
    expect(simulation.inspection().waterMassRelativeError).toBeLessThan(2e-12);
  });
  it('clears an existing saturated ice cloud when its air warms, rather than merely with elapsed time',()=>{
    const input=recipe({initialRelativeHumidity:0,surfaceMoisture:0,greenhouseOpticalDepth:0,stellarFluxWattsPerSquareMeter:100}),control=createPlanetAtmosphere(input),warmed=createPlanetAtmosphere(input),state=control.checkpoint(),n=state.airMass.length/2,g=physics.gravityMetersPerSecondSquared,kappa=8.314462618/(physics.meanMolarMassKgPerMol*physics.specificHeatJoulesPerKgKelvin),cloudKgM2=.01;
    for(let i=0;i<n;i++){
      // With transparent lower air, a surface emitting twice the upper
      // layer's blackbody flux balances that layer's two-sided emission.
      state.surfaceTemperature[i]=240*2**.25;
      for(let layer=0;layer<2;layer++){const j=i+layer*n,pressure=g*(layer?state.airMass[n+i]*.5:state.airMass[n+i]+state.airMass[i]*.5);state.potentialTemperatureMass[j]=240*state.airMass[j]/((pressure/physics.surfacePressurePascals)**kappa);}
      const vapor=state.airMass[n+i]*planetAtmosphereSaturationSpecificHumidity(240,g*state.airMass[n+i]*.5,physics.meanMolarMassKgPerMol);
      state.vapor[n+i]=vapor;state.ice[n+i]=cloudKgM2;(state.surfaceWater[i]>vapor+cloudKgM2?state.surfaceWater:state.surfaceIce)[i]-=vapor+cloudKgM2;
    }
    control.restore(state);
    for(let i=0;i<n;i++)state.potentialTemperatureMass[n+i]*=260/240;
    warmed.restore(state);finish(control,600);finish(warmed,600);
    const remaining=(simulation:typeof control)=>simulation.snapshot().ice.subarray(n).reduce((sum,v)=>sum+v,0);
    expect(remaining(control)).toBeGreaterThan(n*cloudKgM2*.9);expect(remaining(warmed)).toBeLessThan(n*cloudKgM2*.05);
    expect(control.inspection().waterMassRelativeError).toBeLessThan(2e-12);expect(warmed.inspection().waterMassRelativeError).toBeLessThan(2e-12);
  });
  it.each([1e-12,.0001])('does not let %s kg/m² of liquid block ice sublimation in the same dry-air tick',(liquidKgM2)=>{
    const input=recipe({initialRelativeHumidity:0,surfaceMoisture:0,greenhouseOpticalDepth:0}),pureIce=createPlanetAtmosphere(input),mixed=createPlanetAtmosphere(input),g=physics.gravityMetersPerSecondSquared,kappa=8.314462618/(physics.meanMolarMassKgPerMol*physics.specificHeatJoulesPerKgKelvin),iceKgM2=.01;
    let n=0;
    for(const simulation of [pureIce,mixed]){
      const state=simulation.checkpoint();n=state.airMass.length/2;
      for(let i=0;i<n;i++){
        state.surfaceTemperature[i]=240;
        for(let layer=0;layer<2;layer++){const j=i+layer*n,pressure=g*(layer?state.airMass[n+i]*.5:state.airMass[n+i]+state.airMass[i]*.5);state.potentialTemperatureMass[j]=240*state.airMass[j]/((pressure/physics.surfacePressurePascals)**kappa);}
        const liquid=simulation===mixed?liquidKgM2:0;state.ice[n+i]=iceKgM2;state.liquid[n+i]=liquid;(state.surfaceWater[i]>iceKgM2+liquid?state.surfaceWater:state.surfaceIce)[i]-=iceKgM2+liquid;
      }
      simulation.restore(state);simulation.advanceTo(simulation.inspection().fixedTickSeconds,1);
    }
    const controlIce=pureIce.snapshot().ice.subarray(n).reduce((sum,v)=>sum+v,0),after=mixed.snapshot(),remainingIce=after.ice.subarray(n).reduce((sum,v)=>sum+v,0);
    // Check the first tick: later freezing of the trace liquid can conceal a
    // branch that wrongly postpones all ice sublimation to the next tick.
    expect(remainingIce).toBeLessThan(n*iceKgM2*.9);expect(remainingIce).toBeLessThan(controlIce*1.02);
    expect(after.vapor.subarray(n).reduce((sum,v)=>sum+v,0)).toBeGreaterThan(n*iceKgM2*.1);
    expect(mixed.inspection().waterMassRelativeError).toBeLessThan(2e-12);
  });
  it('sediments even sub-threshold ice into lower air while conserving the water inventory',()=>{
    const simulation=createPlanetAtmosphere(recipe({initialRelativeHumidity:0,greenhouseOpticalDepth:0})),state=simulation.checkpoint(),n=state.airMass.length/2,g=physics.gravityMetersPerSecondSquared,kappa=8.314462618/(physics.meanMolarMassKgPerMol*physics.specificHeatJoulesPerKgKelvin);
    for(let i=0;i<n;i++){
      // Place the thin ice layer near radiative balance: the black surface
      // supplies twice its thermal emission, avoiding a new-condensation source
      // that would conceal gravitational loss of the original trace inventory.
      state.surfaceTemperature[i]=220*2**.25;state.surfaceIce[i]+=state.surfaceWater[i];state.surfaceWater[i]=0;
      for(let layer=0;layer<2;layer++){const j=i+layer*n,pressure=g*(layer?state.airMass[n+i]*.5:state.airMass[n+i]+state.airMass[i]*.5);state.potentialTemperatureMass[j]=220*state.airMass[j]/((pressure/physics.surfacePressurePascals)**kappa);}
      const pressure=g*state.airMass[n+i]*.5,q=state.airMass[n+i]*planetAtmosphereSaturationSpecificHumidity(220,pressure,physics.meanMolarMassKgPerMol);
      state.vapor[n+i]=q;state.ice[n+i]=.001;state.surfaceIce[i]-=q+.001;
    }
    simulation.restore(state);finish(simulation,21600);const after=simulation.snapshot();
    expect(after.ice.subarray(n).reduce((sum,v)=>sum+v,0)).toBeLessThan(n*.001*.9);
    expect(simulation.inspection().waterMassRelativeError).toBeLessThan(2e-12);
  },20000);
  it('replays the same physical state across host frame rates and independent checkpoint copies',()=>{
    const fast=createPlanetAtmosphere(recipe(),land),slow=createPlanetAtmosphere(recipe(),land),target=900;
    finish(fast,target);for(let t=13;t<target;t+=13)slow.advanceTo(t,2);finish(slow,target);expect(slow.snapshot()).toEqual(fast.snapshot());
    const checkpoint=fast.checkpoint(),copy=createPlanetAtmosphere(recipe(),land);copy.restore(checkpoint);checkpoint.vapor.fill(0);
    finish(copy,1800);finish(fast,1800);expect(copy.snapshot()).toEqual(fast.snapshot());
  });
  it('has one continuous column/material limit at every three-face cube corner',()=>{
    const simulation=createPlanetAtmosphere(recipe(),land),epsilon=1e-9;
    for(const x of [-1,1])for(const y of [-1,1])for(const z of [-1,1]){
      const queries:PlanetVector[]=[[x,y*(1-epsilon),z*(1-epsilon)],[x*(1-epsilon),y,z*(1-epsilon)],[x*(1-epsilon),y*(1-epsilon),z]],samples=queries.map(q=>simulation.sample(q));
      for(const sample of samples.slice(1)){
        expect(Math.hypot(...sample.materialLower.map((v,k)=>v-samples[0].materialLower[k]))*physics.radiusMeters).toBeLessThan(.1);
        expect(sample.temperatureLowerKelvin).toBeCloseTo(samples[0].temperatureLowerKelvin,5);expect(sample.pressurePascals).toBeCloseTo(samples[0].pressurePascals,2);
      }
    }
  });
  it('rejects invalid checkpoints atomically and fingerprints the sampled surface',()=>{
    const simulation=createPlanetAtmosphere(recipe(),land),before=simulation.snapshot(),bad=simulation.checkpoint();bad.airMass[0]=-1;
    expect(()=>simulation.restore(bad)).toThrow(/negative/);expect(simulation.snapshot()).toEqual(before);
    const other=createPlanetAtmosphere(recipe(),()=>({heightMeters:0,waterFraction:0}));expect(other.revision).not.toBe(simulation.revision);expect(()=>other.restore(before)).toThrow(/identity/);
    bad.airMass[0]=Number.NaN;expect(()=>simulation.restore(bad)).toThrow(/invalid field/);
    const future=simulation.checkpoint();future.tick=Number.MAX_SAFE_INTEGER;future.timeSeconds=future.tick*simulation.inspection().fixedTickSeconds;expect(()=>simulation.restore(future)).toThrow(/clock/);
    for(const key of ['absorbedStellarJoules','reflectedStellarJoules','outgoingRadiationJoules'] as const){const negative=simulation.checkpoint();negative[key]=-1;expect(()=>simulation.restore(negative)).toThrow(/physical bounds/);}
    const label=simulation.checkpoint();label.material[0]=label.airMass[0]*1e100;expect(()=>simulation.restore(label)).toThrow(/material labels/);
    const radial=simulation.checkpoint();radial.momentum[0]=radial.airMass[0];expect(()=>simulation.restore(radial)).toThrow(/tangent/);
    const inventories=simulation.checkpoint();inventories.initialTotals=[1,0,0];expect(()=>simulation.restore(inventories)).toThrow(/inventories/);
    expect(simulation.snapshot()).toEqual(before);
  });
  it('propagates an actual pressure perturbation into neighboring momentum instead of evaluating a prescribed storm',()=>{
    const simulation=createPlanetAtmosphere(recipe(),()=>({heightMeters:0,waterFraction:0})),control=createPlanetAtmosphere(recipe(),()=>({heightMeters:0,waterFraction:0})),state=simulation.checkpoint(),n=state.airMass.length/2,index=8*16+8;
    const quantity=state.airMass[index]*.001,opposite=index+16*16;
    for(const [cell,delta]of [[index,quantity],[opposite,-quantity]]){const factor=(state.airMass[cell]+delta)/state.airMass[cell];state.potentialTemperatureMass[cell]*=factor;for(let k=0;k<3;k++)state.material[cell*3+k]*=factor;state.airMass[cell]+=delta;}
    simulation.restore(state);
    simulation.advanceTo(300,32);control.advanceTo(300,32);const next=simulation.snapshot(),baseline=control.snapshot();
    expect(Math.hypot(...[0,1,2].map(k=>next.momentum[(index+1)*3+k]-baseline.momentum[(index+1)*3+k]))).toBeGreaterThan(1);
    expect(next.airMass[index]).toBeLessThan(state.airMass[index]);expect(next.airMass[n+index]).toBeGreaterThan(0);
  });
  it('keeps the solver heating star and rendered celestial star identical through a season',()=>{
    for(const time of [0,physics.rotationPeriodSeconds*.25,physics.orbitalPeriodSeconds*.25,physics.orbitalPeriodSeconds*.75]){
      const actual=samplePlanetAtmosphereCelestial(physics,time),seasonTurns=(physics.orbitalPhaseTurns+time/physics.orbitalPeriodSeconds)%1,expected=samplePlanetCelestial({dayLengthSeconds:physics.rotationPeriodSeconds,axialTiltDegrees:physics.axialTiltDegrees,seasonTurns},time%physics.rotationPeriodSeconds);
      expect(actual).toEqual(expected);
    }
    expect(samplePlanetAtmosphereCelestial(physics,physics.rotationPeriodSeconds*.25).sunDirection[0]).toBeLessThan(0);
  });
  it('preserves inertial speed and reverses Coriolis turning between hemispheres and rotation signs',()=>{
    for(const latitude of [-.6,.6])for(const sign of [-1,1]){
      const d:PlanetVector=[0,Math.sin(latitude),Math.cos(latitude)],north:PlanetVector=[0,Math.cos(latitude),-Math.sin(latitude)],v=rotatePlanetAtmosphereCoriolis([10,0,0],d,sign*2*Math.PI/86400,600);
      expect(Math.hypot(...v)).toBeCloseTo(10,12);expect(Math.sign(v[1]*north[1]+v[2]*north[2])).toBe(-Math.sign(latitude*sign));
    }
  });
  it('makes saturation a temperature/pressure/composition result rather than a coverage slider',()=>{
    const cold=planetAtmosphereSaturationSpecificHumidity(240,60000),warm=planetAtmosphereSaturationSpecificHumidity(290,60000);
    expect(warm).toBeGreaterThan(cold*10);expect(planetAtmosphereSaturationSpecificHumidity(290,120000)).toBeLessThan(warm);
    expect(planetAtmosphereSaturationSpecificHumidity(290,60000,.04401)).toBeLessThan(warm);expect(()=>planetAtmosphereSaturationSpecificHumidity(NaN,60000)).toThrow();
  });
  it('rejects incompatible physical scales, vacuum and unsupported work grids instead of concealing NaNs',()=>{
    expect(()=>createPlanetAtmosphere(recipe({surfacePressurePascals:0}))).toThrow(/surface pressure/);
    expect(()=>createPlanetAtmosphere(recipe({scaleHeightMeters:physics.scaleHeightMeters*2}))).toThrow(/agree/);
    expect(()=>createPlanetAtmosphere(recipe({rotationPeriodSeconds:3600}))).toThrow(/rotation/);
    expect(()=>createPlanetAtmosphere({...recipe(),resolution:128 as 16})).toThrow(/C16/);
    expect(()=>createPlanetAtmosphere(recipe(),()=>({heightMeters:physics.scaleHeightMeters*9,waterFraction:0}))).toThrow(/eight scale/);
  });
});

describe('conservative cloud/dust radiative feedback',()=>{
  const column=():PlanetAtmosphereRadiativeColumn=>({incidentStellarWm2:1000,surfaceAlbedo:.3,surfaceTemperatureKelvin:288,lower:{temperatureKelvin:280,gasOpticalDepth:.6,liquidKgM2:0,iceKgM2:0,dustKgM2:0},upper:{temperatureKelvin:240,gasOpticalDepth:.3,liquidKgM2:0,iceKgM2:0,dustKgM2:0}});
  it('preserves exact absorption, conservative scattering and forward-scattering slab limits',()=>{
    for(const tau of [0,1e-12,.1,1,100,1e8])for(const omega of [0,.5,.99,1])for(const g of [-1,0,.85,1]){
      const layer=planetAtmosphereTwoStreamLayer(tau,omega,g);for(const value of Object.values(layer))expect(value).toBeGreaterThanOrEqual(0);
      expect(layer.reflection+layer.transmission+layer.absorption).toBeCloseTo(1,12);
      if(omega===0){expect(layer.reflection).toBe(0);expect(layer.transmission).toBeCloseTo(Math.exp(-2*tau),12);}if(omega===1)expect(layer.absorption).toBe(0);if(omega===1&&g===1)expect(layer.transmission).toBe(1);
    }
  });
  it('recovers the clear-column stellar budget without atmospheric solar heating',()=>{
    const result=planetAtmosphereRadiativeColumn(column());expect(result.surfaceShortwaveWm2).toBe(700);expect(result.reflectedStellarWm2).toBe(300);expect(result.lowerShortwaveWm2+result.upperShortwaveWm2).toBe(0);expect(Math.abs(result.energyResidualWm2)).toBeLessThan(1e-10);
  });
  it('accounts for both atmospheric absorption and all repeated cloud/surface reflections',()=>{
    for(const albedo of [0,.3,1])for(const incident of [0,1361])for(const water of [1e-10,.001,.1,10])for(const dust of [0,.01,10]){
      const input=column();input.surfaceAlbedo=albedo;input.incidentStellarWm2=incident;input.lower.liquidKgM2=water;input.upper.iceKgM2=water*.7;input.lower.dustKgM2=dust;input.upper.dustKgM2=dust*.1;
      const result=planetAtmosphereRadiativeColumn(input),shortwave=result.surfaceShortwaveWm2+result.lowerShortwaveWm2+result.upperShortwaveWm2+result.reflectedStellarWm2;
      expect(Math.abs(shortwave-incident)).toBeLessThan(1e-9);expect(Math.abs(result.energyResidualWm2)).toBeLessThan(1e-9);
      for(const key of ['surfaceShortwaveWm2','lowerShortwaveWm2','upperShortwaveWm2','reflectedStellarWm2','outgoingLongwaveWm2'] as const)expect(result[key]).toBeGreaterThanOrEqual(0);
      expect(result.lowerEmissivity).toBeLessThanOrEqual(1);expect(result.upperEmissivity).toBeLessThanOrEqual(1);
    }
  });
  it('changes the column energy partition from cloud/dust inventory, including dark-side infrared feedback',()=>{
    const clear=column(),cloud=column();cloud.lower.liquidKgM2=.04;cloud.upper.iceKgM2=.03;const a=planetAtmosphereRadiativeColumn(clear),b=planetAtmosphereRadiativeColumn(cloud);
    expect(b.surfaceShortwaveWm2).toBeLessThan(a.surfaceShortwaveWm2);expect(b.lowerShortwaveWm2).toBeGreaterThan(0);expect(b.upperShortwaveWm2).toBeGreaterThan(0);expect(b.upperEmissivity).toBeGreaterThan(a.upperEmissivity);
    clear.incidentStellarWm2=0;cloud.incidentStellarWm2=0;const nightClear=planetAtmosphereRadiativeColumn(clear),nightCloud=planetAtmosphereRadiativeColumn(cloud);expect(nightCloud.reflectedStellarWm2+nightCloud.surfaceShortwaveWm2+nightCloud.lowerShortwaveWm2+nightCloud.upperShortwaveWm2).toBe(0);expect(nightCloud.outgoingLongwaveWm2).not.toBe(nightClear.outgoingLongwaveWm2);
  });
  it('uses the published liquid absorption coefficient with the correct grams-to-kilograms conversion',()=>{
    const input=column();input.lower.gasOpticalDepth=0;input.lower.liquidKgM2=.001;
    expect(planetAtmosphereRadiativeColumn(input).lowerEmissivity).toBeCloseTo(1-Math.exp(-1.66*.090361),12);
  });
});
