import {createRecipeMaterial} from '../src/sandbox/materialRecipes.ts';
import {expect,it} from 'vitest';import {installStarterMedia} from '../src/sandbox/starterMedia.ts';import {resolveTextureSource} from '../src/sandbox/media.ts';
it('provides starter material pixels without a host transport',async()=>{const dispose=installStarterMedia();try{const source=await resolveTextureSource('texture.white-plaster');expect(source.color.data.length).toBe(source.color.width*source.color.height*4);expect(source.color.width).toBe(128);}finally{dispose();}});

it('composes a starter material without the hosted media bridge',async()=>{const dispose=installStarterMedia();try{const value=await createRecipeMaterial({kind:'texture',version:1,name:'Starter plaster',resolution:16,layers:[{source:{kind:'asset',id:'texture.white-plaster'}}]});expect(value.maps.color.image.width).toBe(16);value.dispose();}finally{dispose();}});
