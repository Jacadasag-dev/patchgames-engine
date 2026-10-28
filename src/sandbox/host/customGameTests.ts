import type { CustomBuildReport } from '../../shared/customBuildReport.ts';
import { runGameTests, type GameTestFile } from './gameTests.ts';

function record(summary: CustomBuildReport['tests'] | NonNullable<CustomBuildReport['baselineTests']>, files: GameTestFile[]): void {
  const append = (result: (typeof summary.results)[number]) => {
    if (summary.results.length < 2000) summary.results.push(result);
    else summary.truncated = true;
  };
  for (const file of files) {
    if (file.error) {
      summary.fileErrors++;
      append({ file:file.file.slice(0,300),name:null,status:'failed',error:file.error.slice(0,1000) });
    }
    for (const test of file.results) {
      summary.total++; summary[test.error ? 'failed' : 'passed']++;
      append({ file:file.file.slice(0,300),name:test.name.slice(0,200),status:test.error ? 'failed' : 'passed',
        ...(test.error ? {error:test.error.slice(0,1000)} : {}) });
    }
  }
}

/** All code still executes in bounded QuickJS. Historical gameplay expectations
 * are diagnostic, because custom Duels may intentionally replace those mechanics. */
export async function runCustomGameTests(root: string, report: CustomBuildReport): Promise<void> {
  const historical=(file:string)=>/^tests\/game\/baseline(?:\/|\.test\.ts$)/.test(file);
  record(report.tests, await runGameTests(root, 'src/game', 'tests/game',file=>!historical(file)));
  if (report.baselineTests) {
    const baseline = await runGameTests(root, 'src/game', 'tests/game', historical);
    record(report.baselineTests, baseline);
    report.baselineTests.status = report.baselineTests.failed || report.baselineTests.fileErrors ? 'failed'
      : report.baselineTests.total ? 'passed' : 'not_run';
  }
  if (report.tests.failed || report.tests.fileErrors) {
    throw new Error(report.tests.results.filter(t => t.status === 'failed').map(t => `${t.file}${t.name ? ': ' + t.name : ''}: ${t.error}`).join('\n'));
  }
}
