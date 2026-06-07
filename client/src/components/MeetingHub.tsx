import { useEffect, useState } from 'react';
import { api } from '../api';
import MeetingView from './MeetingView';
import { PhoneIcon, CalendarIcon, ClockIcon } from './Icons';

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
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [inCall, setInCall] = useState(false);
  const [copied, setCopied] = useState(false);

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
    </div>
  );
}
