import {describe,expect,it} from 'vitest';
import {conservativePlanetSkySampleWeights,partitionPlanetCloudRay,planetCloudFeatureMetres} from '../src/sandbox/planetSkySampling.ts';

describe('bounded cloud ray quadrature',()=>{
  it('spends one total quality budget across six crossings without skipping any layer',()=>{
    const segments=[
      {fromMetres:0,toMetres:800,featureMetres:100},
      {fromMetres:1200,toMetres:7000,featureMetres:375},
      {fromMetres:8500,toMetres:12000,featureMetres:82.5},
      {fromMetres:1_000_000,toMetres:1_003_500,featureMetres:82.5},
      {fromMetres:1_005_000,toMetres:1_010_800,featureMetres:375},
      {fromMetres:1_011_200,toMetres:1_012_000,featureMetres:100},
    ];
    for(const budget of [12,20,32]){
      const parts=partitionPlanetCloudRay(segments,budget);
      expect(parts.reduce((sum,part)=>sum+part.edgesMetres.length-1,0)).toBe(budget);
      for(const part of parts){
        expect(part.edgesMetres[0]).toBe(part.fromMetres);expect(part.edgesMetres.at(-1)).toBe(part.toMetres);
        expect(part.edgesMetres.length).toBeGreaterThanOrEqual(2);
        for(let i=1;i<part.edgesMetres.length;i++)expect(part.edgesMetres[i]).toBeGreaterThan(part.edgesMetres[i-1]);
      }
    }
  });
  it('keeps feature and vertical bandwidth in the near scale and resolves thin distant interval metrics',()=>{
    expect(planetCloudFeatureMetres(1500,5800,6_371_000)).toBe(375);
    expect(planetCloudFeatureMetres(1500,800,6_371_000)).toBe(100);
    expect(planetCloudFeatureMetres(1500,3500,6_371_000,true)).toBe(82.5);
    const [part]=partitionPlanetCloudRay([{fromMetres:50_000_000,toMetres:50_000_001,featureMetres:100}],20);
    expect(part.edgesMetres).toHaveLength(21);
    for(let i=0;i<part.edgesMetres.length;i++)expect(part.edgesMetres[i]).toBeCloseTo(50_000_000+i/20,6);
  });
  it('conserves the full optical length of homogeneous volume with nonuniform intervals',()=>{
    const [part]=partitionPlanetCloudRay([{fromMetres:0,toMetres:500_000,featureMetres:375}],20),extinction=1/200_000;
    const transmission=part.edgesMetres.slice(1).reduce((value,end,index)=>value*Math.exp(-extinction*(end-part.edgesMetres[index])),1);
    expect(transmission).toBeCloseTo(Math.exp(-2.5),12);
    expect(part.edgesMetres[1]).toBeLessThan(200);expect(part.edgesMetres.at(-1)!-part.edgesMetres.at(-2)!).toBeGreaterThan(100_000);
  });
  it('retains a nearby continuous 3D puff on a grazing ray at the same twenty-sample budget',()=>{
    const length=500_000,count=20,[part]=partitionPlanetCloudRay([{fromMetres:0,toMetres:length,featureMetres:375}],count),normalization=1/(800*Math.sqrt(2*Math.PI));
    const results:number[]=[];
    // A fixed ellipsoidal cloud at z=1600m. Translate the eye vertically by
    // 25/50/100m; neither cloud coordinates nor the world phase follows the eye.
    for(const height of [0,25,50,100]){
      const density=(z:number)=>normalization*Math.exp(-.5*((z-1600)/800)**2-.5*(height/800)**2);
      let adaptive=0,uniform=0,reference=0;
      for(let i=0;i<count;i++){
        const begin=part.edgesMetres[i],end=part.edgesMetres[i+1],worldPhase=.2+.6*(.5+.5*Math.sin(((begin+end)*.5+height*.1)/1500));
        adaptive+=density(begin+(end-begin)*worldPhase)*(end-begin);
        uniform+=density((i+.5)*length/count)*length/count;
      }
      // A 5m offline reference is bounded to the actual cloud neighbourhood.
      for(let z=0;z<10_000;z+=5)reference+=density(z+2.5)*5;
      expect(Math.abs(adaptive-reference)/reference).toBeLessThan(.15);
      expect(Math.abs(uniform-reference)/reference).toBeGreaterThan(.99);
      results.push(Math.exp(-adaptive));
    }
    expect(Math.max(...results)-Math.min(...results)).toBeLessThan(.004);
  });
  it('rejects unbounded, overlapping or invalid ray requests',()=>{
    expect(()=>partitionPlanetCloudRay([{fromMetres:0,toMetres:10,featureMetres:1}],33)).toThrow(/budget/);
    expect(()=>partitionPlanetCloudRay([{fromMetres:0,toMetres:10,featureMetres:0}],20)).toThrow(/intervals/);
    expect(()=>partitionPlanetCloudRay([{fromMetres:0,toMetres:10,featureMetres:1},{fromMetres:9,toMetres:20,featureMetres:1}],20)).toThrow(/intervals/);
  });
  it('repairs horizon transport using foreground paths without putting clouds behind a near object',()=>{
    expect(conservativePlanetSkySampleWeights(10,[{terminalDepth:100_000,distanceSquared:0},{terminalDepth:-1,distanceSquared:.1}])).toEqual([0,0]);
    expect(conservativePlanetSkySampleWeights(10,[{terminalDepth:9,distanceSquared:.1},{terminalDepth:11,distanceSquared:0},{terminalDepth:-1,distanceSquared:0}])).toEqual([1,0,0]);
    expect(conservativePlanetSkySampleWeights(-1,[{terminalDepth:100_000,distanceSquared:0},{terminalDepth:-1,distanceSquared:1}])).toEqual([0,1]);
    const horizon=conservativePlanetSkySampleWeights(-1,[{terminalDepth:190_000,distanceSquared:0},{terminalDepth:195_000,distanceSquared:1}]);
    expect(horizon.reduce((sum,value)=>sum+value,0)).toBeCloseTo(1);expect(horizon.every(value=>value>0)).toBe(true);
  });
});
