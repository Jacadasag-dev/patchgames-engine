import { renderSoundPreview } from '../../shared/soundBehaviorPreview.ts';
import type { SoundRenderReply, SoundRenderRequest } from './soundRecipeRendering.ts';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<SoundRenderRequest>) => void) | null;
  postMessage(message: SoundRenderReply, transfer?: Transferable[]): void;
};
scope.onmessage = event => {
  const message = event.data;
  try {
    const sources = new Map(message.sources);
    const sound = renderSoundPreview(message.recipe, { resolveSource: id => sources.get(id) }, message.audition);
    scope.postMessage({ id: message.id, sound }, sound.channels.map(channel => channel.buffer as ArrayBuffer));
  } catch (error) {
    scope.postMessage({ id: message.id, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
  }
};
