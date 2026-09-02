import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useAuthStore } from '../store';
import { getSocket } from '../lib/socket';
import { useDisplayName } from '../names';
import { CheckMarkIcon, ExclaimIcon, SparklesIcon, RefreshIcon } from './Icons';
import PillSeg from './PillSeg';
import HandoverPanel from './HandoverPanel';
import MeetingArchive from './MeetingArchive';
import SignPad from './SignPad';
import { keyActivate, keyStopPropagation } from '../lib/a11y';

/*
 * 결정 원장 — 이 그룹의 모든 통화 결정이 시간순으로 쌓이는 타임라인.
 * "결정이 사람이 아니라 조직에 남는다." 새 recap이 생기면 실시간 갱신.
 * 수신 확인(회람 사인): 각 결정에 "확인"을 남기면 누가 확인했는지 쌓인다.
 */

interface LedgerEntry {
  recapId: number;
  idx: number;
  decision: string;
  /** 결정 배경 한 줄 — 없으면 '' (실무자 인터뷰: 배경 유실이 진짜 페인) */
  why?: string;
  /** 검토됐지만 채택되지 않은 대안 ("대안 — 기각 사유") — 같은 검토의 반복 방지 */
  alts?: string[];
  /** 🔴 작업 전 확인 필수 — 확인 시 손 서명 요구 */
  critical?: boolean;
  attendees: string[];
  ts: number;
  acks: { username: string; ts: number; note?: string | null; signature?: string | null }[];
  /** 이 recap에서 파생된 할 일 — 결정이 실행됐는지 추적 */
  todos?: { title: string; done: number }[];
  /** 이 결정을 근거로 발행된 문서 개정들 — 결정→문서 다리 */
  revisedFiles?: { id: number; rev: number; name: string }[];
  /** 철회됨 — 지우지 않고 사유와 함께 남는다 */
  withdrawn?: { reason: string; by: string; at: number } | null;
  /** 정정 횟수 (관리자가 AI 문장을 고친 횟수) */
  revisions?: number;
}

interface DecisionRevision {
  id: number;
  kind: 'edit' | 'withdraw';
  prevDecision: string | null;
  prevWhy: string | null;
  newDecision: string | null;
  newWhy: string | null;
  reason: string;
  prevAcks: string[];
  editor: string;
  ts: number;
}

function dateLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
}

interface HistoryTopic {
  title: string;
  entries: { recapId: number; idx: number; decision: string; why: string; ts: number }[];
}

interface DecisionHistory {
  topics: HistoryTopic[];
  source: 'ai' | 'rule';
  generatedAt: number;
}

export default function DecisionLedger({ code, canManage }: { code: string; canManage?: boolean }) {
  const user = useAuthStore((s) => s.user);
  // 정정·철회 — 관리자의 인간 감독. 지우지 않고 이력으로 남긴다
  const [editFor, setEditFor] = useState<LedgerEntry | null>(null);
  const [editText, setEditText] = useState('');
  const [editWhy, setEditWhy] = useState('');
  const [editReason, setEditReason] = useState('');
  const [wdFor, setWdFor] = useState<LedgerEntry | null>(null);
  const [wdReason, setWdReason] = useState('');
  const [revFor, setRevFor] = useState<string | null>(null);
  const [revs, setRevs] = useState<DecisionRevision[]>([]);
  const [busy, setBusy] = useState(false);
  // ⋯ 오버플로 메뉴 — 파괴적 액션(정정·철회)의 진입점. 조회성 "정리 보기"와 같은 줄에
  // 나란히 두면 슬립 한 번 거리라 메뉴 뒤로 격리 (9/3, design-0902 결함 #4)
  const [moreFor, setMoreFor] = useState<string | null>(null);

  // 메뉴 밖 아무 곳이나 클릭하면 닫기
  useEffect(() => {
    if (!moreFor) return;
    const close = () => setMoreFor(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [moreFor]);

  function openEdit(e: LedgerEntry) {
    setEditFor(e);
    setEditText(e.decision);
    setEditWhy(e.why ?? '');
    setEditReason('');
  }
  async function submitEdit() {
    if (!editFor || busy) return;
    const reason = editReason.trim();
    if (!reason) {
      window.dispatchEvent(new CustomEvent('app:error', { detail: '정정 사유를 적어주세요' }));
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ ok: true; acksReset: boolean }>(
        `/api/meetings/${code}/decisions/${editFor.recapId}/${editFor.idx}`,
        { method: 'PATCH', body: { decision: editText, why: editWhy, reason } },
      );
      window.dispatchEvent(
        new CustomEvent('app:info', {
          detail: r.acksReset ? '정정했어요 — 문장이 바뀌어 참가자에게 재확인을 요청했어요' : '배경을 정정했어요',
        }),
      );
      setEditFor(null);
      load();
    } catch (err) {
      window.dispatchEvent(new CustomEvent('app:error', { detail: (err as Error).message }));
    } finally {
      setBusy(false);
    }
  }
  async function submitWithdraw() {
    if (!wdFor || busy) return;
    const reason = wdReason.trim();
    if (!reason) {
      window.dispatchEvent(new CustomEvent('app:error', { detail: '철회 사유를 적어주세요' }));
      return;
    }
    setBusy(true);
    try {
      await api(`/api/meetings/${code}/decisions/${wdFor.recapId}/${wdFor.idx}/withdraw`, {
        method: 'POST',
        body: { reason },
      });
      window.dispatchEvent(new CustomEvent('app:info', { detail: '철회했어요 — 원장에 사유와 함께 남아요' }));
      setWdFor(null);
      load();
    } catch (err) {
      window.dispatchEvent(new CustomEvent('app:error', { detail: (err as Error).message }));
    } finally {
      setBusy(false);
    }
  }
  async function toggleRevisions(e: LedgerEntry) {
    const key = `${e.recapId}-${e.idx}`;
    if (revFor === key) {
      setRevFor(null);
      return;
    }
    setRevFor(key);
    setRevs([]);
    try {
      setRevs(await api<DecisionRevision[]>(`/api/meetings/${code}/decisions/${e.recapId}/${e.idx}/revisions`));
    } catch {
      setRevs([]);
    }
  }
  const dn = useDisplayName();
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [query, setQuery] = useState('');
  // 변경 이력 뷰 — 같은 주제 결정의 변천 (AI 그룹핑, 현직자 요구 "변경사항 이력 관리")
  // handover = 교대 인수인계, meetings = 회의 기록 아카이브 — "조직의 기록은 한 탭" (8/2)
  const [view, setView] = useState<'list' | 'history' | 'meetings' | 'handover'>('list');
  // 원장·일정의 "정리 보기" 점프 착지 — 회의 아카이브의 해당 카드
  const [focusRecapId, setFocusRecapId] = useState<number | null>(null);

  // 전역 검색·일정 다리의 인수인계 점프 — 기록 탭 진입 후 세그먼트를 인수인계로
  useEffect(() => {
    const open = () => setView('handover');
    window.addEventListener('exist:open-handover', open);
    // "정리 보기" — 회의 아카이브 세그먼트로 전환 + 대상 카드 포커스
    const focus = (e: Event) => {
      const d = (e as CustomEvent).detail as { code?: string; recapId?: number } | undefined;
      if (!d || d.code !== code || !d.recapId) return;
      setView('meetings');
      setFocusRecapId(d.recapId);
    };
    window.addEventListener('exist:archive-focus', focus);
    return () => {
      window.removeEventListener('exist:open-handover', open);
      window.removeEventListener('exist:archive-focus', focus);
    };
  }, [code]);
  const [hist, setHist] = useState<DecisionHistory | null>(null);
  const [histLoading, setHistLoading] = useState(false);

  async function openHistory() {
    setView('history');
    if (hist || histLoading) return;
    setHistLoading(true);
    try {
      setHist(await api<DecisionHistory>(`/api/meetings/${code}/decisions/history`));
    } catch {
      setHist({ topics: [], source: 'rule', generatedAt: Date.now() });
    } finally {
      setHistLoading(false);
    }
  }
  // 확인 직후 뜨는 "현장 한 줄(선택)" 입력 — 현직자 제안(확인 + 현장 피드백) 반영
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');
  // 🔴 결정 손 서명 — 중요도에 비례한 마찰 (일반 결정은 클릭 1회 유지)
  const [signFor, setSignFor] = useState<string | null>(null);

  const load = useCallback(() => {
    void api<LedgerEntry[]>(`/api/meetings/${code}/decisions`)
      .then(setEntries)
      .catch(() => {});
  }, [code]);

  async function ack(e: LedgerEntry, signature?: string) {
    if (e.critical && !signature) {
      // 작업 전 확인 필수 결정은 손 서명으로 — 종이 회람판처럼
      setSignFor(`${e.recapId}-${e.idx}`);
      return;
    }
    setSignFor(null);
    // 낙관적 반영 후 서버 기록
    setEntries((prev) =>
      prev.map((x) =>
        x.recapId === e.recapId && x.idx === e.idx
          ? {
              ...x,
              acks: [
                ...x.acks,
                { username: user?.username ?? '', ts: Date.now(), signature: signature ?? null },
              ],
            }
          : x,
      ),
    );
    setNoteFor(`${e.recapId}-${e.idx}`);
    setNoteText('');
    await api(`/api/meetings/${code}/decisions/ack`, {
      method: 'POST',
      body: { recapId: e.recapId, idx: e.idx, ...(signature ? { signature } : {}) },
    }).catch(() => load());
  }

  /** 현장 피드백 한 줄 저장 — 같은 ack 엔드포인트 재호출 (멱등 + 노트 갱신) */
  async function saveNote(e: LedgerEntry) {
    const note = noteText.trim();
    setNoteFor(null);
    if (!note) return;
    setEntries((prev) =>
      prev.map((x) =>
        x.recapId === e.recapId && x.idx === e.idx
          ? {
              ...x,
              acks: x.acks.map((a) => (a.username === user?.username ? { ...a, note } : a)),
            }
          : x,
      ),
    );
    await api(`/api/meetings/${code}/decisions/ack`, {
      method: 'POST',
      body: { recapId: e.recapId, idx: e.idx, note },
    }).catch(() => load());
  }

  useEffect(load, [load]);

  // 통화가 끝나고 새 recap이 생기면 원장도 즉시 갱신
  useEffect(() => {
    const socket = getSocket();
    function onNotify(n: { kind?: string; meeting?: { code?: string | null } }) {
      if (n.kind === 'recap' && n.meeting?.code === code) {
        load();
        setHist(null); // 새 결정이 생겼으니 이력도 다시 묶어야 함
      }
    }
    socket.on('agent:notify', onNotify);
    // 남이 확인(서명)한 순간 현황 즉시 갱신 — 회람 진행 상황이 새로고침 없이 맞게
    function onLedgerChanged(p: { code?: string } | undefined) {
      if (p?.code === code.toUpperCase()) load();
    }
    socket.on('ledger:changed', onLedgerChanged);
    return () => {
      socket.off('agent:notify', onNotify);
      socket.off('ledger:changed', onLedgerChanged);
    };
  }, [code, load]);

  const q = query.trim();
  const shown = q ? entries.filter((e) => e.decision.includes(q)) : entries;

  // 날짜별 그룹핑 (최신 먼저 — 서버가 최신순으로 줌)
  const groups: { label: string; items: LedgerEntry[] }[] = [];
  for (const e of shown) {
    const label = dateLabel(e.ts);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(e);
    else groups.push({ label, items: [e] });
  }

  return (
    <div className="ledger">
      <div className="ledger-head">
        <div className="ledger-title">
          {view === 'handover' ? (
            <>
              <RefreshIcon size={16} /> 교대 인수인계
            </>
          ) : view === 'meetings' ? (
            <>
              <SparklesIcon size={16} /> 회의 기록
            </>
          ) : (
            <>
              <CheckMarkIcon size={16} /> 결정 원장
              <span className="ledger-count">{entries.length}</span>
            </>
          )}
        </div>
        {/* 오른쪽 컨트롤 그룹 — [검색(목록 모드만)] [원장|변경 이력|인수인계]. 토글은 항상 맨 오른쪽 고정 */}
        <div className="ledger-head-right">
          {view === 'list' && (
            <input
              className="ledger-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="결정 검색"
            />
          )}
          <PillSeg
            className="ledger-view-seg"
            ariaLabel="기록 보기"
            options={[
              { key: 'list', label: '원장' },
              { key: 'history', label: '변경 이력' },
              { key: 'meetings', label: '회의' },
              { key: 'handover', label: '인수인계' },
            ]}
            value={view}
            onChange={(k) =>
              k === 'history' ? void openHistory() : setView(k as 'list' | 'meetings' | 'handover')
            }
          />
        </div>
      </div>

      {view === 'handover' ? (
        <HandoverPanel code={code} embedded />
      ) : view === 'meetings' ? (
        <MeetingArchive
          code={code}
          focusRecapId={focusRecapId}
          onFocusHandled={() => setFocusRecapId(null)}
        />
      ) : view === 'history' ? (
        histLoading || !hist ? (
          <div className="ledger-empty">
            <SparklesIcon size={36} />
            <p>이력을 정리하는 중…</p>
          </div>
        ) : hist.topics.length === 0 ? (
          <div className="ledger-empty">
            <p>아직 이력으로 묶을 결정이 없어요</p>
          </div>
        ) : (
          <div className="ledger-hist">
            <div className="ledger-hist-src">
              {hist.source === 'ai' ? 'AI가 같은 주제끼리 묶었어요' : '시간순 이력'}
            </div>
            {hist.topics.map((t, ti) => (
              <div key={ti} className="ledger-topic">
                <div className="ledger-topic-title">{t.title}</div>
                <div className="ledger-timeline">
                  {t.entries.map((e, ei) => {
                    const latest = ei === t.entries.length - 1;
                    return (
                      <div key={`${e.recapId}-${e.idx}`} className={`ledger-tl-item${latest ? ' latest' : ''}`}>
                        <span className="ledger-tl-dot" />
                        <div className="ledger-tl-body">
                          <div className="ledger-tl-date">
                            {dateLabel(e.ts)}
                            {latest && t.entries.length > 1 && <b className="ledger-tl-now">현재</b>}
                          </div>
                          <div className="ledger-tl-text">{e.decision}</div>
                          {e.why && <div className="ledger-why">배경 · {e.why}</div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )
      ) : null}

      {view !== 'list' ? null : entries.length === 0 ? (
        <div className="ledger-empty">
          <SparklesIcon size={36} />
          <p>아직 기록된 결정이 없어요</p>
          <span>
            통화가 끝나면 AI가 채팅에서 결정을 뽑아 여기에 쌓아요 — 누가 언제 합류해도 팀의 결정
            역사를 볼 수 있어요. 채팅에서 <b>@AI</b>를 불러 물어볼 수도 있어요.
          </span>
        </div>
      ) : shown.length === 0 ? (
        <div className="ledger-empty">
          <p>"{q}" 검색 결과가 없어요</p>
        </div>
      ) : (
        <div className="ledger-list">
          {groups.map((g) => (
            <div key={g.label} className="ledger-group">
              <div className="ledger-date">{g.label}</div>
              {g.items.map((e, i) => {
                const acked = e.acks.some((a) => a.username === user?.username);
                return (
                  <div
                    key={`${e.recapId}-${i}`}
                    className={`ledger-item${e.critical ? ' critical' : ''}${e.withdrawn ? ' withdrawn' : ''}`}
                  >
                    <span className={`ledger-check${e.critical ? ' critical' : ''}`}>
                      {/* 빨간 체크는 "정상"과 충돌 — 위험 결정은 느낌표로 "멈추고 확인" */}
                      {e.critical ? <ExclaimIcon size={15} /> : <CheckMarkIcon size={14} />}
                    </span>
                    <div className="ledger-body">
                      <div className="ledger-decision">
                        {e.withdrawn && (
                          <span className="ledger-withdrawn-badge" title={`${dn(e.withdrawn.by)} · ${e.withdrawn.reason}`}>
                            철회됨
                          </span>
                        )}
                        {e.critical && !e.withdrawn && (
                          <span className="ledger-critical" title="확인 시 손 서명이 필요해요">
                            작업 전 확인 필수
                          </span>
                        )}
                        {e.decision}
                        {(e.revisions ?? 0) > 0 && (
                          <button
                            className="ledger-revised-chip"
                            title="정정 이력 보기"
                            onClick={() => void toggleRevisions(e)}
                          >
                            정정 {e.revisions}회
                          </button>
                        )}
                      </div>
                      {e.withdrawn && (
                        <div className="ledger-withdrawn-why">
                          철회 · {e.withdrawn.reason} — {dn(e.withdrawn.by)}, {dateLabel(e.withdrawn.at)}
                        </div>
                      )}
                      {revFor === `${e.recapId}-${e.idx}` && (
                        <div className="ledger-revisions">
                          {revs.length === 0 ? (
                            <div className="ledger-revision">이력을 불러오는 중…</div>
                          ) : (
                            revs.map((rv) => (
                              <div key={rv.id} className="ledger-revision">
                                <b>{rv.kind === 'withdraw' ? '철회' : '정정'}</b> · {dn(rv.editor)} · {dateLabel(rv.ts)} — {rv.reason}
                                {rv.kind === 'edit' && rv.prevDecision !== rv.newDecision && (
                                  <div className="ledger-revision-diff">
                                    <s>{rv.prevDecision}</s> → {rv.newDecision}
                                  </div>
                                )}
                                {rv.kind === 'edit' && rv.prevWhy !== rv.newWhy && (
                                  <div className="ledger-revision-diff">
                                    배경: <s>{rv.prevWhy || '(없음)'}</s> → {rv.newWhy || '(없음)'}
                                  </div>
                                )}
                                {rv.prevAcks.length > 0 && (
                                  <div className="ledger-revision-diff">
                                    구버전 서명 {rv.prevAcks.length}명 ({rv.prevAcks.map((u) => dn(u)).join(', ')}) — 재확인 요청됨
                                  </div>
                                )}
                              </div>
                            ))
                          )}
                        </div>
                      )}
                      {e.why && <div className="ledger-why">배경 · {e.why}</div>}
                      {(e.alts?.length ?? 0) > 0 && (
                        <div className="ledger-alts">
                          {e.alts!.map((a, i) => (
                            <div key={i} className="ledger-alt">
                              검토된 대안 · {a}
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="ledger-meta">
                        참석 {e.attendees.length ? e.attendees.map((a) => dn(a)).join(', ') : '기록 없음'}
                        {e.acks.length > 0 && (
                          <span
                            className="ledger-ack-list"
                            title={e.acks.map((a) => dn(a.username)).join(', ')}
                          >
                            {' '}
                            · 확인 {e.acks.length}명 ({e.acks.map((a) => dn(a.username)).join(', ')})
                          </span>
                        )}
                        {(e.todos ?? []).length > 0 && (
                          <span
                            className={`ledger-exec${e.todos!.every((t) => t.done) ? ' all-done' : ''}`}
                            title={e.todos!.map((t) => `${t.done ? '✓' : '·'} ${t.title}`).join('\n')}
                          >
                            {' '}
                            · 실행 {e.todos!.filter((t) => t.done).length}/{e.todos!.length}
                          </span>
                        )}
                        {/* 출처 회의록 점프 — "이 결정 전후로 무슨 얘기가 있었는지"로 가는 길 */}
                        <button
                          className="ledger-src-link"
                          onClick={() =>
                            window.dispatchEvent(
                              new CustomEvent('exist:goto-recap', {
                                detail: { code, recapId: e.recapId },
                              }),
                            )
                          }
                        >
                          정리 보기
                        </button>
                        {/* 관리자 인간 감독 — 정정·철회. 지우는 버튼은 없다 (원장 줄은 사라지지 않는다).
                            원장 무결성을 건드리는 액션이라 인라인 링크가 아닌 ⋯ 메뉴 뒤로 (9/3 결함 #4) */}
                        {canManage && !e.withdrawn && (
                          <span className="ledger-more-wrap">
                            <button
                              className="ledger-more-btn"
                              aria-label="더보기"
                              aria-haspopup="menu"
                              aria-expanded={moreFor === `${e.recapId}-${e.idx}`}
                              title="정정·철회"
                              onClick={(ev) => {
                                ev.stopPropagation();
                                setMoreFor(
                                  moreFor === `${e.recapId}-${e.idx}` ? null : `${e.recapId}-${e.idx}`,
                                );
                              }}
                            >
                              ⋯
                            </button>
                            {moreFor === `${e.recapId}-${e.idx}` && (
                              <span className="ledger-more-menu" role="menu">
                                <button
                                  role="menuitem"
                                  title="문장·배경을 고치고 이력으로 남겨요"
                                  onClick={() => {
                                    setMoreFor(null);
                                    openEdit(e);
                                  }}
                                >
                                  정정
                                </button>
                                <button
                                  role="menuitem"
                                  className="danger"
                                  title="삭제 대신 철회 — 사유와 함께 남아요"
                                  onClick={() => {
                                    setMoreFor(null);
                                    setWdFor(e);
                                    setWdReason('');
                                  }}
                                >
                                  철회
                                </button>
                              </span>
                            )}
                          </span>
                        )}
                      </div>
                      {/* 이 결정으로 개정된 문서 — 클릭 = 공동편집에서 열기 (결정→문서 다리) */}
                      {(e.revisedFiles ?? []).length > 0 && (
                        <div className="ledger-revfiles">
                          {e.revisedFiles!.map((f) => (
                            <button
                              key={`${f.id}-${f.rev}`}
                              className="ledger-revchip"
                              title="이 결정을 근거로 발행된 개정 — 문서 열기"
                              onClick={() =>
                                window.dispatchEvent(
                                  new CustomEvent('exist:open-file', {
                                    detail: { code, fileId: f.id },
                                  }),
                                )
                              }
                            >
                              개정 {f.name} v{f.rev}
                            </button>
                          ))}
                        </div>
                      )}
                      {/* 손 서명 스트립 — 🔴 결정의 회람판 */}
                      {e.acks.some((a) => a.signature) && (
                        <div className="ho-signs ledger-signs">
                          {e.acks
                            .filter((a) => a.signature)
                            .map((a) => (
                              <span key={a.username} className="ho-sign-chip" title={dn(a.username)}>
                                <img src={a.signature!} alt={`${dn(a.username)} 서명`} />
                                <i>{dn(a.username)}</i>
                              </span>
                            ))}
                        </div>
                      )}
                      {/* 서명 모달 — 작업 전 확인 필수 결정의 확인 (공동편집 서명과 같은 의식감,
                          무엇에 서명하는지 결정 내용 명시 — "서명 의미 명시" 관례) */}
                      {signFor === `${e.recapId}-${e.idx}` && (
                        <div
                          className="cf-signmodal-backdrop"
                          onClick={() => setSignFor(null)}
                          role="button"
                          tabIndex={0}
                          aria-label="닫기"
                          onKeyDown={keyActivate(() => setSignFor(null))}
                        >
                          <div className="cf-signmodal" onClick={(ev) => ev.stopPropagation()} onKeyDown={keyStopPropagation}>
                            <div className="cf-signmodal-head">결정 확인 서명</div>
                            <div className="cf-signmodal-note">
                              <div className="cf-signmodal-note-t">
                                <span className="ledger-critical">작업 전 확인 필수</span>
                              </div>
                              <div>{e.decision}</div>
                              {e.why && <div className="ledger-why">배경 · {e.why}</div>}
                            </div>
                            <div className="cf-signmodal-desc">
                              아래 서명은 이 결정을 확인했음을 기록(회람판)으로 남겨요.
                            </div>
                            <SignPad
                              fluid
                              onConfirm={(dataUrl) => void ack(e, dataUrl)}
                              onCancel={() => setSignFor(null)}
                            />
                          </div>
                        </div>
                      )}
                      {/* 현장 피드백 — 확인에 딸린 한 줄 ("반영 완료"/"라인에선 어려움" 등) */}
                      {e.acks.some((a) => a.note) && (
                        <div className="ledger-feedback">
                          {e.acks
                            .filter((a) => a.note)
                            .map((a) => (
                              <div key={a.username} className="ledger-feedback-row">
                                <b>{dn(a.username)}</b> {a.note}
                              </div>
                            ))}
                        </div>
                      )}
                      {noteFor === `${e.recapId}-${e.idx}` && (
                        <form
                          className="ledger-note-form"
                          onSubmit={(ev) => {
                            ev.preventDefault();
                            void saveNote(e);
                          }}
                        >
                          <input
                            autoFocus
                            value={noteText}
                            onChange={(ev) => setNoteText(ev.target.value)}
                            placeholder="현장 한 줄 남기기 (선택) — 예: 라인에 반영 완료"
                            maxLength={120}
                          />
                          <button type="submit">{noteText.trim() ? '남기기' : '건너뛰기'}</button>
                        </form>
                      )}
                    </div>
                    {/* 수신 확인 — 회람 사인. 이미 확인했으면 상태 뱃지. 철회된 결정은 확인을 받지 않는다 */}
                    {e.withdrawn ? null : acked ? (
                      <span className="ledger-ack done">확인함 <CheckMarkIcon size={12} /></span>
                    ) : (
                      <button
                        className={`ledger-ack${e.critical ? ' critical' : ''}`}
                        onClick={() => void ack(e)}
                      >
                        확인
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
      {/* 정정 모달 — 무엇을 왜 고치는지 명시. 문장이 바뀌면 서명이 초기화됨을 미리 알린다 */}
      {editFor && (
        <div
          className="cf-signmodal-backdrop"
          onClick={() => !busy && setEditFor(null)}
          role="button"
          tabIndex={0}
          aria-label="닫기"
          onKeyDown={keyActivate(() => !busy && setEditFor(null))}
        >
          <div
            className="cf-signmodal ledger-edit-modal"
            onClick={(ev) => ev.stopPropagation()}
            onKeyDown={keyStopPropagation}
          >
            <div className="cf-signmodal-head">결정 정정</div>
            <div className="cf-signmodal-desc">
              AI가 정리한 문장을 고쳐요. 원래 문장은 이력으로 남고, <b>문장이 바뀌면 기존 서명은 구버전 서명이 되어 참가자에게 재확인을 요청</b>해요. 배경만 고치면 서명은 유지돼요.
            </div>
            <label className="ledger-edit-label">결정</label>
            <textarea value={editText} onChange={(ev) => setEditText(ev.target.value)} maxLength={300} rows={3} />
            <label className="ledger-edit-label">배경 (왜)</label>
            <input value={editWhy} onChange={(ev) => setEditWhy(ev.target.value)} maxLength={300} placeholder="없으면 비워두기" />
            <label className="ledger-edit-label">정정 사유 (필수)</label>
            <input
              value={editReason}
              onChange={(ev) => setEditReason(ev.target.value)}
              maxLength={200}
              placeholder="예: 회의에서 65도가 아니라 63도로 합의함 (원문 확인)"
              autoFocus
            />
            <div className="ledger-edit-actions">
              <button className="ledger-src-link" onClick={() => setEditFor(null)} disabled={busy}>
                취소
              </button>
              <button className="ledger-ack" onClick={() => void submitEdit()} disabled={busy}>
                정정하기
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 철회 모달 — 삭제가 아니라 철회. 사유 필수 */}
      {wdFor && (
        <div
          className="cf-signmodal-backdrop"
          onClick={() => !busy && setWdFor(null)}
          role="button"
          tabIndex={0}
          aria-label="닫기"
          onKeyDown={keyActivate(() => !busy && setWdFor(null))}
        >
          <div
            className="cf-signmodal ledger-edit-modal"
            onClick={(ev) => ev.stopPropagation()}
            onKeyDown={keyStopPropagation}
          >
            <div className="cf-signmodal-head">결정 철회</div>
            <div className="cf-signmodal-note">
              <div>{wdFor.decision}</div>
            </div>
            <div className="cf-signmodal-desc">
              원장에서 지워지지 않고 <b>"철회됨 · 사유"</b>로 남아요. 확인·서명 요청은 멈추고, AI 검색에서도 철회된 결정으로 표시돼요.
            </div>
            <label className="ledger-edit-label">철회 사유 (필수)</label>
            <input
              value={wdReason}
              onChange={(ev) => setWdReason(ev.target.value)}
              maxLength={200}
              placeholder="예: 안전팀 검토 결과 적용 보류 — 재논의 예정"
              autoFocus
            />
            <div className="ledger-edit-actions">
              <button className="ledger-src-link" onClick={() => setWdFor(null)} disabled={busy}>
                취소
              </button>
              <button className="ledger-ack critical" onClick={() => void submitWithdraw()} disabled={busy}>
                철회하기
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
