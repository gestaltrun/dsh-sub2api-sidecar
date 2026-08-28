import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    // The supervisor binds real loopback ports and spawns script-backed fakes;
    // serialize the files so port allocation and child-process accounting stay
    // deterministic.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
