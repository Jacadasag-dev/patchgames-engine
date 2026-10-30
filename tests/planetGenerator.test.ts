import {describe,it,expect} from 'vitest';
import {compilePlanetGenerator,createPlanetGeneratorRecipe} from '../src/shared/planetGenerator.ts';
import {compileGenerationMaps} from '../src/shared/generationMaps.ts';

describe('physical planet generation',()=>{
  it('derives atmosphere dimensions from thermal state, gravity and gas rather than planet size',()=>{
    const earth=compilePlanetGenerator(createPlanetGeneratorRecipe()),mars=compilePlanetGenerator(createPlanetGeneratorRecipe('marslike'));
    expect(earth.physics.equilibriumTemperatureKelvin).toBeGreaterThan(280);expect(earth.physics.equilibriumTemperatureKelvin).toBeLessThan(295);
    expect(earth.physics.scaleHeightMeters).toBeGreaterThan(8000);expect(earth.physics.scaleHeightMeters).toBeLessThan(9000);
    expect(mars.physics.surfaceDensityKgPerCubicMeter).toBeLessThan(earth.physics.surfaceDensityKgPerCubicMeter*.03);
    expect(mars.physics.scaleHeightMeters).toBeGreaterThan(earth.physics.scaleHeightMeters);
    const doublePressure=compilePlanetGenerator({...earth.recipe,surfacePressurePascals:202650});
    expect(doublePressure.physics.scaleHeightMeters).toBe(earth.physics.scaleHeightMeters);
    expect(doublePressure.physics.surfaceDensityKgPerCubicMeter).toBeCloseTo(earth.physics.surfaceDensityKgPerCubicMeter*2,12);
  });
  it('solves water coverage in the source height field and shares one sea reference',()=>{
    for(const waterCoverage of [0,.25,.71,1]){
      const generated=compilePlanetGenerator({...createPlanetGeneratorRecipe(),waterCoverage});expect(generated.planet.seaLevelMeters).toBe(0);
      expect(Math.abs(generated.diagnostics.waterCoverageMeasured-waterCoverage)).toBeLessThan(.001);
      const fields=compileGenerationMaps(generated.planet.surface.maps),range=fields.output(generated.planet.surface.height).range;
      if(waterCoverage===0)expect(range[0]).toBeGreaterThan(0);if(waterCoverage===1)expect(range[1]).toBeLessThan(0);
      expect(generated.sky.surface).toEqual(generated.planet);
    }
  });
  it('has no author-specified cloud cover, storm count or cloud density',()=>{
    const recipe=createPlanetGeneratorRecipe('stormworld'),generated=compilePlanetGenerator(recipe);
    expect(Object.keys(recipe).some(k=>/cloud|storm/i.test(k))).toBe(false);
    expect(generated.sky.clouds.circulation.coverageTarget).toBe(0);expect(generated.sky.clouds.circulation.cycloneCount).toBe(0);
    expect(Object.values(generated.sky.clouds.layers).every(layer=>!layer.enabled)).toBe(true);
    expect(generated.sky.clouds.godRayStrength).toBe(1);
    expect(generated.recipe).toEqual(recipe);expect(Object.isFrozen(generated.recipe)).toBe(true);
  });
  it('rejects accessor input and physically unsupported spherical configurations',()=>{
    const input=createPlanetGeneratorRecipe();let invoked=false;Object.defineProperty(input,'radiusMeters',{get(){invoked=true;return 1;},enumerable:true});expect(()=>compilePlanetGenerator(input)).toThrow();expect(invoked).toBe(false);
    expect(()=>compilePlanetGenerator({...createPlanetGeneratorRecipe(),rotationPeriodSeconds:3600,radiusMeters:100000000})).toThrow(/centrifugal/);
    expect(()=>compilePlanetGenerator({...createPlanetGeneratorRecipe(),radiusMeters:500000,gravityMetersPerSecondSquared:.3})).toThrow(/extended/);
    expect(()=>compilePlanetGenerator({...createPlanetGeneratorRecipe(),cloudCoverage:.6} as never)).toThrow();
  });
});
