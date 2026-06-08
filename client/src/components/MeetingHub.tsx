import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { getSocket, request } from '../lib/socket';
import { usePresence } from '../lib/usePresence';
import { useAuthStore } from '../store';
import MeetingView, { type ChatMessage } from './MeetingView';
import CanvasBoard from './CanvasBoard';
import { PhoneIcon, CalendarIcon, ClockIcon, ChatIcon, FolderIcon } from './Icons';

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

type SubTab = 'dash' | 'call' | 'chat' | 'canvas';

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
  const chatEndRef = useRef<HTMLDivElement>(null);

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
          <FolderIcon size={14} /> 대시보드
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
          <FolderIcon size={13} /> 캔버스
        </button>
      </div>

      <div className="hub-body">
        {/* 대시보드 (메인) */}
        {subtab === 'dash' && (
          <div className="hub-dash">
            {!detail ? (
              <div className="hub-loading">회의 정보를 불러오는 중…</div>
            ) : (
              <div className="hub-card">
                <div className="hub-head">
                  <div
                    className="hub-thumb"
                    style={{
                      background: `linear-gradient(135deg, hsl(${(detail.id * 67) % 360} 60% 55%), hsl(${(detail.id * 67 + 40) % 360} 60% 45%))`,
                    }}
                  >
                    {detail.title.slice(0, 1)}
                  </div>
                  <div className="hub-title-wrap">
                    <h2 className="hub-title">{detail.title}</h2>
                    <div className="hub-sub">
                      호스트 <b>{detail.host}</b>
                      {detail.isHost && ' (나)'}
                    </div>
                  </div>
                </div>

                <div className="hub-rows">
                  <div className="hub-row">
                    <span className="hub-label">코드</span>
                    <button className="hub-code" onClick={copyCode} title="클릭해서 복사">
                      {detail.code} {copied ? '✓' : ''}
                    </button>
                  </div>
                  {range && (
                    <div className="hub-row">
                      <span className="hub-label">
                        <CalendarIcon size={14} /> 일정
                      </span>
                      <span>{range}</span>
                    </div>
                  )}
                  <div className="hub-row">
                    <span className="hub-label">
                      <ClockIcon size={14} /> 통화
                    </span>
                    <span className={detail.online > 0 ? 'hub-live' : ''}>
                      {detail.online > 0 ? (
                        <>
                          <i className="live-dot" /> 지금 {detail.online}명 통화 중
                        </>
                      ) : (
                        '아직 아무도 없어요'
                      )}
                    </span>
                  </div>
                </div>

                {/* 참가자 — 조직 회의면 부서별 명함, 개인 회의면 단순 목록 */}
                <div className="hub-roster">
                  <div className="hub-roster-head">
                    참가자 <b>{detail.participants.length}</b>
                    {detail.orgName && <span className="hub-roster-org">· {detail.orgName}</span>}
                  </div>
                  {groupByDept(detail.participants).map((group) => (
                    <div key={group.dept ?? '__none'} className="hub-dept">
                      {group.dept && <div className="hub-dept-name">{group.dept}</div>}
                      <div className="hub-cards">
                        {group.people.map((p) => (
                          <div
                            key={p.username}
                            className={`hub-pcard${presence.has(p.username) ? ' online' : ''}`}
                          >
                            <span className="hub-pcard-avatar">{p.avatar || '🙂'}</span>
                            <span className="hub-pcard-info">
                              <span className="hub-pcard-name">
                                {p.username}
                                {p.position && <span className="hub-pcard-pos">{p.position}</span>}
                                {p.role === 'owner' && <span className="hub-pcard-badge">소유자</span>}
                                {p.role === 'admin' && (
                                  <span className="hub-pcard-badge admin">관리자</span>
                                )}
                              </span>
                              <span className="hub-pcard-sub">
                                {p.department || (detail.orgName ? '부서 미지정' : '')}
                                {p.username === detail.host && (
                                  <span className="hub-pcard-host"> · 호스트</span>
                                )}
                              </span>
                            </span>
                            <i className="presence-dot" title={presence.has(p.username) ? '접속 중' : '오프라인'} />
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>

                <button className="hub-join" onClick={joinCall}>
                  <PhoneIcon size={18} /> {inCall ? '통화로 돌아가기' : '통화 참여하기'}
                </button>

                {/* 최근 채팅 미리보기 */}
                {messages.length > 0 && (
                  <div className="hub-preview">
                    <div className="hub-preview-head">
                      <span>
                        <ChatIcon size={13} /> 최근 채팅
                      </span>
                      <button className="hub-preview-more" onClick={() => setSubtab('chat')}>
                        더 보기 ›
                      </button>
                    </div>
                    {messages.slice(-3).map((m, i) => (
                      <div key={i} className="hub-preview-msg">
                        <b>{m.from}</b> {m.text}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
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
                <div className="chat-empty">아직 메시지가 없어요 — 첫 메시지를 남겨보세요</div>
              )}
              {messages.map((m, i) => (
                <div key={i} className={`hub-msg${m.from === user?.username ? ' mine' : ''}`}>
                  <span className="hub-msg-from">{m.from}</span>
                  <div className="hub-bubble">{m.text}</div>
                </div>
              ))}
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
