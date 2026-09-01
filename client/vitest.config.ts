import { defineConfig, configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';

// 테스트 전용 설정 — vite.config.ts(dev 프록시·빌드)는 건드리지 않는다
//
// 두 프로젝트:
//   unit    — jsdom. 기존 *.test.{ts,tsx} 전부 (빠름, 대부분의 배선 검증)
//   browser — 진짜 Chromium(Playwright headless). jsdom이 못 띄우는 것만:
//             tiptap(DocEditor)·CodeMirror(CodeDocEditor)·Excalidraw(CanvasBoard)·
//             캔버스/레이아웃에 기대는 SheetEditor·SlideEditor·CollabFiles 흐름
//             → 파일명 *.browser.test.tsx
// 커버리지는 루트 coverage 설정 하나로 두 프로젝트를 합산한다 (v8 — Chromium은 CDP로 수집)
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    restoreMocks: true,
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
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'jsdom',
          pool: 'threads', // forks보다 jsdom 환경 기동이 훨씬 빠름 (Windows)
          setupFiles: ['src/test/setup.ts'],
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: [...configDefaults.exclude, 'src/**/*.browser.test.tsx'],
          // 브라우저 프로젝트와 동시에 돌면 CPU를 나눠 써 무거운 시트 테스트가 15초를 넘길 수 있다
          testTimeout: 30_000,
        },
      },
      {
        extends: true,
        // 첫 실행 때 의존성 발견 → 리로드로 테스트가 깨지지 않게 미리 번들 (Vite 최적화 목록)
        optimizeDeps: {
          include: [
            'react/jsx-dev-runtime',
            'react/jsx-runtime',
            'react-dom/client',
            '@testing-library/dom',
            '@testing-library/jest-dom/vitest',
            'yjs',
            'y-protocols/awareness',
            '@excalidraw/excalidraw',
            '@tiptap/react',
            '@tiptap/core',
            '@tiptap/starter-kit',
            '@tiptap/extension-collaboration',
            '@tiptap/extension-collaboration-caret',
            '@tiptap/extension-image',
            '@tiptap/extension-table',
            '@tiptap/extension-list',
            '@tiptap/extension-text-style',
            '@tiptap/extension-highlight',
            '@tiptap/extension-text-align',
            '@tiptap/extension-mention',
            'codemirror',
            '@codemirror/state',
            '@codemirror/view',
            '@codemirror/commands',
            '@codemirror/language',
            'y-codemirror.next',
            'jszip',
            'zustand',
            'react-router-dom',
            'socket.io-client',
            'mediasoup-client',
          ],
        },
        test: {
          name: 'browser',
          setupFiles: ['src/test/setup.browser.ts'],
          include: ['src/**/*.browser.test.tsx'],
          testTimeout: 30_000,
          browser: {
            enabled: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
            headless: true,
            screenshotFailures: false,
            // 에디터가 레이아웃 폭에 반응(툴바 오버플로·모바일 분기 767px) — 데스크톱 고정
            viewport: { width: 1280, height: 800 },
          },
        },
      },
    ],
  },
});
