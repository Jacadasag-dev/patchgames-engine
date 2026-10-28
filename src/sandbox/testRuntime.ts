import { describeError, parse, publish, stringify, takeLogs } from './lockdown.ts';
import { registeredTests } from './testkit.ts';

// Runs inside the QuickJS sandbox after one game test file has registered
// its tests. The host lists them, then runs each one with its own time limit.

export function install(): void {
  publish({
    list: () => stringify({ ok: registeredTests().map((test) => test.name), logs: takeLogs() }),
    run: (json) => {
      const index = parse(json) as number;
      const test = registeredTests()[index];
      let error: string | undefined;
      try {
        if (!test) throw new Error(`No test #${index}`);
        test.run();
      } catch (thrown) {
        error = describeError(thrown);
      }
      return stringify(error === undefined ? { ok: true, logs: takeLogs() } : { error, logs: takeLogs() });
    },
  });
}
