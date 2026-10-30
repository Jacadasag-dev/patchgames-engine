import {describe,expect,it} from 'vitest';
import {Mesh} from 'three';
import {compileWater,locateWater,prepareWaterWaves,samplePreparedWaterWave,sampleWaterWave,waterAppearance} from '../src/sandbox/water.ts';
import {WaterView} from '../src/sandbox/waterView.ts';

describe('shared prepared water wave spectrum',()=>{
  const water=compileWater({id:'ocean',kind:'ocean',seed:0,windSpeed:8,windDirection:.7,currentSpeed:.4,size:{width:1000,depth:1000},depth:20});
  it('retains the engine three-wave superposition and snapshots weather without per-vertex preparation',()=>{
    const appearance=waterAppearance(water),prepared=prepareWaterWaves(water,0,appearance),point={x:0,z:0},location=locateWater(water,point);
    const sample=samplePreparedWaterWave(prepared,point,location);
    expect(sample.height).toBeCloseTo(appearance.amplitude/3.5*Math.sin(2.17)+appearance.amplitude/6*Math.sin(4.34),12);
    appearance.amplitude=20;appearance.wavelength=.1;appearance.color[0]=1;
    expect(samplePreparedWaterWave(prepared,point,location)).toEqual(sample);
    expect(samplePreparedWaterWave(prepareWaterWaves(water,0,appearance),point,location).height).not.toBe(sample.height);
  });
  it('advects its phase with the engine current without changing its temporal wave source',()=>{
    const point={x:14,z:-9},location=locateWater(water,point),time=37,appearance=waterAppearance(water);
    const moving=sampleWaterWave(water,point,time,appearance,location),shift={x:point.x-time*appearance.currentSpeed*location.flow.x,z:point.z-time*appearance.currentSpeed*location.flow.z};
    const still=sampleWaterWave(water,shift,time,{...appearance,currentSpeed:0},location);
    expect(moving.height).toBeCloseTo(still.height,10);expect(moving.normal.x).toBeCloseTo(still.normal.x,10);expect(moving.normal.z).toBeCloseTo(still.normal.z,10);
  });
  it('keeps existing planar WaterView geometry and queried waves in agreement after spectrum reuse',()=>{
    const view=new WaterView(water,{segments:8,updateHz:30,sampleGround:()=>-20});
    try{
      view.update(5);const geometry=(view.root.children[0] as Mesh).geometry,positions=geometry.getAttribute('position'),normals=geometry.getAttribute('normal');
      for(const i of [0,8,40,80]){
        const point={x:positions.getX(i),z:positions.getZ(i)},expected=sampleWaterWave(water,point,5,waterAppearance(water),locateWater(water,point));
        expect(positions.getY(i)).toBeCloseTo(expected.height,5);expect(normals.getX(i)).toBeCloseTo(expected.normal.x,5);
      }
    }finally{view.dispose();}
  });
});
