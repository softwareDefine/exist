import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { getSocket, request } from '../lib/socket';
import { useAuthStore } from '../store';
import MeetingView, { type ChatMessage } from './MeetingView';
import { PhoneIcon, CalendarIcon, ClockIcon, ChatIcon } from './Icons';

interface MeetingDetail {
  id: number;
  code: string;
  title: string;
  starts_at: string | null;
  ends_at: string | null;
  host: string;
  isHost: boolean;
  online: number;
  participants: string[];
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

interface Props {
  code: string;
  /** 통화 확대 상태 (오버레이) */
  expanded?: boolean;
  onToggleExpand?: () => void;
}

/** 회의 탭 = 회의 대시보드. 로비(정보)에서 통화 참여 → MeetingView */
export default function MeetingHub({ code, expanded, onToggleExpand }: Props) {
  const user = useAuthStore((s) => s.user);
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [inCall, setInCall] = useState(false);
  const [copied, setCopied] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // 허브 채팅 — 통화 없이도 보고 보냄 (통화 중엔 MeetingView가 담당)
  useEffect(() => {
    if (inCall) return;
    let alive = true;
    const socket = getSocket();

    void api<ChatMessage[]>(`/api/meetings/${code}/messages`).then((history) => {
      if (alive) setMessages(history);
    });
    void request(socket, 'chat:join', { code }).catch(() => {});

    function onMessage(msg: ChatMessage) {
      if (msg.code && msg.code !== code.toUpperCase()) return;
      setMessages((prev) => [...prev, msg]);
    }
    socket.on('chat:message', onMessage);
    return () => {
      alive = false;
      socket.off('chat:message', onMessage);
    };
  }, [code, inCall]);

  function sendChat(e: React.FormEvent) {
    e.preventDefault();
    if (!chatInput.trim()) return;
    getSocket().emit('chat:send', { code, text: chatInput });
    setChatInput('');
  }

  // 상세 + 현재 통화 인원 (10초 폴링, 통화 중엔 중단)
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const d = await api<MeetingDetail>(`/api/meetings/${code}`);
        if (alive) setDetail(d);
      } catch {
        /* 전역 토스트 */
      }
    }
    void load();
    if (inCall) return;
    const t = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [code, inCall]);

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* 수동 복사 */
    }
  }

  if (inCall) {
    return (
      <MeetingView
        code={code}
        embedded
        expanded={expanded}
        onToggleExpand={onToggleExpand}
        onLeave={(message) => {
          // 통화만 종료하고 허브로 복귀 (탭 유지) — 확대 상태였다면 해제
          setInCall(false);
          if (expanded) onToggleExpand?.();
          if (message) window.dispatchEvent(new CustomEvent('app:error', { detail: message }));
        }}
      />
    );
  }

  if (!detail) {
    return <div className="meeting-hub loading">회의 정보를 불러오는 중…</div>;
  }

  const range = formatRange(detail.starts_at, detail.ends_at);

  return (
    <div className="meeting-hub">
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
          <div className="hub-row">
            <span className="hub-label">참가자</span>
            <span className="hub-participants">{detail.participants.join(', ')}</span>
          </div>
        </div>

        <button className="hub-join" onClick={() => setInCall(true)}>
          <PhoneIcon size={18} /> 통화 참여하기
        </button>
      </div>

      {/* 회의 채팅 — 통화 없이도 사용 가능, 통화 중 채팅과 같은 스트림 */}
      <div className="hub-chat">
        <div className="hub-chat-head">
          <ChatIcon size={16} /> 회의 채팅
        </div>
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
    </div>
  );
}
