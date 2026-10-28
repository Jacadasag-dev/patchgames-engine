import { describeError, publish, stringify, takeLogs } from './lockdown.ts';
import { inspectModel, type ModelDefinition } from './model.ts';

export function install(model: ModelDefinition): void {
  publish({ inspect:() => {
    try { return stringify({ok:inspectModel(model),logs:takeLogs()}); }
    catch (error) { return stringify({error:describeError(error),logs:takeLogs()}); }
  } });
}
