const RV=461.5,FREEZE=273.15,LV=2.5e6,LS=LV+333700;
const bounded=(n:number,key:string,min:number,max:number)=>{if(!Number.isFinite(n)||n<min||n>max)throw Error(`Atmosphere ${key} must be within ${min}..${max}.`);return n;};
/** Existing dilute-water Clausius-Clapeyron primitive shared by simulation and
 * diagnosis. Water/ice saturation is capped at .2; steam atmospheres are outside
 * the noncondensing-background-gas approximation. */
export function planetAtmosphereSaturationSpecificHumidity(temperatureKelvin:number,pressurePascals:number,molarMassKgPerMol=.02897):number {
  bounded(temperatureKelvin,'temperature',80,600);bounded(pressurePascals,'pressure',1e-6,1e9);bounded(molarMassKgPerMol,'molar mass',.002,.2);
  const latent=temperatureKelvin<FREEZE?LS:LV,es=611.657*Math.exp(latent/RV*(1/273.16-1/temperatureKelvin)),epsilon=.01801528/molarMassKgPerMol;
  return es>=pressurePascals?.2:Math.min(.2,epsilon*es/(pressurePascals-(1-epsilon)*es));
}
