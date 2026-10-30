import {describe,it,expect} from 'vitest';
import {createPlanetCelestialRecipe,samplePlanetCelestial,samplePlanetSunlight,resolvePlanetCelestialRecipe} from '../src/shared/planetCelestial.ts';
describe('body-fixed planet daylight',()=>{
  it('moves sunlight west as the body rotates east without changing source coordinates',()=>{
    const r={...createPlanetCelestialRecipe(),dayLengthSeconds:100};
    expect(samplePlanetCelestial(r,0).sunDirection[0]).toBeCloseTo(0);expect(samplePlanetCelestial(r,0).sunDirection[2]).toBe(1);
    const quarter=samplePlanetCelestial(r,25);expect(quarter.sunDirection[0]).toBeCloseTo(-1);expect(quarter.sunDirection[2]).toBeCloseTo(0);
    expect(samplePlanetCelestial(r,100).sunDirection).toEqual(samplePlanetCelestial(r,0).sunDirection);
    expect(samplePlanetCelestial(r,-25).sunDirection[0]).toBeCloseTo(1);
  });
  it('has opposite solstice declinations and bounded explicit clocks',()=>{
    const r=createPlanetCelestialRecipe();expect(samplePlanetCelestial({...r,seasonTurns:.25},0).declinationRadians).toBeCloseTo(r.axialTiltDegrees*Math.PI/180);
    expect(samplePlanetCelestial({...r,seasonTurns:.75},0).declinationRadians).toBeCloseTo(-r.axialTiltDegrees*Math.PI/180);
    expect(Math.hypot(...samplePlanetCelestial(r,1e9).sunDirection)).toBeCloseTo(1);
    expect(()=>samplePlanetCelestial(r,Infinity)).toThrow();expect(()=>resolvePlanetCelestialRecipe({dayLengthSeconds:0})).toThrow();
    expect(()=>resolvePlanetCelestialRecipe({get phaseTurns():number{throw Error('Accessor executed');}})).toThrow(/accessor/i);
  });
  it('reddens transmitted light near sunset and removes direct sunlight at night',()=>{
    const noon=samplePlanetSunlight([0,0,1],[0,0,1]),sunset=samplePlanetSunlight([0,0,1],[1,0,.04]),night=samplePlanetSunlight([0,0,1],[0,0,-1]);
    expect(noon.visibility).toBe(1);expect(noon.color[0]).toBeCloseTo(1);expect(sunset.color[0]).toBeGreaterThan(sunset.color[2]*3);expect(night.visibility).toBe(0);
  });
});
