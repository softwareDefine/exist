import express from 'express';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/*
 * 격리된 코드 실행 서비스.
 *
 * exist 본체(컨테이너)에서 RUNNER_URL 로 위임받아 코드를 실행한다.
 * 이 서비스는 docker-compose 에서 다음과 같이 격리되어 동작한다:
 *   - internal 네트워크(인터넷 차단) → 코드가 외부로 데이터 유출/SSRF 불가
 *   - read_only 루트 + /tmp tmpfs(exec) → 임시 작업만 가능
 *   - cap_drop ALL · no-new-privileges · non-root(nobody) · mem/cpu/pids 제한
 * 따라서 임의 코드가 돌아도 호스트(맥미니)나 exist DB 에는 손댈 수 없다.
 *
 * 항상 리눅스 컨테이너에서만 동작하므로 OS 분기는 두지 않는다.
 */

const app = express();
app.use(express.json({ limit: '4mb' }));

const RUN_TIMEOUT = 12000;
const OUT = 'prog'; // 빌드 산출물 (-o)
const EXE = './prog'; // 실행 명령 (cwd 기준)

/** 언어 → 실행 명령(빌드/런). entry는 상대 경로. */
function commandFor(lang, entry, files) {
  const q = (s) => `"${s}"`;
  const cppFiles = files.filter((f) => /\.(c|cc|cpp|cxx)$/i.test(f.path)).map((f) => q(f.path));
  switch (lang) {
    case 'js':
      return { run: `node ${q(entry)}` };
    case 'py':
      return { run: `python3 ${q(entry)}` };
    case 'ts':
      return { run: `npx --yes tsx ${q(entry)}` };
    case 'c':
      return { build: `gcc ${cppFiles.join(' ')} -o ${OUT}`, run: EXE };
    case 'cpp':
      return { build: `g++ -std=c++17 ${cppFiles.join(' ')} -o ${OUT}`, run: EXE };
    case 'java': {
      const cls = path.basename(entry).replace(/\.java$/, '');
      return { build: `javac ${q(entry)}`, run: `java ${cls}` };
    }
    case 'go':
      return { run: `go run ${q(entry)}` };
    case 'rust':
      return { build: `rustc ${q(entry)} -o ${OUT}`, run: EXE };
    case 'rb':
      return { run: `ruby ${q(entry)}` };
    case 'php':
      return { run: `php ${q(entry)}` };
    default:
      return { error: `${lang} 는 서버 실행을 지원하지 않아요` };
  }
}

function runShell(command, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, RUN_TIMEOUT);
    child.stdout.on('data', (d) => {
      stdout += d.toString();
      if (stdout.length > 100000) child.kill('SIGKILL');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + String(e.message), code: 1, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}

/** 코드 실행 — 임시 디렉터리에 파일 쓰고 빌드/런 */
app.post('/exec', async (req, res) => {
  const { lang, entry, files } = req.body || {};
  if (!lang || !entry || !Array.isArray(files)) {
    return res.status(400).json({ error: '잘못된 요청' });
  }
  const cmd = commandFor(lang, entry, files);
  if ('error' in cmd) {
    return res.json({ lines: [{ type: 'error', text: cmd.error }] });
  }

  const dir = path.join(os.tmpdir(), 'exist-run-' + crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  try {
    // 파일 쓰기 (경로/폴더 보존, 디렉터리 탈출 방지)
    for (const f of files) {
      const safe = path.normalize(f.path).replace(/^(\.\.[/\\])+/, '');
      const full = path.join(dir, safe);
      if (!full.startsWith(dir)) continue;
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, f.content ?? '');
    }

    const lines = [];
    if (cmd.build) {
      const b = await runShell(cmd.build, dir);
      if (b.stderr.trim())
        lines.push({ type: b.code === 0 ? 'warn' : 'error', text: b.stderr.trim() });
      if (b.code !== 0) {
        if (/not (found|recognized)|command not found|'\w+' is not recognized/i.test(b.stderr)) {
          lines.push({
            type: 'error',
            text: `컴파일러를 찾을 수 없어요. 러너에 설치가 필요해요 (${cmd.build.split(' ')[0]}).`,
          });
        }
        lines.push({ type: 'error', text: '✗ 빌드 실패' });
        return res.json({ lines });
      }
    }
    const r = await runShell(cmd.run, dir);
    if (r.stdout)
      lines.push(
        ...r.stdout
          .replace(/\r\n/g, '\n')
          .split('\n')
          .filter((l, i, a) => l !== '' || i < a.length - 1)
          .map((text) => ({ type: 'log', text })),
      );
    if (r.stderr.trim()) {
      if (/not (found|recognized)|command not found|is not recognized/i.test(r.stderr)) {
        lines.push({
          type: 'error',
          text: `실행기를 찾을 수 없어요. 러너에 설치가 필요해요 (${cmd.run.split(' ')[0]}).`,
        });
      } else {
        lines.push({ type: 'error', text: r.stderr.trim() });
      }
    }
    if (r.timedOut) lines.push({ type: 'error', text: `⏱ 시간 초과(${RUN_TIMEOUT / 1000}초)` });
    else lines.push({ type: 'info', text: `✓ 종료 코드 ${r.code ?? 0}` });
    res.json({ lines });
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`[runner] listening on ${PORT}`));
