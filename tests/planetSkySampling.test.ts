import {describe,expect,it} from 'vitest';
import {conservativePlanetSkySampleWeights,integratePlanetPhysicalCloudBin,partitionPlanetCloudRay,planetCloudFeatureMetres,planetCloudOpticalSourceFraction,planetCloudProfileTopFraction,planetCloudScatteringWeights,planetCloudSlabScatteringResponse,planetPhysicalCloudProfile,planetPhysicalCloudSourceDistance,samplePlanetCloudProfile} from '../src/sandbox/planetSkySampling.ts';
import type {PlanetAtmosphereRenderColumn} from '../src/shared/planetAtmosphereSnapshot.ts';
import {createPlanetSkyNoiseMipmaps} from '../src/sandbox/planetSkyWebGPUMips.ts';

describe('bounded cloud ray quadrature',()=>{
  it('preserves support and optical mass across continuous relief mip footprints',()=>{
    const bytes=new Uint8Array(32**3*4);for(let index=0;index<bytes.length;index++)bytes[index]=Math.imul(index^731,0x5bd1e995)>>>24;
    const mips=createPlanetSkyNoiseMipmaps(bytes),read=(lod:number,channel:number)=>{const lo=Math.floor(lod),hi=Math.min(5,lo+1),fraction=lod-lo;return(mips[lo].data[channel]*(1-fraction)+mips[hi].data[channel]*fraction)/255;};
    const profile=(footprint:number,ice:number)=>{const broadLod=Math.max(0,Math.min(5,Math.log2(Math.max(1,footprint/3000)))),fineLod=Math.max(0,Math.min(5,Math.log2(Math.max(1,footprint/750))));return planetCloudProfileTopFraction(read(broadLod,2),read(fineLod,3),ice);};
    for(const footprint of [0,375,750,1100,1500,2800,3000,4200,6000,12_000,20_000,48_000,96_000])for(const ice of [0,.5,1]){
      const fraction=profile(footprint,ice),base=16_670,top=base+280*fraction,radius=6_371_000;
      expect(fraction).toBeGreaterThanOrEqual(.58+.22*ice-1e-12);expect(fraction).toBeLessThanOrEqual(1);
      const request={radiusMeters:radius,origin:[0,radius+20_000,0] as const,direction:[0,-1,0] as const,fromMetres:0,toMetres:20_000,baseMetersAsl:base,topMetersAsl:top,surfaceMetersAsl:0,columnOpticalDepth:3.25,upper:true};
      expect(integratePlanetPhysicalCloudBin(request).opticalDepth).toBeCloseTo(3.25,7);expect(integratePlanetPhysicalCloudBin({...request,columnOpticalDepth:0}).opticalDepth).toBe(0);
    }
    for(const boundary of [750,1500,3000,6000,12_000,24_000,48_000])expect(Math.abs(profile(boundary*(1+1e-7),1)-profile(boundary*(1-1e-7),1))).toBeLessThan(1e-5);
  });
  it('approaches bright hemispheric cloud reflectance rather than a dim 4pi phase limit',()=>{
    for(const column of [.001,1,20,100,10_000])for(const ice of [0,1])for(const muSun of [.1,.55,.9])for(const muOut of [.1,.5,1]){
      const view=column/muOut,slope=muOut/muSun,source=view*planetCloudOpticalSourceFraction(view,slope),transmission=Math.exp(-slope*source),activation=-Math.expm1(-column),transport=column*(.15+.1*ice),reflection=transport/(1+transport);
      const response=planetCloudSlabScatteringResponse({transmission,columnOpticalDepth:column,observerOpticalDepth:view,selfShadowSlope:slope,sourceOpticalDepth:source,phase:0,solarCosine:muSun,outgoingCosine:muOut,iceOpticalFraction:ice}),radiance=response*(-Math.expm1(-view));
      expect(radiance).toBeCloseTo(activation*muSun*reflection/Math.PI,9);
      if(column===10_000&&muSun===.9)expect(radiance).toBeGreaterThan(.28);
      const passing=1/(1+transport),diffuseTransmission=activation*Math.max(0,passing-Math.exp(-column/muSun));
      expect(activation*reflection+diffuseTransmission+(1-activation)).toBeLessThanOrEqual(1+1e-12);
    }
  });
  it('keeps hemispheric diffuse reflection invariant under optical bin subdivision',()=>{
    for(const column of [1,10,100])for(const muSun of [.1,.55,.9])for(const muOut of [.2,.6,1]){
      const view=column/muOut,slope=muOut/muSun,p=-Math.expm1(-column),transport=column*.15,reference=p*muSun*transport/(1+transport)/Math.PI;
      for(const bins of [1,2,7,20,64]){
        const tau=view/bins;let radiance=0;
        for(let bin=0;bin<bins;bin++){const prefix=bin*tau,source=tau*planetCloudOpticalSourceFraction(tau,slope),transmission=Math.exp(-slope*(prefix+source));radiance+=Math.exp(-prefix)*(-Math.expm1(-tau))*planetCloudSlabScatteringResponse({transmission,columnOpticalDepth:column,observerOpticalDepth:tau,selfShadowSlope:slope,sourceOpticalDepth:source,phase:0,solarCosine:muSun,outgoingCosine:muOut,iceOpticalFraction:0});}
        expect(Math.abs(radiance-reference)).toBeLessThan(Math.max(1e-10,reference*1e-8));
      }
    }
  });
  it('keeps thin diffuse light second-order and limits the backlit escape hemisphere',()=>{
    const diffuse=(column:number)=>{const muSun=.55,muOut=.6,view=column/muOut,slope=muOut/muSun,source=view*planetCloudOpticalSourceFraction(view,slope);return -Math.expm1(-view)*planetCloudSlabScatteringResponse({transmission:Math.exp(-slope*source),columnOpticalDepth:column,observerOpticalDepth:view,selfShadowSlope:slope,sourceOpticalDepth:source,phase:0,solarCosine:muSun,outgoingCosine:muOut,iceOpticalFraction:0});};
    expect(diffuse(.001)/diffuse(.0005)).toBeCloseTo(4,2);
    for(const column of [.001,1,10,100,10_000])for(const muOut of [-.1,-.5,-1]){
      const muSun=.55,view=column/-muOut,slope=muOut/muSun,source=view*planetCloudOpticalSourceFraction(view,slope),transmission=Math.exp(-column/muSun-slope*source),response=planetCloudSlabScatteringResponse({transmission,columnOpticalDepth:column,observerOpticalDepth:view,selfShadowSlope:slope,sourceOpticalDepth:source,phase:0,solarCosine:muSun,outgoingCosine:muOut,iceOpticalFraction:0}),limit=-Math.expm1(-column)*muSun*Math.max(0,1/(1+column*.15)-Math.exp(-column/muSun))/Math.PI;
      expect(Number.isFinite(response)).toBe(true);expect(response).toBeGreaterThanOrEqual(0);expect(response*(-Math.expm1(-view))).toBeLessThanOrEqual(limit+1e-12);
    }
  });
  it('preserves column optical mass while forming relief strictly inside its diagnosed envelope',()=>{
    const radius=6_371_000;
    for(const upper of [false,true])for(const broad of [0,.2,.5,.8,1])for(const detail of [0,.5,1]){
      const fraction=planetCloudProfileTopFraction(broad,detail,upper?1:0),base=upper?16_670:1500,ceiling=upper?16_950:6500,top=base+(ceiling-base)*fraction;
      expect(fraction).toBeGreaterThanOrEqual((upper?.8:.58)-1e-12);expect(fraction).toBeLessThanOrEqual(1);
      expect(top).toBeGreaterThan(base);expect(top).toBeLessThanOrEqual(ceiling);
      const optical=integratePlanetPhysicalCloudBin({radiusMeters:radius,origin:[0,radius+20_000,0],direction:[0,-1,0],fromMetres:0,toMetres:20_000,baseMetersAsl:base,topMetersAsl:top,surfaceMetersAsl:0,columnOpticalDepth:3.25,upper}).opticalDepth;
      expect(optical).toBeCloseTo(3.25,7);
      expect(planetPhysicalCloudProfile((base-1-base)/(top-base),upper)).toBe(0);expect(planetPhysicalCloudProfile((ceiling+1-base)/(top-base),upper)).toBe(0);
    }
  });
  it('keeps rendered relief tied to advected columns and time, independently of the viewer',()=>{
    const noise={size:32,data:new Uint8Array(32**3*4)};let hash=731;
    for(let index=0;index<noise.data.length;index++){hash=Math.imul(hash^hash>>>13,0x5bd1e995);noise.data[index]=hash>>>24;}
    const context={noise,radiusMeters:6_371_000,shapeScaleMeters:1500,timeSeconds:3600,windMetersPerSecond:[7,0,-2] as const};
    const column=(angle:number):PlanetAtmosphereRenderColumn=>({liquidLowerKgM2:1,iceLowerKgM2:0,liquidUpperKgM2:0,iceUpperKgM2:1,dustKgM2:0,materialLower:[Math.sin(angle),0,Math.cos(angle)],materialUpper:[Math.sin(angle),0,Math.cos(angle)],surfaceHeightMetersAsl:0,lowerBaseMetersAsl:1500,lowerTopMetersAsl:6500,upperBaseMetersAsl:16_670,upperTopMetersAsl:16_950});
    const tops:number[]=[];
    for(const angle of [0,.1,.3,.7,1.2]){
      const input=column(angle),result=samplePlanetCloudProfile(input,context),nearby=samplePlanetCloudProfile(column(angle+1e-7),context);
      expect(result).toEqual(samplePlanetCloudProfile(input,context));expect(result.lowerTopMetersAsl).toBe(input.lowerTopMetersAsl);expect(result.iceUpperKgM2).toBe(1);
      expect(result.lowerProfileTopMetersAsl).toBeGreaterThanOrEqual(4400);expect(result.lowerProfileTopMetersAsl).toBeLessThanOrEqual(6500);
      expect(result.upperProfileTopMetersAsl).toBeGreaterThanOrEqual(16_894);expect(result.upperProfileTopMetersAsl).toBeLessThanOrEqual(16_950);
      expect(Math.abs(result.lowerProfileTopMetersAsl-nearby.lowerProfileTopMetersAsl)).toBeLessThan(1);tops.push(result.lowerProfileTopMetersAsl);
    }
    expect(Math.max(...tops)-Math.min(...tops)).toBeGreaterThan(100);
    const clear={...column(0),liquidLowerKgM2:0,iceUpperKgM2:0,lowerBaseMetersAsl:0,lowerTopMetersAsl:0,upperBaseMetersAsl:0,upperTopMetersAsl:0};
    expect(samplePlanetCloudProfile(clear,context)).toMatchObject({lowerProfileTopMetersAsl:0,upperProfileTopMetersAsl:0,liquidLowerKgM2:0,iceUpperKgM2:0});
  });
  it('keeps direct plus normalized diffuse cloud scattering within the incident angular energy budget',()=>{
    for(const transmission of [0,1e-12,.001,.1,.5,.99,1])for(const columnOpticalDepth of [0,.0001,.1,1,100])for(const slope of [-2,-1,0,1,100]){
      const weights=planetCloudScatteringWeights({transmission,columnOpticalDepth,observerOpticalDepth:10,selfShadowSlope:slope,sourceOpticalDepth:10*planetCloudOpticalSourceFraction(10,slope)});
      expect(weights.single).toBe(transmission);expect(weights.multiple).toBeGreaterThanOrEqual(0);expect(weights.single+weights.multiple).toBeLessThanOrEqual(1+1e-12);
      expect(weights.reducedTransmission).toBeGreaterThanOrEqual(transmission);expect(weights.reducedTransmission).toBeLessThanOrEqual(transmission**.25+1e-12);
    }
  });
  it('has no unoccluded cloud ambient floor and approaches single scattering for a thin column',()=>{
    const samples=[1,.1,.001,1e-6,1e-12,0].map(transmission=>planetCloudScatteringWeights({transmission,columnOpticalDepth:100}));
    expect(samples.at(-1)).toEqual({single:0,multiple:0,reducedTransmission:0});
    expect(planetCloudScatteringWeights({transmission:.1,columnOpticalDepth:0}).multiple).toBe(0);
    const multiple=(tau:number)=>planetCloudScatteringWeights({transmission:Math.exp(-tau),columnOpticalDepth:tau}).multiple;
    expect(multiple(.001)/multiple(.0005)).toBeCloseTo(4,2);
    expect(samples[4].multiple).toBeLessThan(samples[3].multiple);expect(samples[3].multiple).toBeLessThan(samples[2].multiple);
  });
  it('keeps diffuse cloud lighting stable under ray partition and signed self-shadow slopes',()=>{
    const eta=.25,iso=1/(4*Math.PI),phase=.04355;
    const integral=(rate:number,length:number,entry:number)=>Math.abs(rate)<1e-10?Math.exp(entry)*length:rate>0?Math.exp(entry)*(-Math.expm1(-rate*length))/rate:Math.exp(entry-rate*length)*(-Math.expm1(rate*length))/(-rate);
    for(const total of [1,10,100])for(const slope of [-2,-1,-.5,0,.25,1,4]){
      const entry=slope<0?slope*total:0,direct=integral(1+slope,total,entry),diffuse=integral(1+eta*slope,total,eta*entry),activation=-Math.expm1(-total),reference=phase*direct+iso*activation*(diffuse-direct);
      for(const bins of [1,2,7,20,64]){
        const tau=total/bins;let radiance=0;
        for(let bin=0;bin<bins;bin++){
          const prefix=bin*tau,source=tau*planetCloudOpticalSourceFraction(tau,slope),transmission=Math.exp(entry-slope*(prefix+source));
          const weights=planetCloudScatteringWeights({transmission,columnOpticalDepth:total,observerOpticalDepth:tau,selfShadowSlope:slope,sourceOpticalDepth:source});
          radiance+=Math.exp(-prefix)*(-Math.expm1(-tau))*(phase*weights.single+iso*weights.multiple);
        }
        // The GPU deliberately bounds log transmission at ~exp(-80). Tiny
        // fully backlit residuals can differ below RGBA16F's smallest value.
        expect(Math.abs(radiance-reference)).toBeLessThan(Math.max(1e-10,Math.abs(reference)*1e-8));
      }
    }
  });
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
