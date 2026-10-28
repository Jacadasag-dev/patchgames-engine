import {defineConfig} from 'vitest/config';
import {SANDBOX_NODE_EXEC_ARGV} from './src/sandbox/host/nodeStartup.ts';
export default defineConfig({test:{include:['tests/**/*.test.ts'],pool:'forks',maxWorkers:1,execArgv:[...SANDBOX_NODE_EXEC_ARGV],testTimeout:30000}});
