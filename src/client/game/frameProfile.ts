/** Opt-in host measurements. Completion intervals include worker scheduling and
 * GPU backpressure, but are not physical display presentation timestamps. */
export class FrameProfile {
  private samples=new Map<string,number[]>();
  private previous=new Map<string,number>();
  private started=0;
  active=false;
  reason='Ready';
  start(now:number){this.samples.clear();this.previous.clear();this.started=now;this.active=true;this.reason='Sampling';}
  stop(reason='Stopped'){this.active=false;this.reason=reason;}
  interval(name:string,now:number){if(!this.active)return;const previous=this.previous.get(name);this.previous.set(name,now);if(previous!==undefined)this.value(name,now-previous);}
  value(name:string,ms:number){if(!this.active||!Number.isFinite(ms)||ms<0)return;let values=this.samples.get(name);if(!values){values=[];this.samples.set(name,values);}if(values.length<10000)values.push(ms);else this.stop('Sample limit reached');}
  report(now:number){return {status:this.reason,elapsedMs:Math.round(now-this.started),metric:'host intervals and worker CPU; not physical display FPS',
    samples:Object.fromEntries([...this.samples].map(([name,values])=>{
      const sorted=[...values].sort((a,b)=>a-b),percentile=(p:number)=>sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]??0;
      return [name,{count:values.length,p50:percentile(.5),p95:percentile(.95),p99:percentile(.99),max:sorted.at(-1)??0,over33:values.filter(v=>v>33.34).length,over50:values.filter(v=>v>50).length}];
    }))};}
}
