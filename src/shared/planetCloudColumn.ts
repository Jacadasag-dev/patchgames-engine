import type {PlanetAtmospherePhysics} from './planetAtmosphere.ts';
import {planetAtmosphereSaturationSpecificHumidity} from './planetThermodynamics.ts';

export interface PlanetCloudLayerState {airMassKgM2:number;temperatureKelvin:number;vaporKgM2:number;liquidKgM2:number;iceKgM2:number}
export interface PlanetCloudColumnInput {
  physics:Pick<PlanetAtmospherePhysics,'gravityMetersPerSecondSquared'|'meanMolarMassKgPerMol'|'specificHeatJoulesPerKgKelvin'|'scaleHeightMeters'>;
  surfaceHeightMetersAsl:number;surfaceTemperatureKelvin:number;lower:PlanetCloudLayerState;upper:PlanetCloudLayerState;
}
export type PlanetCloudOrigin='clear'|'surface-parcel'|'in-situ'|'advected';
export interface PlanetCloudColumnDiagnosis {
  surfaceHeightMetersAsl:number;lowerBaseMetersAsl:number;lowerTopMetersAsl:number;upperBaseMetersAsl:number;upperTopMetersAsl:number;
  lclHeightMetersAgl:number;lclWithinAtmosphere:boolean;geometryClipped:boolean;
  lowerCloudOrigin:PlanetCloudOrigin;upperCloudOrigin:PlanetCloudOrigin;
}
const RU=8.314462618,RV=461.5,CP_VAPOR=1850,MAX_LOG_PRESSURE=9.21;
const MAX_VAPOR_FRACTION=.2,VAPOR_ROUNDOFF=MAX_VAPOR_FRACTION*1e-8;
const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));
const finite=(v:number,name:string,min:number,max:number)=>{if(!Number.isFinite(v)||v<min||v>max)throw Error(`Cloud column ${name} must be finite in ${min}..${max}.`);return v;};

/** Diagnose vertical geometry without altering or manufacturing cloud mass.
 * Hypsometry uses reconstructed T(log p) and each layer's actual vapor loading.
 * A surface skin-temperature proxy launches the lower parcel; upper clouds are
 * diagnosed in situ from upper-layer thermodynamics, never from that parcel.
 * This is a two-layer reconstruction, not a resolved sounding/CAPE solver. */
export function diagnosePlanetCloudColumn(input:PlanetCloudColumnInput):PlanetCloudColumnDiagnosis {
  const {physics:p,lower,upper}=input,g=finite(p.gravityMetersPerSecondSquared,'gravity',.3,50),molar=finite(p.meanMolarMassKgPerMol,'molar mass',.002,.2),cp=finite(p.specificHeatJoulesPerKgKelvin,'specific heat',500,10000),H=finite(p.scaleHeightMeters,'scale height',10,1e8);
  const topAsl=MAX_LOG_PRESSURE*H,surface=finite(input.surfaceHeightMetersAsl,'surface altitude',0,topAsl-1),surfaceT=finite(input.surfaceTemperatureKelvin,'surface temperature',80,600),rd=RU/molar;
  for(const layer of [lower,upper]){
    finite(layer.airMassKgM2,'air column mass',1e-12,1e9);finite(layer.temperatureKelvin,'air temperature',80,600);for(const key of ['vaporKgM2','liquidKgM2','iceKgM2'] as const)finite(layer[key],key,0,1e9);
    // Saturation and gas-mixture formulas share the solver's dilute effective-q
    // domain. Condensate is separate transported inventory: do not constrain
    // vapor+liquid+ice by this gas-only limit or silently clamp invalid vapor.
    if(layer.vaporKgM2/layer.airMassKgM2>MAX_VAPOR_FRACTION+VAPOR_ROUNDOFF)throw Error('Cloud column vapor fraction exceeds the supported dilute effective-q limit of 0.2.');
  }
  const ps=g*(lower.airMassKgM2+upper.airMassKgM2),pi=g*upper.airMassKgM2,p0=g*(upper.airMassKgM2+lower.airMassKgM2*.5),p1=pi*.5;
  finite(ps,'surface pressure',1e-6,1e9);
  finite(p1,'upper pressure',1e-6,1e9);
  const x0=Math.log(ps/p0),xi=Math.log(ps/pi),x1=Math.log(ps/p1),requestedTop=Math.max(MAX_LOG_PRESSURE,x1+Math.LN2),xt=Math.min(requestedTop,Math.log(ps/1e-6)),xs=[0,x0,xi,x1,xt];
  if(x0<1e-12||xi-x0<1e-12)throw Error('Cloud column pressure layers are numerically degenerate.');
  const temperature=(x:number)=>x<=x0?surfaceT+(lower.temperatureKelvin-surfaceT)*x/x0:x<x1?lower.temperatureKelvin+(upper.temperatureKelvin-lower.temperatureKelvin)*(x-x0)/(x1-x0):upper.temperatureKelvin;
  // Match the existing solver's effective-specific-humidity q convention;
  // mixing-ratio r formulas would disagree with its saturation primitive.
  const virtual=(layer:PlanetCloudLayerState)=>{const q=layer.vaporKgM2/layer.airMassKgM2;return 1+q*(RV/rd-1);};
  const t=xs.map(temperature),z=[surface];
  for(let k=1;k<xs.length;k++)z.push(z[k-1]+rd/g*virtual(k<=2?lower:upper)*(t[k-1]+t[k])*.5*(xs[k]-xs[k-1]));
  const rawHeight=(x:number)=>{
    const value=clamp(x,0,xt);let k=1;while(k<xs.length-1&&value>xs[k])k++;
    const dx=value-xs[k-1],slope=(t[k]-t[k-1])/(xs[k]-xs[k-1]);
    return z[k-1]+rd/g*virtual(k<=2?lower:upper)*(t[k-1]*dx+slope*dx*dx*.5);
  };
  const height=(x:number)=>clamp(rawHeight(x),surface,topAsl);
  let geometryClipped=z[z.length-1]>topAsl||xt<requestedTop;
  const vaporRatio=lower.vaporKgM2/lower.airMassKgM2,parcelR=rd+vaporRatio*(RV-rd),parcelCp=cp+vaporRatio*(CP_VAPOR-cp),parcelKappa=parcelR/parcelCp;
  const parcelLimit=Math.min(xt,Math.max(0,Math.log(surfaceT/80)/parcelKappa));
  const parcelMargin=(x:number)=>vaporRatio-planetAtmosphereSaturationSpecificHumidity(Math.max(80,surfaceT*Math.exp(-parcelKappa*x)),ps*Math.exp(-x),molar);
  let lclX=parcelLimit,lclWithinAtmosphere=false;
  if(vaporRatio>0){
    if(parcelMargin(0)>=0){lclX=0;lclWithinAtmosphere=true;}
    else if(parcelMargin(parcelLimit)>=0){let lo=0,hi=parcelLimit;for(let iteration=0;iteration<28;iteration++){const mid=(lo+hi)*.5;if(parcelMargin(mid)>=0)hi=mid;else lo=mid;}lclX=(lo+hi)*.5;lclWithinAtmosphere=rawHeight(lclX)<=topAsl;}
  }
  const lclHeightMetersAgl=lclWithinAtmosphere?height(lclX)-surface:topAsl-surface;
  function cloudLayer(layer:PlanetCloudLayerState,left:number,center:number,right:number,isLower:boolean):{base:number;top:number;origin:PlanetCloudOrigin} {
    if(layer.liquidKgM2+layer.iceKgM2===0){const centerHeight=height(center);return{base:centerHeight,top:centerHeight,origin:'clear'};}
    const totalWater=(layer.vaporKgM2+layer.liquidKgM2+layer.iceKgM2)/layer.airMassKgM2;
    const margin=(x:number)=>totalWater-planetAtmosphereSaturationSpecificHumidity(temperature(x),ps*Math.exp(-x),molar);
    // Include the actual resolved center and reconstruction knots, so even a
    // narrow newly saturated interval at that center cannot fall between bins.
    const samples=[left,center,right];for(let k=1;k<16;k++)samples.push(left+(right-left)*k/16);for(const knot of xs)if(knot>left&&knot<right)samples.push(knot);samples.sort((a,b)=>a-b);
    const values=samples.map(margin);let anchor=samples.indexOf(center);
    if(values[anchor]<0){anchor=0;for(let k=1;k<values.length;k++)if(values[k]>values[anchor])anchor=k;}
    // If transported droplets persist in subsaturated air during their finite
    // evaporation time, the two-layer model cannot recover their old sounding.
    // Use the central half of this finite-volume pressure bin, not the entire
    // unresolved column to space and not a fixed fraction of scale height.
    const pBottom=ps*Math.exp(-left),pTop=ps*Math.exp(-right);
    let baseX=Math.log(ps/(.75*pBottom+.25*pTop)),topX=Math.log(ps/(.25*pBottom+.75*pTop)),origin:PlanetCloudOrigin='advected';
    if(values[anchor]>=0){
      origin='in-situ';let a=anchor,b=anchor;while(a>0&&values[a-1]>=0)a--;while(b<samples.length-1&&values[b+1]>=0)b++;
      baseX=samples[a];topX=samples[b];
      if(a>0){let lo=samples[a-1],hi=samples[a];for(let iteration=0;iteration<24;iteration++){const mid=(lo+hi)*.5;if(margin(mid)>=0)hi=mid;else lo=mid;}baseX=(lo+hi)*.5;}
      if(b<samples.length-1){let lo=samples[b],hi=samples[b+1];for(let iteration=0;iteration<24;iteration++){const mid=(lo+hi)*.5;if(margin(mid)>=0)lo=mid;else hi=mid;}topX=(lo+hi)*.5;}
      if(isLower&&lclWithinAtmosphere&&lclX>=left&&lclX<topX&&margin(lclX)>=0){baseX=Math.max(baseX,lclX);origin='surface-parcel';}
    }
    let base=height(baseX),top=height(topX);
    if(top-base<1){
      // Only a numerical/finite-atmosphere exception: retain occupied mass in a
      // bounded one-metre bin instead of silently discarding a delta profile.
      const thickness=Math.min(1,topAsl-surface),middle=clamp(height(center),surface+thickness*.5,topAsl-thickness*.5);base=middle-thickness*.5;top=middle+thickness*.5;geometryClipped=true;
    }
    return{base,top,origin};
  }
  const a=cloudLayer(lower,0,x0,xi,true),b=cloudLayer(upper,xi,x1,xt,false);
  return{surfaceHeightMetersAsl:surface,lowerBaseMetersAsl:a.base,lowerTopMetersAsl:a.top,upperBaseMetersAsl:b.base,upperTopMetersAsl:b.top,lclHeightMetersAgl,lclWithinAtmosphere,geometryClipped,lowerCloudOrigin:a.origin,upperCloudOrigin:b.origin};
}
