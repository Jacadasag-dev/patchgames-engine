import type {GameUiDocument,GameUiNode,GameUiPanel} from './gameUi.ts';
import type {GameSceneSnapshot} from './gameScenes.ts';
import {createGameSceneUi,sceneScopedUi,type SceneUiPlayer} from './gameSceneUi.ts';

export interface HostedGameUiState {
  scene?:GameSceneSnapshot;
  scenePlayers?:readonly SceneUiPlayer[];
  sceneLocalIndex?:number;
  health?:{name:string;value:number;max:number}|null;
  opponent?:{name:string;value:number;max:number}|null;
  timer?:string;
  status?:string;
  /** Trusted camera status also makes gameplay panels read-only for spectators. */
  spectator?:string;
  info?:string;
  announcement?:string;
  reconnecting?:boolean;
  touch?:boolean;
  chatOpen?:boolean;
  viewport?:{width:number;height:number};
}

/** One composition point for game panels and the host's trusted presentation data. */
export function composeHostedGameUi(authored:GameUiDocument|null,state:HostedGameUiState):GameUiDocument{
  authored=sceneScopedUi(authored,state.scene);
  const blocked=!!state.scene&&state.scene.kind!=='gameplay';
  if(blocked){
    authored??=createGameSceneUi(state.scene!,state.scenePlayers??[],state.sceneLocalIndex??-1,!!state.reconnecting);
    state={...state,health:null,opponent:null,timer:'',info:'',announcement:'',spectator:'',status:state.reconnecting?'Connection lost. Reconnecting…':''};
  }
  const readOnly=(nodes:GameUiNode[]):GameUiNode[]=>nodes.map(node=>{
    if(node.kind==='row'||node.kind==='stack')return {...node,children:readOnly(node.children)};
    if(node.kind==='tabs')return {...node,tabs:node.tabs.map(tab=>({...tab,children:readOnly(tab.children)}))};
    if(node.kind==='button')return {...node,disabled:true};
    if(node.kind==='choices')return {...node,action:undefined,items:node.items.map(item=>({...item,disabled:true,action:undefined}))};
    if(node.kind==='grid')return {...node,action:undefined,moveAction:undefined,items:node.items.map(item=>({...item,disabled:true,action:undefined}))};
    return node;
  });
  const panels:GameUiPanel[]=(authored?.panels??[]).filter(panel=>panel.visible!==false&&(!state.chatOpen||panel.presentation!=='modal')
    &&(!state.spectator||panel.presentation!=='modal'&&panel.role!=='store'))
    .map(panel=>{
      if(state.spectator)panel={...panel,onDismiss:undefined,children:readOnly(panel.children)};
      if(panel.role!=='health'||!state.health)return panel;
      let bound=false;
      const bind=(nodes:GameUiNode[]):GameUiNode[]=>nodes.map(node=>{
        if(node.kind==='bar'&&!bound&&(!node.tone||node.tone==='health')){
          bound=true;return {...node,value:state.health!.value,max:state.health!.max};
        }
        if(node.kind==='row'||node.kind==='stack')return {...node,children:bind(node.children)};
        if(node.kind==='tabs')return {...node,tabs:node.tabs.map(tab=>({...tab,children:bind(tab.children)}))};
        return node;
      });
      return {...panel,children:bind(panel.children)};
    });
  const has=(role:GameUiPanel['role'])=>panels.some(panel=>panel.role===role);
  const defaults=authored?.defaults??{};
  if(state.announcement)panels.push({id:'host:announcement',role:'custom',width:220,height:72,priority:-1000,
    children:[{kind:'text',text:state.announcement,heading:true,tone:'accent'}]});
  if(state.health&&defaults.health!==false&&!has('health'))panels.push({
    id:'host:health',role:'health',width:state.touch?176:224,height:68,priority:-20,
    children:[{kind:'bar',label:state.health.name,value:state.health.value,max:state.health.max,tone:'health'}],
  });
  if(state.opponent&&!has('selection'))panels.push({id:'host:opponent',role:'custom',width:176,height:68,priority:-10,
    children:[{kind:'bar',label:state.opponent.name,value:state.opponent.value,max:state.opponent.max,tone:'health'}]});
  if(state.timer&&state.timer!=='0:00'&&defaults.timer!==false&&!has('objective'))panels.push({
    id:'host:timer',role:'objective',width:112,height:52,priority:-20,children:[{kind:'text',text:state.timer,heading:true}],
  });
  const status=state.reconnecting?state.status:state.spectator||state.status;
  if(status&&(state.reconnecting||state.spectator||defaults.status!==false&&!has('status')))panels.push({
    id:'host:status',role:has('status')?'custom':'status',width:state.touch?180:248,height:68,priority:state.reconnecting?-100:-5,
    children:[{kind:'text',text:status,tone:state.reconnecting?'danger':'muted'}],
  });
  // A native UI already describes its game. Legacy hudLines remain an opt-in fallback there.
  if(state.info&&(!authored||defaults.info===true)&&!has('hotbar'))panels.push({id:'host:info',role:'custom',width:248,height:80,
    children:[{kind:'text',text:state.info}]});
  if(!blocked&&defaults.crosshair&&!has('crosshair'))panels.push({id:'host:crosshair',role:'crosshair',width:32,height:32,
    children:[{kind:'crosshair',shape:'ticks',color:'#ffffff',size:20,gap:5,thickness:2,outline:true}]});
  const compact=state.touch||!!state.viewport&&(state.viewport.width<960||state.viewport.height<500);
  if(state.chatOpen)panels.push({id:'host:chat',title:'Chat',role:'chat',presentation:compact?'modal':'hud',
    width:state.touch?420:320,height:320,priority:-80,children:[]});
  return {version:1,panels:blocked?panels.filter(panel=>panel.role!=='crosshair'):panels,scene:authored?.scene,theme:authored?.theme,actions:authored?.actions,defaults};
}
