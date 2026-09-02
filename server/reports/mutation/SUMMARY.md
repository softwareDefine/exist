# exist server — Stryker mutation testing summary

_Run: 2026-09-01 23:54 → 2026-09-02 02:43 KST on the dev box (i5-12500T, 6P/12T, 15.7 GB RAM with only ~1.3 GB free while running)._

## 1. Setup

| item | value |
|---|---|
| packages | `@stryker-mutator/core@10.0.0`, `@stryker-mutator/vitest-runner@10.0.0` (peer `vitest >=2.0.0`; vitest 4.1.11 works — no command-runner fallback needed) |
| runner | `vitest`, in-process per Stryker worker (`pool: threads`, `maxWorkers: 1`, `bail: 1`), `coverageAnalysis: perTest`, `vitest.related: true` |
| config | `C:\dev\exist\server\stryker.config.json` + `C:\dev\exist\server\vitest.stryker.config.ts` (vitest config used only under Stryker) |
| mutate | `src/**/*.ts` minus `src/__tests__/**`, `src/index.ts`, `src/db.ts` → 30 files, **15,660 mutants** |
| concurrency | **4** (config says 5; 4 used because of RAM). 6 physical cores. |
| timeouts | `timeoutMS 15000`, `timeoutFactor 2`, `dryRunTimeoutMinutes 20` |
| ignoreStatic | **true** (see caveat 2) |
| incremental | on, `reports/mutation/stryker-incremental.json` (batch B reused batch A) |
| batch A | `npx stryker run --mutate "src/recap.ts,src/steward.ts,src/perm.ts,src/llm.ts,src/meetings.ts,src/files.ts,src/handover.ts,src/stt.ts,src/stt-live.ts,src/sfu.ts"` — dry run 1 m 54 s (285 tests), **100 min 20 s** total |
| batch B | `npx stryker run` (full set, incremental) — dry run 2 m 01 s (337 tests), **67 min 57 s** total |
| wall time | **2 h 48 m** of mutation testing (+ ~15 min of two aborted starts, see caveats) |
| outputs | `reports/mutation/mutation.html` + `mutation.json` (merged, final) · `mutation-A.html/json` (batch A snapshot) · `run-A.log`, `run-B.log` · `survivors.txt` (every undetected mutant) · `survived-filtered.txt` (Survived only, no StringLiteral / log-line / static-hybrid) · `coverage/coverage-summary.json` (v8 line coverage of the full suite incl. route sweep) · `vitest-durations.json` (per-file test timings under the Stryker execution model) · `_nocov.mjs` (scratch: clusters NoCoverage mutants into line ranges with the enclosing route) |

### Caveats — read before quoting the score

1. **`route-sweep.test.ts` is excluded under Stryker** (`vitest.stryker.config.ts`). It discovers routes by regex over `src/*.ts` source; Stryker's instrumentation rewrites `router.get('/x'` into a mutant-switch expression, so it found 61 instead of >100 routes and the dry run failed. It is also one giant test touching every route, which would have been appended to almost every mutant's run. Consequence: code that only the sweep executes now shows as **NoCoverage** (4,039 mutants). The sweep asserts nothing beyond `status < 500`, so this is the honest picture.
2. **`ignoreStatic: true`.** Without it Stryker flagged 793 static mutants estimated at 86 % of the run (~8 h ETA). The vitest runner attributes coverage from `beforeAll` hooks to the static bucket, so anything reached only by setup code (org/meeting creation in `beforeAll`) is `Ignored` (641 total) and not scored. "Hybrid" mutants (static + per-test coverage) are still run, but only with runtime activation — top-level `const X = process.env.Y || 'default'` mutants can never be killed that way. Those **259 static-hybrid survivors** (orgs 82, stt 63, meetings 46, auth 27, todos 18, push 11, stt-live 8, ydoc 4) are noise; subtract them mentally.
3. **Timeouts = 47 / 15,019** (0.3 %), counted as killed: filetext 15, files 15, importFile 5, meetings 5, recap 3, agent/llm/rag/steward 1 each. They are `n++`/loop-bound mutations that produce genuine infinite loops. **0 timeouts in realtime/ydoc/sfu suites** — no port/worker flakiness at concurrency 4.
4. The `taskkill /T /F` error at the end of both logs is Stryker failing to kill one worker after the reports were written; harmless. The background shells that launched the runs were killed by the host after ~65 min, but the Stryker processes ran to completion (verified by PID).
5. `dm.ts` and `workspaces.ts` have **no tests at all** apart from the sweep and `db-migrate`.

## 2. Scores (merged, 30 files)

`{"Killed":7906,"Survived":3027,"Timeout":47,"NoCoverage":4039,"RuntimeError":0,"CompileError":0,"Ignored":641}` · valid 15,019
**Mutation score 52.95 %** (killed+timeout / valid) · **covered-only score 72.43 %**

Per file, worst first (score = incl. NoCoverage; covScr = only mutants some test executes; lineCov = v8 line coverage of the full suite incl. sweep):

```
file                    score covScr lineCov killed  surv  tmo nocov total
src/workspaces.ts         0.0    n/a    84.0      0     0    0   151   151
src/dm.ts                 1.3   14.3    86.2      3    18    0   211   232
src/orgs.ts              24.2   72.7    80.4    226    85    0   622   933
src/meetings.ts          30.2   69.2    85.1    717   322    5  1348  2392
src/app.ts               31.0   78.6   100.0     22     6    0    43    71
src/agent.ts             33.2   59.9    85.8    377   253    1   507  1138
src/recap.ts             43.2   57.6    82.8    550   407    3   321  1281
src/handover.ts          46.6   57.7    89.4    213   156    0    88   457
src/stt.ts               53.4   59.1    93.3    269   186    0    49   504
src/auth.ts              57.2   75.3    92.0    265    87    0   111   463
src/steward.ts           57.5   66.7    95.4    654   327    1   158  1140
src/rag.ts               62.2   67.4    92.8    183    89    1    23   296
src/files.ts             64.9   70.9    95.5   1132   470   15   149  1766
src/channels.ts          68.5   84.1    95.7     37     7    0    10    54
src/stt-live.ts          68.8   81.1    90.2    150    35    0    33   218
src/fileai.ts            70.8   75.1    95.8    184    61    0    15   260
src/push.ts              71.6   71.6   100.0     58    23    0     0    81
src/filetext.ts          71.9   75.7    97.3    405   135   15    29   584
src/insights.ts          75.9   79.2   100.0    293    77    0    16   386
src/notifications.ts     80.0   80.0   100.0     24     6    0     0    30
src/positions.ts         80.0   80.0   100.0      8     2    0     0    10
src/sfu.ts               80.4   97.6    82.4    526    13    0   115   654
src/todos.ts             80.5   82.8   100.0    294    61    0    10   365
src/llm.ts               81.2   87.3    88.9     68    10    1     6    85
src/importFile.ts        83.0   83.3   100.0    375    76    5     2   458
src/runner.ts            83.7   84.5   100.0    370    68    0     4   442
src/ydoc.ts              84.4   89.6    95.0    232    27    0    16   275
src/realtime.ts          89.1   90.4    98.8    122    13    0     2   137
src/notify.ts            90.9   90.9   100.0     60     6    0     0    66
src/perm.ts              98.9   98.9   100.0     89     1    0     0    90
```

Survivor buckets (3,027): static-hybrid noise 259 · `console.*` lines 46 · StringLiteral (UI/notification text, prompt fragments) 526 · **meaningful ≈ 2,196** (`survived-filtered.txt`).

## 3. Top 20 surviving mutants that matter

(file:line — original → mutant — the test that is missing)

1. `src/auth.ts:71-79` — `rateLimited()` body → `{}`, `entry.count > MAX_ATTEMPTS` → `false`, `entry.count++` removed — **login / password-reset brute-force limiter has no test**; N+1 failed logins should return 429.
2. `src/meetings.ts:815` — `!canManageMeeting(meeting, uid, 'group:delete')` → `false` — no test that a non-host member gets 403 on `DELETE /api/meetings/:code` (`meeting-delete.test.ts` only deletes as host).
3. `src/meetings.ts:1642-1655` — `if (result.acksReset) { ...13 lines }` → `{}` — a decision correction that changes the sentence must reset signatures and tell signers to re-sign; the whole block is deletable.
4. `src/agent.ts:232-249, 285` — `briefGrounded()`: `!factText.includes(d) → return false` removed, `hit / gb.size >= 0.35`, `if (brief && !briefGrounded(...)) throw` → `false` — the hallucination guard on the home brief can be switched off; needs a test with an AI brief quoting a number/title that is not in the facts.
5. `src/files.ts:278-321` — `notifyFilesChanged()` debounce + `res.on('finish')` middleware → `{}`; `req.method !== 'GET'` → `true` — the `files:changed` socket broadcast after a file mutation is never asserted (a GET-triggers-broadcast regression would pass too).
6. `src/handover.ts:322-323` — `total = ... + cleanChecks.length` → `-`; `if (total === 0) throw` → `false` — publishing an empty handover must be rejected; a checks-only handover must count.
7. `src/handover.ts:344-351` — `for (const p of others) { notifyUser...; invalidateBrief(p.user_id) }` → `{}` — recipients are never checked to receive the handover notification.
8. `src/steward.ts:889` — `if (best < 0 || bestScore < WAKE_MIN) continue` → `false` — the agenda-wake similarity threshold (0.42) has no negative test; any candidate would wake a held item.
9. `src/steward.ts:430-433` — `if (known.has(normTitle(it.title))) continue` → `false` — duplicate agenda items with the same normalised title would be inserted twice.
10. `src/steward.ts:599-601, 687, 712` — `invalidateAgenda()` body → `{}`; cache-TTL comparisons → `true` — closing/changing an item does not have to bust the 10-min agenda/history cache for tests to pass (stale agenda after close).
11. `src/stt.ts:313-316` — chunk sort `ta - tb` → `ta + tb`, comparator body → `{}` — whisper re-transcription order is never checked with two out-of-order chunks; the transcript timeline could scramble silently.
12. `src/stt.ts:142` / `src/files.ts:884` / `src/runner.ts:108` — `size > MAX_CHUNK && !aborted` → `false`, `size > MAX_UPLOAD && !aborted` → `false`, `stdout.length > 100000` boundary — oversize-input protections (413 on audio chunk, 413 on file upload, SIGKILL on runaway stdout) are untested.
13. `src/recap.ts:170-188` — `sameDecision()` (`na.includes(nb)`, bigram Jaccard with `< 8 ? 0.75 : 0.6`) — decision de-dup (`droppedDups`, L666-679) has no test with near-duplicate decisions.
14. `src/recap.ts:48` — `if (!openai || !RECAP_VERIFY || decisions.length === 0) return keepAll` → `true` — the gpt-4o evidence-verification gate can be short-circuited; no test shows verification dropping an unsupported decision through this path.
15. `src/recap.ts:296-303` — next-meeting `{date,time}` validation (`YYYY-MM-DD` regex, `date >= todayKst`, `HH:MM` regex) — an AI-suggested next meeting in the past / malformed is never rejected in a test.
16. `src/meetings.ts:998-1018` — recurrence stepping `weekly +7`, `biweekly +14`, `monthly +1`, `recur_until` cut-off (`y > until → null`) — occurrence expansion has no test per recurrence type.
17. `src/meetings.ts:1581-1590` — `emitLedgerChanged()` body → `{}` — no test asserts the `ledger:changed` socket event after decision ack / edit / withdraw.
18. `src/rag.ts:110-111, 256, 324` — chunking `i += 600`, `chunks.length < 20`, `r.score >= MIN_SCORE` (0.25) → `true` — document chunk size/limit and the "no relevant history below 0.25" floor are unpinned (the floor exists to stop irrelevant evidence injection).
19. `src/ydoc.ts:364-385` — keepalive reaper: `alive = true` on pong, `if (!alive) { closeConn }`, `conn.ping()`, `clearInterval(pingTimer)` all removable — a dead WebSocket is never proven to be reaped.
20. `src/llm.ts:27-31, 54-55` — `extractJson`: `start === -1 → throw 'no json'` → `false`, escape tracking `esc = false → true`, `cut > 0` → `>= 0` — malformed model output (no `{`, escaped quotes) never exercised.

Also worth a test, lower priority: `agent.ts:140-163, 289` (card rules: ongoing → 2, due-soon → 1, today → 0, and the `card === 2 && !hasOngoing` override); `files.ts:118-122` (purge on meeting delete: `deleteYdoc` / `deleteBlob` removable → orphans); `todos.ts:23` (`meeting_id == null → user_id === userId` visibility); `fileai.ts:165` (`prevText !== text` gating of the AI revision summary, 7 mutants); `insights.ts:189` (trend `recentAct > prevAct * 1.15`); `auth.ts:139, 314` (min password length 8); `positions.ts:37` (rank ordering); `realtime.ts:120-121` (4-hour re-welcome gating); `meetings.ts:1048-1126` (schedule-suggest weekend skip / overlap / default 60 min); `handover.ts:448-450, 468, 474` (ack listing fields, ack of nonexistent id, signature validation); `stt.ts:285-292` (live caption emit); `perm.ts:58` (`!role → false`, dangling `role_id` — defensive).

Systemic: the participant/permission guard `if (!r.ok) return res.status(r.status).json(...)` survives in **41 route handlers** codebase-wide — those 403/404 paths run only under the excluded route sweep.

## 4. Executed but not verified (line coverage high, mutation score low)

| file | lineCov (full suite) | score | covScr | what is actually unverified |
|---|---|---|---|---|
| `src/workspaces.ts` | 84.0 % | **0.0 %** | n/a | no tests; every mutant NoCoverage (sweep-only coverage). |
| `src/dm.ts` | 86.2 % | **1.3 %** | 14.3 % | no DM tests; 211/232 NoCoverage. Threads, search, read markers, send — all sweep-only. |
| `src/orgs.ts` | 80.4 % | **24.2 %** | 72.7 % | 622 NoCoverage + 82 static-hybrid: org/role/member routes run only in `beforeAll` setup or under the sweep. `canActOnMember`, role PATCH/DELETE, member approve/remove, team-acks, remind — unverified. |
| `src/meetings.ts` | 85.1 % | **30.2 %** | 69.2 % | 1,348 NoCoverage: `POST /:code/decisions/ack`, invite-on-create, `/recent`, `/inbox`, `/:code/settings`, `/:code/host`, `/:code/thumbnail`, `/:code/decisions/remind`, glossary, agenda status/timeline, channel PATCH/PUT run only under the sweep. |
| `src/app.ts` | 100 % | **31.0 %** | 78.6 % | production branches (static serving, cache headers, error handler) are reached via dynamic import in `beforeAll` → static/NoCoverage. Error handler `status === 400` / `headersSent` survive. |
| `src/agent.ts` | 85.8 % | **33.2 %** | 59.9 % | 507 NoCoverage (`/sent`, `/actions`, `/search`, `/overview`, `/recent-decisions`, `/pending-decisions`) + guard rails (#4) and card rules unpinned. |
| `src/recap.ts` | 82.8 % | **43.2 %** | 57.6 % | tests prove recap runs, not what it decides: de-dup, verification gate, fallback heuristics (L122-137), next-meeting validation. |
| `src/handover.ts` | 89.4 % | **46.6 %** | 57.7 % | publish/ack happy path only; validation, notifications, echo-check thresholds (L540-546) unasserted. |
| `src/stt.ts` | 93.3 % | **53.4 %** | 59.1 % | upload plumbing tested; ordering, size limits, live caption emit, junk filter (L276) not. |
| `src/auth.ts` | 92.0 % | **57.2 %** | 75.3 % | happy-path login/register; rate limiter, reset validation, min length, avatar route (L271-300 NoCoverage). |
| `src/steward.ts` | 95.4 % | **57.5 %** | 66.7 % | lifecycle covered by `llm-steward.test.ts`; cache invalidation, de-dup, wake threshold, status validation free to change. |
| `src/files.ts` | 95.5 % | **64.9 %** | 70.9 % | best of the big files; broadcast middleware, purge, size limit, revision-basis validation (L523-547) are the holes. |
| `src/push.ts`, `src/insights.ts`, `src/todos.ts`, `src/importFile.ts`, `src/runner.ts` | 100 % | 71-84 % | fully executed; survivors are thresholds/arithmetic (insights trend formula, importFile CRLF/bounds, runner stdout cap, todos visibility). |

Contrast: `src/sfu.ts` has only 82.4 % line coverage but a 97.6 % covered-score — the realtime tests genuinely verify what they execute.

## 5. Possible real bugs

No survivor reviewed survived because the production code is wrong; each is a missing assertion. Three items deserve a human look because the mutant would be a silent regression or the code carries a dead guard:

- `src/runner.ts:175, 301` — `if (!full.startsWith(dir)) continue;` survives even though `runner-exec.test.ts:108/253` send `../../escape.txt`. Reason: `path.normalize(f.path).replace(/^(\.\.[/\\])+/, '')` already strips leading `../`, so the `startsWith` guard is unreachable defence-in-depth (equivalent mutant). Fine as is, but the regex is the only effective barrier — keep a test on it.
- `src/files.ts:318-321` — `files:changed` is broadcast only when `res.statusCode < 400 && code`; nothing pins this, so a change that broadcasts on failed writes (or on GET) would pass.
- `src/stt.ts:313-316` — sort key `Number(stem(n).split('-')[1])`: if a chunk filename ever has a different shape the comparator returns `NaN` and order becomes undefined; untested either way.

## 6. How to rerun

```
cd C:\dev\exist\server
npm run test:mutation                         # = stryker run (incremental: only changed files/tests are re-mutated)
npm run test:mutation -- --force              # ignore the incremental file, redo everything (~2 h 50 m at concurrency 4)
npm run test:mutation -- --mutate src/recap.ts,src/steward.ts     # subset
npm run test:mutation -- --concurrency 6      # if the box has RAM to spare
node scripts/mutation-summary.mjs                        # per-file table, worst first
node scripts/mutation-summary.mjs --survivors            # every undetected mutant: orig -> mutant, [LOG]/[STATIC] flags
node scripts/mutation-summary.mjs --survivors --file src/recap.ts
node reports/mutation/_nocov.mjs reports/mutation/mutation.json meetings.ts   # NoCoverage line ranges + enclosing route
```
Open `reports/mutation/mutation.html` in a browser for the interactive report. `.stryker-tmp/` and `stryker.log` are gitignored; `reports/mutation/` (about 35 MB with the incremental file and snapshots) is not — decide whether to commit `SUMMARY.md` only.

Working-tree changes (nothing committed): `.gitignore` (+ `server/.stryker-tmp/`, `server/stryker.log`), `server/package.json` (+ `test:mutation` script, 2 devDependencies), `server/package-lock.json`, `server/stryker.config.json`, `server/vitest.stryker.config.ts`, `server/scripts/mutation-summary.mjs`, `server/reports/mutation/*`. No file under `src/` was modified.

## 7. 9/2 follow-up — survivor-killing tests (compare next run against this list)

13 new test files + 3 extended (suite now 60 files / 426 tests, ~42 s; `npm run test:density` total 6.6). All fixtures are built **inside `it()` bodies** (helper `src/__tests__/helpers/fixtures.ts`) so previously-`Ignored`/static-hybrid mutants in org/meeting setup now get per-test coverage. No production code was changed.

| new/changed test file | survivors it targets (§3/§4 refs) |
|---|---|
| `route-guards.test.ts` | the systemic **41 route guards**: every `canManageMeeting`/`meetingForParticipant`/org-permission gate in `meetings.ts` (settings/period/kick/host/edit/thumbnail/exclude/recaps run/remind/delete #2/events/channels), `orgs.ts` roles CRUD·member approve/reject/remove/patch·tier·team-acks·`canActOnMember` dept scope (§4 orgs), `todos.ts:23` canTouchTodo, agent/meetings `?org=` scope checks — each as outsider 403(+exact body) / member 403 / admin·host 2xx / 404 |
| `auth-limits.test.ts` | #1 `auth.ts:71-79` rateLimited (11th → 429, window edge at exactly resetAt, success reset), reset-flow guards 132-172, password change 306-315 (len-8 boundary, session invalidation), `/me` PATCH validators 226-263 (email/phone regex anchors, slice caps), avatar 271-300 (413 at 5MB+1), `?token=` query auth + 30-day TTL |
| `workspaces.test.ts` | `workspaces.ts` 0% → full CRUD, ctx personal/org, `canTouch` ownership, upload ext sanitising, 20MB boundary (413 / exact-20MB ok) |
| `dm.test.ts` | `dm.ts` 1% → threads/search/unread/with/read, org↔personal scope isolation, non-member 403/peer 404, 2000-char slice, 80-char notification ellipsis, dm:message to both sockets, AI DM reply (scope-filtered decisions payload, no notification) |
| `agent-routes.test.ts` | #4 `agent.ts:232-249,285` briefGrounded (numbers/quoted-titles/bigram 0.35 boundary 7/20 vs 6/20) + ungrounded→rule fallback; card rules 140-163,289; `/sent` `/actions` `/search` (LIKE escape) `/overview` `/recent-decisions` (limit clamp, withdrawn excluded) `/pending-decisions` with exact numbers |
| `meetings-integrity.test.ts` | #3 `meetings.ts:1642-1655` acksReset block (acks/remind_sent deleted, re-confirm notifications, why-only keeps acks), #17 `:1581-1590` emitLedgerChanged (fake io via initNotifier — ack/edit/withdraw/handover-ack, uppercase code, participants only), #16 `:998-1018` recurrence stepping daily/weekly/biweekly/monthly + `recur_until` + `recur_except` + 31d/90d window via GET /schedule, remind cooldown `:1722`, delete purge `files.ts:118-122` (blob/.bin actually gone) |
| `steward-guards.test.ts` | #8 `steward.ts:889` WAKE_MIN (cos 0.41 silent / 0.43 wakes, exact-score embedder), #9 `:430-433` title de-dup + created events, #10 `:599-601,687,712` cache TTL at exactly 10 min (Date.now spy) + invalidateAgenda via edit/withdraw/manual/status/resolve routes |
| `recap-guards.test.ts` | #13 `recap.ts:170-188` sameDecision (0.6 at exactly 9/15, 0.75 short-string, Math.min, number mismatch), #14 `:48` verify gate not called when decisions empty, #15 `:296-303` next-meeting date/time validation (past date, 24:00, 9:30, 09:60, malformed date, today+null time, 80-char title), `:650-700` dropped-dup short-call skip (returns autoId), `:935-1010,1167-1198` edit/withdraw/ack bounds + signature 40k/png checks |
| `llm-recap-verify-off.test.ts` | #14 `recap.ts:48` `!RECAP_VERIFY` branch (off → no verifier call, decisions kept) |
| `handover-guards.test.ts` | #6 `handover.ts:322-323` empty-handover throw + checks counted in total, #7 `:344-351` recipient notifications + brief invalidation, `:334` source mapping, `:448-450,468,474` ack listing fields/nonexistent id/signature validation, `:410-430` sweepHandoverEscalations (2h window, once-only, all-acked silent) |
| `stt-guards.test.ts` | #11 `stt.ts:313-316` chunk ordering (numeric vs alphabetical `999`/`1000`, NaN-key junk skipped+deleted), #12 `:142` 413 at 5MB+1 / exact 5MB ok, `:154` 1000-byte boundary, `:128-133` ts/ext validation, `:285-292` live `voice:caption` emit (room, payload, source 'whisper') |
| `rag-guards.test.ts` | #18 `rag.ts:110-111` 600-char chunks + 20-chunk cap (blob .txt), `:256,324` MIN_SCORE at exactly cos 0.25 (integer-norm vectors — Float32-safe), `:282` closed-agenda 0.5 boundary, top-k ordering |
| `files-broadcast.test.ts` | #5 `files.ts:278-321` files:changed middleware (2xx-non-GET only, 300ms debounce coalescing, participants only, uppercase code, per-code timers), `:884` 25MB upload boundary (413 / blob absent) |
| `ydoc.test.ts` (+1 test) | #19 `ydoc.ts:364-385` keepalive: ping actually sent (client 'ping' events), pong keeps conn alive across ticks, autoPong-off client reaped on 2nd tick, others unaffected |
| `runner-exec.test.ts` (+1 test) | #12 `runner.ts:108` stdout cap boundary (exactly 100,000 survives, 100,001 SIGKILL) |
| `llm.test.ts` (+3 tests) | #20 `llm.ts:14-16,27-31,54-55` model-prefix anchors (`xgpt-5`), 'none' support gate, `no json` throw, escape tracking (`\"` / `\\`), unterminated fallback, cleanAnswer `cut > 0` (leading `"}` kept) |

Known survivors deliberately not chased: `runner.ts:175,301` `startsWith` guard (equivalent — regex strips `../` first, see §5), static-hybrid env-default mutants (§ caveat 2), `console.*`/StringLiteral notification-prose buckets. Note: `agent.ts` defines `GET /recent-decisions` three identical times (lines 708/742/776) — only the first is reachable; dead copies will stay NoCoverage until deduplicated (report finding, not fixed).


## 8. 9/2 재실행 결과 (신규 테스트 77건 반영, 배치 A 170분 + B 24분, concurrency 2)
**전체 52.95% → 66.84%** (covered 72.4 → 74.1%, valid 15,379: killed 10,232 · survived 3,597 · timeout 48 · no-coverage 1,502)
주요 상승: workspaces 0→84.2, dm 1.3→81.6, auth 57.2→85.8, orgs 24.2→61.9, meetings 30.2→59.2, agent 33.2→59.3, handover 46.6→64.5, rag 62.2→74.0, ydoc 84.4→86.2, recap 43.2→53.6, steward 57.5→62.1, stt 53.4→61.7.
남은 바닥: app.ts 24.5(에러 핸들러·정적 서빙 분기 — 대부분 스윕 전용), notifications 61.5, recap 53.6(프롬프트 문자열 변이 노이즈 포함). 문자열/로그 변이를 빼면 실질 검증률은 covered 74% 이상.
