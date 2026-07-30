import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environmentMatchGlobs: [['tests/renderer/**', 'jsdom']],
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      reporter: ['text', 'html']
    }
  },
  resolve: {
    alias: {
      '@shared': new URL('./src/shared', import.meta.url).pathname
    }
  }
})
