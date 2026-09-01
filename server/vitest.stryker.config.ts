import { defineConfig, mergeConfig, configDefaults } from 'vitest/config';
import base from './vitest.config';

/*
 * Stryker(뮤테이션 테스트) 전용 vitest 설정.
 * route-sweep.test.ts 는 src/*.ts 소스를 정규식으로 긁어 라우트를 찾는데,
 * Stryker 가 계측(instrument)한 소스에서는 `router.get('...')` 패턴이 깨져 라우트 절반이 사라진다
 * (dry run 실패). 또한 이 테스트 하나가 모든 라우트를 덮어 거의 모든 뮤턴트의 실행 시간에 얹히므로 제외한다.
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      exclude: [...configDefaults.exclude, 'src/__tests__/route-sweep.test.ts'],
    },
  }),
);
