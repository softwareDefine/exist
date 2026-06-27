import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

/*
 * 테스트 격리 — db.ts 는 import 시점에 DATA_DIR/exist.sqlite 를 연다.
 * 테스트는 임시 디렉터리의 빈 DB 를 쓰게 해서 개발/실데이터를 건드리지 않는다.
 * (setupFiles 는 테스트 모듈 평가 전에 실행되므로 db.ts 로드 전에 env 가 잡힌다)
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exist-test-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';
