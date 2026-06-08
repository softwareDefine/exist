import { Fragment, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { getSocket, request } from '../lib/socket';
import { usePresence } from '../lib/usePresence';
import { useAuthStore } from '../store';
import MeetingView, { type ChatMessage } from './MeetingView';
import CanvasBoard from './CanvasBoard';
import Avatar from './Avatar';
import MeetingThumb from './MeetingThumb';
import MeetingSchedule from './MeetingSchedule';
import {
  PhoneIcon,
  CalendarIcon,
  ClockIcon,
  ChatIcon,
  GridIcon,
  PenIcon,
  UsersIcon,
  CheckIcon,
} from './Icons';

interface Participant {
  username: string;
  avatar: string | null;
  role: 'owner' | 'admin' | 'member' | null;
  position: string | null;
  department: string | null;
}

interface MeetingDetail {
  id: number;
  code: string;
  title: string;
  starts_at: string | null;
  ends_at: string | null;
  host: string;
  isHost: boolean;
  orgId: number | null;
  orgName: string | null;
  thumbnail: string | null;
  online: number;
  participants: Participant[];
}

function formatRange(starts: string | null, ends: string | null): string | null {
  if (!starts) return null;
  const s = new Date(starts);
  const fmt = (d: Date) => {
    const ampm = d.getHours() < 12 ? '오전' : '오후';
    const h = d.getHours() % 12 || 12;
    return `${d.getMonth() + 1}/${d.getDate()} ${ampm} ${h}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  if (!ends) return fmt(s);
  const e = new Date(ends);
  return `${fmt(s)} ~ ${fmt(e)}`;
}

/** 참가자를 부서별로 묶기 — 부서 있는 그룹 먼저(가나다), 미지정은 마지막 */
function groupByDept(people: Participant[]): { dept: string | null; people: Participant[] }[] {
  const map = new Map<string | null, Participant[]>();
  for (const p of people) {
    const key = p.department || null;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(p);
  }
  return [...map.entries()]
    .map(([dept, people]) => ({ dept, people }))
    .sort((a, b) => {
      if (a.dept === null) return 1;
      if (b.dept === null) return -1;
      return a.dept.localeCompare(b.dept, 'ko');
    });
}

/** 일정 진행 상태 뱃지 */
function scheduleState(
  starts: string | null,
  ends: string | null,
): { label: string; cls: string } | null {
  if (!starts) return null;
  const now = Date.now();
  const s = new Date(starts).getTime();
  const e = ends ? new Date(ends).getTime() : null;
  if (now < s) {
    const min = Math.round((s - now) / 60_000);
    if (min < 60) return { label: `${min}분 후 시작`, cls: 'soon' };
    const h = Math.round(min / 60);
    if (h < 24) return { label: `${h}시간 후 시작`, cls: '' };
    return { label: `${Math.round(h / 24)}일 후 시작`, cls: '' };
  }
  if (e && now >= e) return { label: '종료됨', cls: 'done' };
  return { label: '진행 중', cls: 'live' };
}

interface MeetingTodo {
  id: number;
  title: string;
  done: number;
  author?: string;
}

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}
function chatTime(ts: number): string {
  const d = new Date(ts);
  const ampm = d.getHours() < 12 ? '오전' : '오후';
  const h = d.getHours() % 12 || 12;
  return `${ampm} ${h}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function chatDateLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  if (d.toDateString() === now.toDateString()) return '오늘';
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return '어제';
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${days[d.getDay()]})`;
}

type SubTab = 'dash' | 'call' | 'chat' | 'canvas' | 'schedule';

interface Props {
  code: string;
  /** 통화 확대 상태 (오버레이) */
  expanded?: boolean;
  onToggleExpand?: () => void;
}

/** 회의 탭 = 대시보드(메인) + 통화/채팅 서브탭 */
export default function MeetingHub({ code, expanded, onToggleExpand }: Props) {
  const user = useAuthStore((s) => s.user);
  const presence = usePresence();
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [subtab, setSubtab] = useState<SubTab>('dash');
  const [inCall, setInCall] = useState(false);
  const [copied, setCopied] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [canvasMounted, setCanvasMounted] = useState(false); // 한 번 열면 유지 (재연결·카메라 초기화 방지)
  const [todos, setTodos] = useState<MeetingTodo[]>([]);
  const [todoInput, setTodoInput] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);

  // 회의 공유 할 일 로드
  useEffect(() => {
    let alive = true;
    void api<MeetingTodo[]>(`/api/todos?meeting=${code}`)
      .then((list) => {
        if (alive) setTodos(list);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [code]);

  async function reloadTodos() {
    try {
      setTodos(await api<MeetingTodo[]>(`/api/todos?meeting=${code}`));
    } catch {
      /* 무시 */
    }
  }
  async function addTodo(e: React.FormEvent) {
    e.preventDefault();
    if (!todoInput.trim()) return;
    await api('/api/todos', { method: 'POST', body: { title: todoInput, meeting: code } });
    setTodoInput('');
    void reloadTodos();
  }
  async function toggleTodo(t: MeetingTodo) {
    await api(`/api/todos/${t.id}`, { method: 'PATCH', body: { done: !t.done } });
    void reloadTodos();
  }
  async function deleteTodo(t: MeetingTodo) {
    await api(`/api/todos/${t.id}`, { method: 'DELETE' });
    void reloadTodos();
  }

  useEffect(() => {
    if (subtab === 'canvas') setCanvasMounted(true);
  }, [subtab]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, subtab]);

  // 상세 + 현재 통화 인원 (10초 폴링)
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const d = await api<MeetingDetail>(`/api/meetings/${code}`);
        if (alive) {
          setDetail(d);
          // 회의 탭 제목 옆 조직 배지 + 조직별 탭 필터용 (WorkspacePanel 수신)
          window.dispatchEvent(
            new CustomEvent('meeting:org', {
              detail: { code: code.toUpperCase(), orgId: d.orgId, orgName: d.orgName },
            }),
          );
        }
      } catch {
        /* 전역 토스트 */
      }
    }
    void load();
    const t = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [code]);

  // 회의 채팅 — 통화 여부 무관 구독 (inCall 변동 시 소켓 재생성 대응 위해 재구독)
  useEffect(() => {
    let alive = true;
    const socket = getSocket();

    function join() {
      // 재연결 시 놓친 메시지까지 복구 (히스토리 재로드 + 룸 재가입)
      void api<ChatMessage[]>(`/api/meetings/${code}/messages`).then((history) => {
        if (alive) setMessages(history);
      });
      void request(socket, 'chat:join', { code }).catch(() => {});
    }
    join();
    // 서버 재시작/네트워크 단절 후 socket.io가 자동 재연결되면 룸 멤버십이
    // 사라지므로 다시 join해야 메시지를 계속 받는다
    socket.on('connect', join);

    function onMessage(msg: ChatMessage) {
      if (msg.code && msg.code !== code.toUpperCase()) return;
      setMessages((prev) => [...prev, msg]);
      // 회의 탭 안읽음 배지용 (WorkspacePanel이 수신)
      window.dispatchEvent(new CustomEvent('meeting:message', { detail: { code: code.toUpperCase() } }));
    }
    socket.on('chat:message', onMessage);
    return () => {
      alive = false;
      socket.off('connect', join);
      socket.off('chat:message', onMessage);
    };
  }, [code, inCall]);

  function sendChat(e: React.FormEvent) {
    e.preventDefault();
    if (!chatInput.trim()) return;
    getSocket().emit('chat:send', { code, text: chatInput });
    setChatInput('');
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* 수동 복사 */
    }
  }

  function joinCall() {
    setInCall(true);
    setSubtab('call');
  }

  const range = detail ? formatRange(detail.starts_at, detail.ends_at) : null;

  return (
    <div className="meeting-hub">
      {/* 서브탭 — 대시보드가 메인 */}
      <div className="hub-tabs">
        <button
          className={`hub-tab${subtab === 'dash' ? ' active' : ''}`}
          onClick={() => setSubtab('dash')}
        >
          <GridIcon size={14} /> 대시보드
        </button>
        <button
          className={`hub-tab${subtab === 'schedule' ? ' active' : ''}`}
          onClick={() => setSubtab('schedule')}
        >
          <CalendarIcon size={13} /> 일정
        </button>
        <button
          className={`hub-tab${subtab === 'call' ? ' active' : ''}`}
          onClick={() => setSubtab('call')}
        >
          <PhoneIcon size={13} /> 통화
          {inCall && <i className="live-dot" />}
          {(detail?.online ?? 0) > 0 && <span className="hub-tab-count">{detail!.online}</span>}
        </button>
        <button
          className={`hub-tab${subtab === 'chat' ? ' active' : ''}`}
          onClick={() => setSubtab('chat')}
        >
          <ChatIcon size={13} /> 채팅
        </button>
        <button
          className={`hub-tab${subtab === 'canvas' ? ' active' : ''}`}
          onClick={() => setSubtab('canvas')}
        >
          <PenIcon size={13} /> 캔버스
        </button>
      </div>

      <div className="hub-body">
        {/* 대시보드 (메인) */}
        {subtab === 'dash' && (
          <div className="hub-dash">
            {!detail ? (
              <div className="hub-loading">회의 정보를 불러오는 중…</div>
            ) : (
              <>
                {/* 1. 회의 정보 — 상단 풀폭 */}
                <section className="hub-section full hub-info-section">
                  <div className="hub-head">
                    <MeetingThumb
                      id={detail.id}
                      title={detail.title}
                      thumbnail={detail.thumbnail}
                      className="hub-thumb"
                    />
                    <div className="hub-title-wrap">
                      <h2 className="hub-title">{detail.title}</h2>
                      <div className="hub-sub">
                        호스트 <b>{detail.host}</b>
                        {detail.isHost && ' (나)'}
                        {detail.orgName && <span className="hub-sub-org"> · {detail.orgName}</span>}
                      </div>
                    </div>
                    <button className="hub-code lg" onClick={copyCode} title="클릭해서 복사">
                      {detail.code} {copied ? '✓' : '⧉'}
                    </button>
                  </div>
                </section>

                {/* 2. 통화 정보 */}
                <section className="hub-section">
                  <div className="hub-section-title">
                    <PhoneIcon size={15} /> 통화
                  </div>
                  <div className="hub-call-status">
                    {detail.online > 0 ? (
                      <span className="hub-live">
                        <i className="live-dot" /> 지금 {detail.online}명 통화 중
                      </span>
                    ) : (
                      <span className="hub-call-idle">
                        <ClockIcon size={14} /> 아직 통화에 아무도 없어요
                      </span>
                    )}
                  </div>
                  <button className="hub-join" onClick={joinCall}>
                    <PhoneIcon size={18} /> {inCall ? '통화로 돌아가기' : '통화 참여하기'}
                  </button>
                </section>

                {/* 3. 일정 정보 */}
                <section className="hub-section">
                  <div className="hub-section-title">
                    <CalendarIcon size={15} /> 일정
                  </div>
                  {range ? (
                    <>
                      <div className="hub-sched-time">{range}</div>
                      {(() => {
                        const st = scheduleState(detail.starts_at, detail.ends_at);
                        return st ? (
                          <span className={`hub-sched-badge ${st.cls}`}>{st.label}</span>
                        ) : null;
                      })()}
                    </>
                  ) : (
                    <div className="hub-section-empty">아직 일정이 정해지지 않았어요</div>
                  )}
                </section>

                {/* 4. 사용자 정보 (참가자) — 절반, 조직 회의면 부서별 명함 */}
                <section className="hub-section">
                  <div className="hub-section-title">
                    <UsersIcon size={15} /> 참가자 <b>{detail.participants.length}</b>
                    {detail.orgName && <span className="hub-roster-org">· {detail.orgName}</span>}
                  </div>
                  <div className="hub-roster">
                    {groupByDept(detail.participants).map((group) => (
                      <div key={group.dept ?? '__none'} className="hub-dept">
                        {group.dept && <div className="hub-dept-name">{group.dept}</div>}
                        <div className="hub-cards">
                          {group.people.map((p) => (
                            <div
                              key={p.username}
                              className={`hub-pcard${presence.has(p.username) ? ' online' : ''}`}
                            >
                              <Avatar value={p.avatar} className="hub-pcard-avatar" />
                              <span className="hub-pcard-info">
                                <span className="hub-pcard-name">
                                  {p.username}
                                  {p.role === 'owner' && (
                                    <span className="hub-pcard-badge">소유자</span>
                                  )}
                                  {p.role === 'admin' && (
                                    <span className="hub-pcard-badge admin">관리자</span>
                                  )}
                                </span>
                                <span className="hub-pcard-sub">
                                  {p.position && <b className="hub-pcard-pos">{p.position}</b>}
                                  {p.position && (p.department || detail.orgName) && ' · '}
                                  {p.department || (detail.orgName ? '부서 미지정' : '')}
                                  {p.username === detail.host && (
                                    <span className="hub-pcard-host"> · 호스트</span>
                                  )}
                                </span>
                              </span>
                              <i
                                className="presence-dot"
                                title={presence.has(p.username) ? '접속 중' : '오프라인'}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>

                {/* 5. 할 일 (회의 공유) */}
                <section className="hub-section">
                  <div className="hub-section-title">
                    <CheckIcon size={15} /> 할 일
                    {todos.length > 0 && (
                      <span className="hub-todo-count">
                        {todos.filter((t) => t.done).length}/{todos.length}
                      </span>
                    )}
                  </div>
                  <div className="hub-todos">
                    {todos.map((t) => (
                      <div key={t.id} className={`hub-todo${t.done ? ' done' : ''}`}>
                        <label className="hub-todo-label">
                          <input
                            type="checkbox"
                            checked={!!t.done}
                            onChange={() => void toggleTodo(t)}
                          />
                          <span className="hub-todo-text">{t.title}</span>
                        </label>
                        {t.author && <span className="hub-todo-author">{t.author}</span>}
                        <button
                          className="hub-todo-del"
                          onClick={() => void deleteTodo(t)}
                          title="삭제"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    {todos.length === 0 && (
                      <div className="hub-section-empty">함께 할 일을 추가해보세요</div>
                    )}
                  </div>
                  <form className="hub-todo-add" onSubmit={addTodo}>
                    <input
                      value={todoInput}
                      onChange={(e) => setTodoInput(e.target.value)}
                      placeholder="할 일 추가"
                    />
                    <button type="submit">추가</button>
                  </form>
                </section>

                {/* 6. 최근 채팅 */}
                <section className="hub-section">
                  <div className="hub-section-title">
                    <ChatIcon size={15} /> 최근 채팅
                    {messages.length > 0 && (
                      <button className="hub-preview-more" onClick={() => setSubtab('chat')}>
                        더 보기 ›
                      </button>
                    )}
                  </div>
                  {messages.length > 0 ? (
                    <div className="hub-preview">
                      {messages.slice(-3).map((m, i) => (
                        <div key={i} className="hub-preview-msg">
                          <b>{m.from}</b> {m.text}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="hub-section-empty">아직 대화가 없어요</div>
                  )}
                </section>

                {/* 6. 공동 편집 캔버스 바로가기 */}
                <section className="hub-section hub-canvas-card" onClick={() => setSubtab('canvas')}>
                  <div className="hub-section-title">
                    <PenIcon size={15} /> 공동 편집 캔버스
                    <span className="hub-preview-more">열기 ›</span>
                  </div>
                  <div className="hub-section-empty">
                    회의마다 자동으로 생기는 화이트보드예요 — 함께 그리고 메모하세요
                  </div>
                </section>
              </>
            )}
          </div>
        )}

        {/* 일정 서브탭 — 달력으로 회의 일정 관리 */}
        {subtab === 'schedule' && detail && (
          <div className="hub-schedule">
            <MeetingSchedule
              code={code}
              isHost={detail.isHost}
              startsAt={detail.starts_at}
              endsAt={detail.ends_at}
            />
          </div>
        )}

        {/* 통화 — 입장하면 서브탭 옮겨도 마운트 유지. 다른 서브탭에선 우하단 미니 PiP */}
        {inCall && (
          <div
            className={`hub-call${subtab === 'call' ? '' : ' mini'}`}
            onClick={subtab !== 'call' ? () => setSubtab('call') : undefined}
            title={subtab !== 'call' ? '클릭하면 통화 화면으로' : undefined}
          >
            <MeetingView
              code={code}
              embedded
              expanded={expanded}
              onToggleExpand={onToggleExpand}
              onLeave={(message) => {
                setInCall(false);
                setSubtab('dash');
                if (expanded) onToggleExpand?.();
                if (message)
                  window.dispatchEvent(new CustomEvent('app:error', { detail: message }));
              }}
            />
          </div>
        )}
        {!inCall && subtab === 'call' && (
          <div className="hub-call-lobby">
            <div className="hub-call-lobby-inner">
              <PhoneIcon size={36} />
              <p>
                아직 통화에 참여하지 않았어요
                {detail && detail.online > 0 && (
                  <>
                    <br />
                    <b className="hub-live">지금 {detail.online}명이 통화 중이에요</b>
                  </>
                )}
              </p>
              <button className="hub-join" onClick={joinCall}>
                <PhoneIcon size={18} /> 통화 참여하기
              </button>
            </div>
          </div>
        )}

        {/* 캔버스 — 회의마다 자동으로 생기는 공동편집 보드 (한 번 열면 마운트 유지) */}
        {canvasMounted && (
          <div
            className="hub-canvas"
            style={{ display: subtab === 'canvas' ? 'block' : 'none' }}
          >
            <CanvasBoard roomId={`mt-${code.toUpperCase()}`} />
          </div>
        )}

        {/* 채팅 */}
        {subtab === 'chat' && (
          <div className="hub-chat">
            <div className="hub-chat-messages">
              {messages.length === 0 && (
                <div className="chat-empty">
                  <ChatIcon size={40} />
                  <p>아직 대화가 없어요</p>
                  <span>첫 메시지를 남겨보세요</span>
                </div>
              )}
              {messages.map((m, i) => {
                const prev = messages[i - 1];
                const mine = m.from === user?.username;
                const showDate = !prev || !sameDay(prev.ts, m.ts);
                const grouped =
                  !!prev && prev.from === m.from && !showDate && m.ts - prev.ts < 5 * 60_000;
                return (
                  <Fragment key={i}>
                    {showDate && (
                      <div className="chat-date">
                        <span>{chatDateLabel(m.ts)}</span>
                      </div>
                    )}
                    <div className={`chat-row${mine ? ' mine' : ''}${grouped ? ' grouped' : ''}`}>
                      {!mine &&
                        (grouped ? (
                          <span className="chat-avatar-gap" />
                        ) : (
                          <Avatar value={m.avatar} className="chat-avatar" />
                        ))}
                      <div className="chat-content">
                        {!mine && !grouped && <span className="chat-name">{m.from}</span>}
                        <div className="chat-line">
                          {mine && <span className="chat-time">{chatTime(m.ts)}</span>}
                          <div className="chat-bubble">{m.text}</div>
                          {!mine && <span className="chat-time">{chatTime(m.ts)}</span>}
                        </div>
                      </div>
                    </div>
                  </Fragment>
                );
              })}
              <div ref={chatEndRef} />
            </div>
            <form className="hub-chat-input" onSubmit={sendChat}>
              <input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="메시지 입력"
              />
              <button type="submit">전송</button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
