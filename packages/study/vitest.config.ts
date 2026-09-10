import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
})
