import type {GameSceneClientAction,GameSceneSnapshot} from './gameScenes.ts';
import type {GameUiDocument,GameUiEvent,GameUiNode} from './gameUi.ts';

const actions={
  'host:sceneChoose':'choose','host:sceneReady':'ready','host:sceneUnready':'unready',
  'host:sceneSkip':'skip','host:sceneCustom':'custom',
} as const;
export const isSceneUiAction=(name:string)=>Object.hasOwn(actions,name);

/** Scene buttons never enter the gameplay input queue. Their original sequence
 * travels with the click, so an old button cannot act on a newer meeting. */
export function sceneUiIntent(event:GameUiEvent,scene:GameSceneSnapshot|undefined):GameSceneClientAction|undefined{
  if(!scene||scene.kind==='gameplay'||event.sceneSequence!==scene.sequence||!isSceneUiAction(event.name))return;
  return {sequence:scene.sequence,action:actions[event.name as keyof typeof actions],...(event.item!==undefined?{value:event.item}:{})};
}

export function sceneScopedUi(document:GameUiDocument|null,scene:GameSceneSnapshot|undefined):GameUiDocument|null{
  if(document?.scene&&(document.scene.id!==scene?.id||document.scene.sequence!==scene.sequence))return null;
  if(scene&&scene.kind!=='gameplay'&&(!document?.scene||document.scene.id!==scene.id||document.scene.sequence!==scene.sequence))return null;
  return document;
}

export interface SceneUiPlayer {name:string;active?:boolean;team?:number}
/** A usable host fallback exists even when authored presentation is absent,
 * broken, delayed, or does not explicitly belong to the current scene. */
export function createGameSceneUi(scene:GameSceneSnapshot,players:readonly SceneUiPlayer[],localIndex:number,reconnecting=false):GameUiDocument{
  const definition=scene.definition,local=players[localIndex],active=!!local&&local.active!==false&&!reconnecting;
  const ready=scene.ready[localIndex]===true,minimum=scene.elapsedMs>=(definition.minimumMs??0);
  const intent=(name:keyof typeof actions,item?:string)=>({name,sceneSequence:scene.sequence,...(item!==undefined?{item}:{})});
  const children:GameUiNode[]=[{kind:'text',text:scene.kind==='selection'?'Choose your character, then ready up.':scene.kind==='meeting'?'Gameplay is paused for the meeting.':'Cinematic sequence',tone:'muted'}];
  if(definition.durationMs!==undefined)children.push({kind:'text',text:`${Math.max(0,Math.ceil((definition.durationMs-scene.elapsedMs)/1000))}s remaining`,tone:'muted'});
  if(scene.kind==='selection'&&definition.choices?.length)children.push({kind:'choices',label:'Available characters',variant:'portraits',columns:4,searchable:true,
    action:intent('host:sceneChoose'),items:definition.choices.map(choice=>({...choice,selected:scene.choices[localIndex]===choice.id,
      disabled:!active||ready||players.some((player,index)=>index!==localIndex&&player.active!==false&&scene.choices[index]===choice.id
        &&(definition.uniqueChoices==='all'||definition.uniqueChoices==='team'&&player.team===local?.team)),
      action:intent('host:sceneChoose',choice.id)}))});
  if(scene.kind!=='cinematic'){
    children.push({kind:'stack',label:'Participants',children:players.flatMap((player,index)=>player.active===false?[]:[{kind:'text' as const,
      text:`${index===localIndex?'You':player.name} · ${definition.choices?.find(choice=>choice.id===scene.choices[index])?.label??(scene.kind==='selection'?'Choosing':'Present')}${scene.kind==='selection'||definition.skippable?` · ${scene.ready[index]?'Ready':'Not ready'}`:''}`}])});
    if(scene.kind==='selection'||definition.skippable)children.push({kind:'button',label:ready?'Not ready':scene.kind==='selection'?'Ready':'Continue',primary:!ready,
      disabled:!active||!minimum||scene.kind==='selection'&&!!definition.choices?.length&&!scene.choices[localIndex],
      action:intent(ready?'host:sceneUnready':'host:sceneReady')});
  }
  if(definition.skippable)children.push({kind:'button',label:'Vote to skip',disabled:!active||!minimum||ready,action:intent('host:sceneSkip')});
  if(reconnecting)children.push({kind:'text',text:'Reconnecting…',tone:'danger'});
  return {version:1,scene:{id:scene.id,sequence:scene.sequence},defaults:{health:false,timer:false,status:false,info:false,crosshair:false},
    actions:Object.keys(actions).map(name=>({name,label:name.slice(10)})),panels:[{id:'host:game-scene',title:scene.label,
      role:scene.kind==='selection'?'selection':'custom',presentation:'modal',
      ...(scene.kind==='cinematic'?{width:500,height:definition.skippable?190:132}:{width:960,height:650}),children}]};
}
