import {describe,expect,it} from 'vitest';
import {conservativePlanetSkySampleWeights,integratePlanetPhysicalCloudBin,partitionPlanetCloudRay,planetCloudFeatureMetres,planetCloudOpticalSourceFraction,planetPhysicalCloudProfile,planetPhysicalCloudSourceDistance} from '../src/sandbox/planetSkySampling.ts';

describe('bounded cloud ray quadrature',()=>{
  it('keeps thick self-shadowed radiance independent of optical bin partition',()=>{
    for(const total of [10,30,100])for(const slope of [-2,-1,-.5,0,.25,1,4]){
      const entryLog=slope<0?slope*total:0,rate=1+slope;
      const exact=Math.abs(rate)<1e-10?Math.exp(entryLog)*total:rate>0?Math.exp(entryLog)*(-Math.expm1(-rate*total))/rate:Math.exp(entryLog-rate*total)*(-Math.expm1(rate*total))/(-rate);
      for(const bins of [1,2,7,20,64]){
        const tau=total/bins,fraction=planetCloudOpticalSourceFraction(tau,slope);let radiance=0;
        for(let bin=0;bin<bins;bin++){const prefix=bin*tau,source=prefix+tau*fraction;radiance+=Math.exp(-prefix+entryLog-slope*source)*(-Math.expm1(-tau));}
        expect(Math.abs(radiance-exact)).toBeLessThan(Math.max(1e-14,exact*1e-8));
      }
    }
    const tau=100,point=tau*planetCloudOpticalSourceFraction(tau,1);
    expect(point).toBeCloseTo(Math.log(2),12);expect(Math.exp(-point)*(-Math.expm1(-tau))).toBeCloseTo(.5,12);
  });
  it('bounds source fractions at thin, grazing, and backlit optical limits without overflow',()=>{
    for(const tau of [1e-9,.001,1,10,100,10_000])for(const slope of [-10_000,-2,-1.0000001,-1,-.9999999,-.000001,0,.000001,1,10_000]){
      const fraction=planetCloudOpticalSourceFraction(tau,slope);expect(Number.isFinite(fraction)).toBe(true);expect(fraction).toBeGreaterThanOrEqual(0);expect(fraction).toBeLessThanOrEqual(1);
    }
  });
  it('finds the effective optical source inside thin radial, tangent, and clipped cloud volumes',()=>{
    const radius=6_371_000,base=16_670,top=16_950;
    const paths=[{origin:[0,radius+50_000,0] as const,direction:[0,-1,0] as const,fromMetres:0,toMetres:50_000},{origin:[0,radius+base+50,0] as const,direction:[0,1,0] as const,fromMetres:0,toMetres:1000},{origin:[0,radius+base+100,0] as const,direction:[1,0,0] as const,fromMetres:0,toMetres:100_000}];
    for(const path of paths)for(const upper of [false,true])for(const columnOpticalDepth of [1,10,100,10_000])for(const slope of [0,1,-1]){
      const input={...path,radiusMeters:radius,baseMetersAsl:base,topMetersAsl:top,surfaceMetersAsl:0,columnOpticalDepth,upper},full=integratePlanetPhysicalCloudBin(input),fraction=planetCloudOpticalSourceFraction(full.opticalDepth,slope),point=planetPhysicalCloudSourceDistance(input,fraction);
      expect(point).toBeGreaterThanOrEqual(full.entryMetres);expect(point).toBeLessThanOrEqual(full.exitMetres);
      const amount=integratePlanetPhysicalCloudBin({...input,fromMetres:full.entryMetres,toMetres:point}).opticalDepth,target=full.opticalDepth*fraction;
      expect(Math.abs(amount-target)).toBeLessThan(Math.max(.001,target*.001));
    }
  });
  it('integrates a thin local cloud inside one broad orbital bin without widening its geometry',()=>{
    const radius=6_371_000,base=16_670,top=16_950,optical=2.5,request={radiusMeters:radius,origin:[0,radius+100_000,0] as const,direction:[0,-1,0] as const,fromMetres:0,toMetres:100_000,baseMetersAsl:base,topMetersAsl:top,surfaceMetersAsl:0,columnOpticalDepth:optical};
    for(const upper of [false,true])for(const bins of [1,2,7,20,64]){
      let total=0;for(let bin=0;bin<bins;bin++)total+=integratePlanetPhysicalCloudBin({...request,upper,fromMetres:100_000*bin/bins,toMetres:100_000*(bin+1)/bins}).opticalDepth;
      expect(total).toBeCloseTo(optical,7);
    }
    const result=integratePlanetPhysicalCloudBin({...request,upper:true});expect(result.centroidMetres).toBeGreaterThan(100_000-top);expect(result.centroidMetres).toBeLessThan(100_000-base);
    // The previous point rule sees no cloud at all at these twenty midpoints.
    let pointOptical=0;for(let bin=0;bin<20;bin++)pointOptical+=planetPhysicalCloudProfile((100_000-(bin+.5)*5000-base)/(top-base),true)*5000*optical/(top-base);
    expect(pointOptical).toBe(0);
  });
  it('converges to a fine radial reference through tangent and inside-cloud paths',()=>{
    const radius=6_371_000,base=16_670,top=16_950,optical=.01;
    for(const upper of [false,true])for(const offset of [0,40,140,279]){
      const origin=[-100_000,radius+base+offset,0] as const,direction=[1,0,0] as const,to=200_000,request={radiusMeters:radius,origin,direction,fromMetres:0,toMetres:to,baseMetersAsl:base,topMetersAsl:top,surfaceMetersAsl:0,columnOpticalDepth:optical,upper};
      let reference=0;const count=100_000,step=to/count;
      for(let sample=0;sample<count;sample++){const x=origin[0]+(sample+.5)*step,altitude=Math.hypot(x,origin[1])-radius;reference+=planetPhysicalCloudProfile((altitude-base)/(top-base),upper)*step*optical/(top-base);}
      for(const bins of [1,7,20]){
        let actual=0;for(let bin=0;bin<bins;bin++)actual+=integratePlanetPhysicalCloudBin({...request,fromMetres:to*bin/bins,toMetres:to*(bin+1)/bins}).opticalDepth;
        expect(Math.abs(actual-reference)/reference).toBeLessThan(2e-5);
      }
    }
  });
  it('clips physical cloud optical depth at terrain without lifting or renormalizing hidden mass',()=>{
    const radius=6_371_000,request={radiusMeters:radius,origin:[0,radius+10_000,0] as const,direction:[0,-1,0] as const,fromMetres:0,toMetres:10_000,baseMetersAsl:1000,topMetersAsl:2000,surfaceMetersAsl:0,columnOpticalDepth:1};
    expect(integratePlanetPhysicalCloudBin(request).opticalDepth).toBeCloseTo(1,8);
    const clipped=integratePlanetPhysicalCloudBin({...request,surfaceMetersAsl:1500});expect(clipped.opticalDepth).toBeGreaterThan(0);expect(clipped.opticalDepth).toBeLessThan(1);
    expect(integratePlanetPhysicalCloudBin({...request,surfaceMetersAsl:2000}).opticalDepth).toBe(0);
    expect(integratePlanetPhysicalCloudBin({...request,fromMetres:0,toMetres:1000}).opticalDepth).toBe(0);
  });
  it('keeps all lower and upper optical mass inside their diagnosed local altitude interval',()=>{
    for(const upper of [false,true])for(const [base,top]of [[0,1200],[1700,4200],[6500,6900]]){
      const columnOptical=7.25,count=20_000,step=(top-base)/count;
      let optical=0;for(let i=0;i<count;i++)optical+=columnOptical*planetPhysicalCloudProfile(((base+(i+.5)*step)-base)/(top-base),upper)*step/(top-base);
      expect(optical).toBeCloseTo(columnOptical,7);
      for(const altitude of [-10,base-1,base,top,top+1])expect(planetPhysicalCloudProfile((altitude-base)/(top-base),upper)).toBe(0);
      // Terrain occludes a lowland cloud; clipping its hidden portion must not
      // move that cloud up a mountain or renormalize it into a brighter bank.
      const surface=base+(top-base)*.5;let visible=0;
      for(let i=0;i<count;i++){const altitude=base+(i+.5)*step;if(altitude>surface)visible+=columnOptical*planetPhysicalCloudProfile((altitude-base)/(top-base),upper)*step/(top-base);}
      expect(visible).toBeGreaterThan(0);expect(visible).toBeLessThan(columnOptical);
    }
  });
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
