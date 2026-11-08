import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vitest/config'
import { svelteTesting } from '@testing-library/svelte/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte(), svelteTesting()],
  test: {
    include: ['src/**/*.test.ts', '../../packages/physics/src/**/*.test.ts', '../../packages/rl/src/**/*.test.ts', '../../services/training/bridge/**/*.test.ts'],
  },
})
