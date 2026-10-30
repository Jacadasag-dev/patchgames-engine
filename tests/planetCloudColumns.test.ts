import {describe,it,expect} from 'vitest';
import {compilePlanetSky} from '../src/shared/planetSky.ts';
import {createPlanetRecipe,type PlanetVector} from '../src/shared/planet.ts';

describe('one cloud volume from orbit to surface',()=>{
  it('measures optical columns and keeps every clear column empty at all heights',()=>{
    const R=6371000,sky=compilePlanetSky({kind:'planet-sky',version:1,seed:73,surface:createPlanetRecipe(412,R)},R),sun:PlanetVector=[1,0,0];
    let optical=0,clear=0;
    for(let i=0;i<600;i++){
      const y=1-2*(i+.5)/600,a=i*Math.PI*(3-Math.sqrt(5)),ring=Math.sqrt(1-y*y),d:PlanetVector=[Math.sin(a)*ring,y,Math.cos(a)*ring];
      const support=sky.weather.sample(d,0,sun).support;let tau=0;
      for(const [name,layer]of Object.entries(sky.recipe.clouds.layers))for(let j=0;j<16;j++){
        const p=d.map(n=>n*(R+layer.bottomMeters+(j+.5)*layer.thicknessMeters/16)) as unknown as PlanetVector;
        const density=sky.sampleCloudDensity(p,0,sun);
        if(support===0)expect(density).toBe(0);
        tau+=density*(name==='fog'?4:name==='cumulus'?8:2)/16;
      }
      if(support===0)clear++;if(tau>.02)optical++;
    }
    expect(clear).toBeGreaterThan(150);
    // This is actual frozen-clock volume optical depth, not a separate mask
    // count. A small tolerance allows finite equal-area sampling of boundaries.
    expect(optical/600).toBeGreaterThan(.63);expect(optical/600).toBeLessThan(.71);
  });
  it('uses the same source density at every quality and style, with continuous physical time',()=>{
    const R=80000,source=compilePlanetSky({kind:'planet-sky',version:1,seed:73},R),variants=['low','balanced','high'].flatMap(quality=>['pixel','realistic'].map(style=>compilePlanetSky({...source.recipe,quality,style} as never,R)));
    for(let i=0;i<40;i++){
      const a=i*2.39996,y=1-2*(i+.5)/40,r=Math.sqrt(1-y*y),p:PlanetVector=[Math.sin(a)*r*(R+40),y*(R+40),Math.cos(a)*r*(R+40)];
      const value=source.sampleCloudDensity(p,300,[1,0,0]);
      for(const variant of variants)expect(variant.sampleCloudDensity(p,300,[1,0,0])).toBe(value);
      expect(Math.abs(source.sampleCloudDensity(p,300.00001,[1,0,0])-value)).toBeLessThan(.001);
    }
  });
});
