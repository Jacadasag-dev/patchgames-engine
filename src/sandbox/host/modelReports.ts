import { buildModel, modelFiles } from './build.ts';
import { loadQuickJS, Sandbox } from './quickjs.ts';
import { modelReportSchema, type CustomBuildReport } from '../../shared/customBuildReport.ts';

/** Only imports/bundles sources on the host; all authored expressions run in QuickJS. */
export async function runModelChecks(root: string, report: CustomBuildReport): Promise<void> {
  const files = modelFiles(root);
  report.models = {scope:'src/game/**/*.model.ts',status:'not_run',files:[]};
  if (!files.length) return;
  if (files.length > 32) { report.models.status = 'failed'; throw new Error('At most 32 model definitions per build.'); }
  await loadQuickJS();
  for (const file of files) {
    let sandbox: Sandbox | undefined;
    try {
      sandbox = new Sandbox(buildModel(root,file),['inspect'],{memoryBytes:32*1024*1024,loadMs:1000,maxOutputChars:256*1024});
      const checked = modelReportSchema.parse(sandbox.call('inspect',null,2000).value);
      report.models.files.push({file,report:checked});
    } catch (error) {
      report.models.files.push({file,error:(error instanceof Error ? error.message : String(error)).slice(0,1000)});
    } finally { sandbox?.dispose(); }
  }
  const failed = report.models.files.some(f => f.error || (f.report?.errors ?? 0) > 0);
  report.models.status = failed ? 'failed' : 'passed';
  if (failed) throw new Error('Model geometry checks failed. See validation.models for named parts, poses and attachment diagnostics.');
}
