import {describe,expect,it} from 'vitest';
import {diagnosePlanetCloudColumn,type PlanetCloudColumnInput} from '../src/shared/planetCloudColumn.ts';
import {planetAtmosphereSaturationSpecificHumidity as saturation} from '../src/shared/planetThermodynamics.ts';
const G=9.80665,PS=101325;
function column(humidity=.6):PlanetCloudColumnInput {
  const lowerMass=.72*PS/G,upperMass=.28*PS/G;
  return{physics:{gravityMetersPerSecondSquared:G,meanMolarMassKgPerMol:.02897,specificHeatJoulesPerKgKelvin:1004,scaleHeightMeters:8500},surfaceHeightMetersAsl:0,surfaceTemperatureKelvin:293.15,lower:{airMassKgM2:lowerMass,temperatureKelvin:278,vaporKgM2:lowerMass*saturation(293.15,PS)*humidity,liquidKgM2:0,iceKgM2:0},upper:{airMassKgM2:upperMass,temperatureKelvin:235,vaporKgM2:upperMass*saturation(235,PS*.14)*.99,liquidKgM2:0,iceKgM2:0}};
}
describe('thermodynamic planet cloud column geometry',()=>{
  it('lowers the parcel LCL as actual moisture increases, without spawning cloud mass',()=>{
    const dry=diagnosePlanetCloudColumn(column(0)),low=diagnosePlanetCloudColumn(column(.3)),high=diagnosePlanetCloudColumn(column(.9));
    expect(dry.lclWithinAtmosphere).toBe(false);expect(low.lclWithinAtmosphere).toBe(true);expect(high.lclHeightMetersAgl).toBeLessThan(low.lclHeightMetersAgl);expect(low.lclHeightMetersAgl).toBeGreaterThan(1000);
    for(const result of [dry,low,high]){expect(result.lowerBaseMetersAsl).toBe(result.lowerTopMetersAsl);expect(result.upperBaseMetersAsl).toBe(result.upperTopMetersAsl);expect(result.lowerCloudOrigin).toBe('clear');}
  });
  it('uses the actual gas constant, heat capacity and gravity instead of an Earth lapse-rate shortcut',()=>{
    const earth=column(),weakerGravity=column(),differentGas=column();weakerGravity.physics.gravityMetersPerSecondSquared=G*.5;weakerGravity.lower.airMassKgM2*=2;weakerGravity.upper.airMassKgM2*=2;weakerGravity.lower.vaporKgM2*=2;weakerGravity.upper.vaporKgM2*=2;weakerGravity.physics.scaleHeightMeters*=2;
    const a=diagnosePlanetCloudColumn(earth),b=diagnosePlanetCloudColumn(weakerGravity);expect(b.lclHeightMetersAgl).toBeCloseTo(a.lclHeightMetersAgl*2,6);
    differentGas.physics.meanMolarMassKgPerMol=.04401;differentGas.physics.specificHeatJoulesPerKgKelvin=846;differentGas.physics.scaleHeightMeters=5500;const c=diagnosePlanetCloudColumn(differentGas);expect(Math.abs(c.lclHeightMetersAgl-a.lclHeightMetersAgl)).toBeGreaterThan(50);
  });
  it('responds to actual pressure at the same parcel mixing ratio',()=>{
    const a=column(),b=column();for(const layer of [b.lower,b.upper]){layer.airMassKgM2*=2;layer.vaporKgM2*=2;}
    expect(diagnosePlanetCloudColumn(b).lclHeightMetersAgl).toBeLessThan(diagnosePlanetCloudColumn(a).lclHeightMetersAgl);
  });
  it('uses one effective-q convention for warm moist virtual temperature in both background gases',()=>{
    const q=.12,temperature=350;
    for(const [molar,cp]of [[.02897,1004],[.04401,846]]){
      const input=column();input.physics.meanMolarMassKgPerMol=molar;input.physics.specificHeatJoulesPerKgKelvin=cp;input.surfaceTemperatureKelvin=temperature;
      for(const layer of [input.lower,input.upper]){layer.temperatureKelvin=temperature;layer.vaporKgM2=q*layer.airMassKgM2;}
      const rd=8.314462618/molar,virtualT=temperature*(1+q*(461.5/rd-1)),centerPressure=G*(input.upper.airMassKgM2+input.lower.airMassKgM2*.5),expected=rd*virtualT/G*Math.log(PS/centerPressure),result=diagnosePlanetCloudColumn(input);
      expect(result.lowerBaseMetersAsl).toBeCloseTo(expected,6);expect(result.lclWithinAtmosphere).toBe(true);expect(result.lclHeightMetersAgl).toBeGreaterThan(0);
    }
  });
  it('rejects non-dilute vapor before virtual temperature can become invalid for a light background gas',()=>{
    const input=column();input.physics.meanMolarMassKgPerMol=.002;input.physics.specificHeatJoulesPerKgKelvin=10000;input.lower.vaporKgM2=input.lower.airMassKgM2*2;
    expect(()=>diagnosePlanetCloudColumn(input)).toThrow(/vapor fraction.*0.2/);
    const upper=column();upper.upper.vaporKgM2=upper.upper.airMassKgM2*.201;expect(()=>diagnosePlanetCloudColumn(upper)).toThrow(/vapor fraction/);
  });
  it('accepts the supported vapor boundary with roundoff while retaining separate condensate inventory',()=>{
    const input=column();for(const layer of [input.lower,input.upper])layer.vaporKgM2=layer.airMassKgM2*.2*(1+1e-9);
    expect(Number.isFinite(diagnosePlanetCloudColumn(input).lclHeightMetersAgl)).toBe(true);
    const hydrometeors=column(0);hydrometeors.lower.liquidKgM2=hydrometeors.lower.airMassKgM2*.25;hydrometeors.upper.iceKgM2=hydrometeors.upper.airMassKgM2*.3;const before=structuredClone(hydrometeors),result=diagnosePlanetCloudColumn(hydrometeors);
    expect(result.lowerTopMetersAsl).toBeGreaterThan(result.lowerBaseMetersAsl);expect(result.upperTopMetersAsl).toBeGreaterThan(result.upperBaseMetersAsl);expect(hydrometeors).toEqual(before);
  });
  it('translates geometry from AGL to the actual terrain/water reference altitude',()=>{
    const sea=column(.9),hill=column(.9);sea.lower.liquidKgM2=.1;hill.lower.liquidKgM2=.1;hill.surfaceHeightMetersAsl=2400;
    const a=diagnosePlanetCloudColumn(sea),b=diagnosePlanetCloudColumn(hill);expect(b.lclHeightMetersAgl).toBeCloseTo(a.lclHeightMetersAgl,8);expect(b.lowerBaseMetersAsl-a.lowerBaseMetersAsl).toBeCloseTo(2400,7);expect(b.lowerBaseMetersAsl).toBeGreaterThanOrEqual(2400);
  });
  it('diagnoses upper in-situ cloud independently of the surface parcel',()=>{
    const warm=column(.1),cold=column(.1);warm.upper.iceKgM2=.2;cold.upper.iceKgM2=.2;cold.surfaceTemperatureKelvin=250;
    const a=diagnosePlanetCloudColumn(warm),b=diagnosePlanetCloudColumn(cold);expect(a.upperCloudOrigin).toBe('in-situ');expect(b.upperCloudOrigin).toBe('in-situ');
    // Skin temperature changes the geometric thickness below the upper layer,
    // while its own pressure/temperature sounding and cloud depth remain fixed.
    expect(a.upperTopMetersAsl-a.upperBaseMetersAsl).toBeCloseTo(b.upperTopMetersAsl-b.upperBaseMetersAsl,7);expect(a.lclHeightMetersAgl).not.toBe(b.lclHeightMetersAgl);
  });
  it('bounds upper cloud tops by the available saturated interval and stable upper profile',()=>{
    const thin=column(),thick=column();thin.upper.iceKgM2=.05;thick.upper.iceKgM2=.5;const a=diagnosePlanetCloudColumn(thin),b=diagnosePlanetCloudColumn(thick);
    expect(b.upperTopMetersAsl).toBeGreaterThan(b.upperBaseMetersAsl);expect(b.upperTopMetersAsl).toBeLessThan(thick.physics.scaleHeightMeters*9.21);expect(b.upperTopMetersAsl).toBeGreaterThan(a.upperTopMetersAsl);
  });
  it('retains advected condensate in a finite local pressure bin even when no surface LCL exists',()=>{
    const input=column(0);input.upper.vaporKgM2=0;input.upper.iceKgM2=.01;const before=structuredClone(input),result=diagnosePlanetCloudColumn(input);
    expect(result.lclWithinAtmosphere).toBe(false);expect(result.upperCloudOrigin).toBe('advected');expect(result.upperTopMetersAsl).toBeGreaterThan(result.upperBaseMetersAsl);expect(result.upperTopMetersAsl).toBeLessThan(input.physics.scaleHeightMeters*4);expect(input).toEqual(before);
  });
  it('keeps clipped occupied profiles finite with an explicit numerical-thickness flag',()=>{
    const input=column();input.physics.scaleHeightMeters=1000;input.lower.liquidKgM2=.1;input.upper.iceKgM2=.1;const result=diagnosePlanetCloudColumn(input),limit=input.physics.scaleHeightMeters*9.21;
    expect(result.geometryClipped).toBe(true);for(const [base,top]of [[result.lowerBaseMetersAsl,result.lowerTopMetersAsl],[result.upperBaseMetersAsl,result.upperTopMetersAsl]]){expect(base).toBeGreaterThanOrEqual(0);expect(top).toBeLessThanOrEqual(limit);expect(top-base).toBeGreaterThanOrEqual(1-1e-8);}
  });
});
