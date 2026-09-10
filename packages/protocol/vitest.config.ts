import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    // Property tests sweep many seeds; give them room.
    testTimeout: 120_000,
  },
})
