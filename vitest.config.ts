import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Solidity tests run under Hardhat's node:test runner, not vitest.
    exclude: ['test/contract/**', 'node_modules/**'],
  },
});
