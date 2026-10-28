import { BoundaryError, buildTest, GAME_DIR, GAME_TESTS_DIR, gameTestFiles } from './build.ts';
import { loadQuickJS, Sandbox, SandboxError } from './quickjs.ts';

// Runs the game module's own tests (tests/game) inside the logic sandbox,
// never in Node: they import game code, and game code only ever runs in a
// sandbox. Each test file gets a fresh sandbox, each test its own deadline.

const TEST_MS = 5000;
const LIMITS = { memoryBytes: 64 * 1024 * 1024, loadMs: 5000 };

export interface GameTestResult {
  name: string;
  /** Why the test failed; undefined when it passed. */
  error?: string;
  logs: string[];
}

export interface GameTestFile {
  file: string;
  /** Set when the file couldn't be built or loaded; then no tests ran. */
  error?: string;
  results: GameTestResult[];
}

export async function runGameTests(root: string, gameDir = GAME_DIR, testsDir = GAME_TESTS_DIR, include: (file: string) => boolean = () => true): Promise<GameTestFile[]> {
  await loadQuickJS();
  return gameTestFiles(root, testsDir).filter(include).map((file) => runFile(root, file, gameDir, testsDir));
}

function runFile(root: string, file: string, gameDir: string, testsDir: string): GameTestFile {
  let sandbox: Sandbox;
  try {
    sandbox = new Sandbox(buildTest(root, file, gameDir, testsDir), ['list', 'run'], LIMITS);
  } catch (error) {
    if (error instanceof BoundaryError || error instanceof SandboxError) return { file, error: error.message, results: [] };
    throw error;
  }
  try {
    const names = sandbox.call<unknown>('list', null, TEST_MS).value;
    if (!Array.isArray(names)) return { file, error: 'The test file did not register its tests', results: [] };
    const results = names.slice(0, 500).map((name, index): GameTestResult => {
      const title = String(name).slice(0, 200);
      try {
        return { name: title, logs: sandbox.call('run', index, TEST_MS).logs };
      } catch (error) {
        return { name: title, error: error instanceof Error ? error.message : String(error), logs: error instanceof SandboxError ? error.logs : [] };
      }
    });
    return { file, results };
  } catch (error) {
    return { file, error: error instanceof Error ? error.message : String(error), results: [] };
  } finally {
    sandbox.dispose();
  }
}
