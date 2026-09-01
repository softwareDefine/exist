import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// 테스트 전용 설정 — vite.config.ts(dev 프록시·빌드)는 건드리지 않는다
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    pool: 'threads', // forks보다 jsdom 환경 기동이 훨씬 빠름 (Windows)
    setupFiles: ['src/test/setup.ts'],
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary'],
      reportOnFailure: true,
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/main.tsx',
        'src/assets/**',
        'src/test/**',
        'src/**/*.test.{ts,tsx}',
        'src/**/*.d.ts',
      ],
    },
  },
});
