import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useAuthStore } from '../store';
import { PhoneIcon } from './Icons';

interface MEvent {
  id: number;
  title: string;
  date: string; // YYYY-MM-DD
  time: string | null; // HH:MM (시작)
  end_time: string | null; // HH:MM (종료)
  is_call?: number; // 1이면 통화 일정 (10분 전 "통화 들어오세요" 알림)
  author: string;
  created_by: number;
}

interface Props {
  code: string;
  isHost: boolean;
  startsAt: string | null;
  endsAt: string | null;
  /** 반복 주기 — 'none'|'daily'|'weekly'|'biweekly'|'monthly' */
  recur?: string;
  /** 반복 종료일 (YYYY-MM-DD). 없으면 1년까지만 표시 */
  recurUntil?: string | null;
  /** 삭제된 특정 회차 날짜들 (YYYY-MM-DD) */
  recurExcept?: string[];
  /** 회차 삭제/복원 후 부모가 detail 다시 불러오게 */
  onOccurrenceChanged?: () => void;
}

function stepDate(d: Date, recur: string): Date {
  const n = new Date(d);
  if (recur === 'daily') n.setDate(n.getDate() + 1);
  else if (recur === 'weekly') n.setDate(n.getDate() + 7);
  else if (recur === 'biweekly') n.setDate(n.getDate() + 14);
  else if (recur === 'monthly') n.setMonth(n.getMonth() + 1);
  return n;
}

const pad = (n: number) => String(n).padStart(2, '0');
function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

/** 회의 일정 달력 — 이벤트를 날짜에 표시하고 추가·삭제로 관리 */
export default function MeetingSchedule({
  code,
  isHost,
  startsAt,
  endsAt,
  recur = 'none',
  recurUntil = null,
  recurExcept = [],
  onOccurrenceChanged,
}: Props) {
  const userId = useAuthStore((s) => s.user?.id);
  const [events, setEvents] = useState<MEvent[]>([]);
  const [offset, setOffset] = useState(0); // 월 이동
  const [selected, setSelected] = useState<string>(() => ymd(new Date()));
  const [title, setTitle] = useState('');
  const [time, setTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [isCall, setIsCall] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setEvents(await api<MEvent[]>(`/api/meetings/${code}/events`));
    } catch {
      /* 무시 */
    }
  }, [code]);

  useEffect(() => {
    void load();
  }, [load]);

  // 회의 메인 일정 날짜들 — 반복이면 occurrence 전부 펼쳐 표시 (nowbar와 일치시키기 위함)
  const meetingDays = useMemo(() => {
    const set = new Set<string>();
    if (!startsAt) return set;
    const first = new Date(startsAt);
    if (isNaN(first.getTime())) return set;
    if (recur === 'none') {
      set.add(ymd(first));
      return set;
    }
    const until = recurUntil ? new Date(recurUntil + 'T23:59:59') : null;
    // 종료일 없으면 시작 +1년까지만 (무한 루프 방지), 최대 400개
    const cap = until ?? new Date(first.getFullYear() + 1, first.getMonth(), first.getDate());
    let cur = first;
    for (let i = 0; i < 400 && cur.getTime() <= cap.getTime(); i++) {
      set.add(ymd(cur));
      cur = stepDate(cur, recur);
    }
    return set;
  }, [startsAt, recur, recurUntil]);
  // 삭제된 회차는 제외
  const exceptSet = useMemo(() => new Set(recurExcept), [recurExcept]);
  const isMeetingDayKey = (key: string) => meetingDays.has(key) && !exceptSet.has(key);

  // 날짜별 이벤트 수
  const byDate = useMemo(() => {
    const m = new Map<string, MEvent[]>();
    for (const e of events) {
      if (!m.has(e.date)) m.set(e.date, []);
      m.get(e.date)!.push(e);
    }
    return m;
  }, [events]);

  const base = new Date();
  base.setDate(1);
  base.setMonth(base.getMonth() + offset);
  const year = base.getFullYear();
  const month = base.getMonth();
  const startDow = base.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = ymd(new Date());

  const cells: { key: string; day: number; cur: boolean }[] = [];
  const prevDays = new Date(year, month, 0).getDate();
  for (let i = startDow - 1; i >= 0; i--) {
    const d = new Date(year, month - 1, prevDays - i);
    cells.push({ key: ymd(d), day: prevDays - i, cur: false });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ key: ymd(new Date(year, month, d)), day: d, cur: true });
  }
  while (cells.length % 7 !== 0) {
    const d = cells.length - startDow - daysInMonth + 1;
    cells.push({ key: ymd(new Date(year, month + 1, d)), day: d, cur: false });
  }

  const dayEvents = byDate.get(selected) ?? [];

  async function excludeOccurrence() {
    if (!window.confirm(`${selectedLabel()} 회차를 삭제할까요? 이 날 하나만 빠지고 나머지는 그대로예요.`))
      return;
    try {
      await api(`/api/meetings/${code}/occurrences/exclude`, {
        method: 'POST',
        body: { date: selected },
      });
      onOccurrenceChanged?.();
      window.dispatchEvent(new CustomEvent('exist:schedule-changed'));
    } catch {
      /* 전역 토스트 */
    }
  }

  function resetForm() {
    setTitle('');
    setTime('');
    setEndTime('');
    setIsCall(false);
    setEditingId(null);
  }

  function startEdit(ev: MEvent) {
    setEditingId(ev.id);
    setSelected(ev.date);
    setTitle(ev.title);
    setTime(ev.time ?? '');
    setEndTime(ev.end_time ?? '');
    setIsCall(!!ev.is_call);
  }

  async function addEvent(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    if (time && endTime && endTime <= time) {
      window.dispatchEvent(
        new CustomEvent('app:error', { detail: '종료 시간이 시작보다 빨라요' }),
      );
      return;
    }
    const body = {
      title,
      date: selected,
      time: time || null,
      end_time: time ? endTime || null : null,
      is_call: isCall && !!time, // 통화는 시작 시간이 있어야 의미 있음
    };
    if (editingId != null) {
      await api(`/api/meetings/${code}/events/${editingId}`, { method: 'PATCH', body });
    } else {
      await api(`/api/meetings/${code}/events`, { method: 'POST', body });
    }
    resetForm();
    void load();
    window.dispatchEvent(new CustomEvent('exist:schedule-changed')); // nowbar 일정 갱신
  }
  async function removeEvent(id: number) {
    await api(`/api/meetings/${code}/events/${id}`, { method: 'DELETE' });
    void load();
    window.dispatchEvent(new CustomEvent('exist:schedule-changed'));
  }

  function selectedLabel(): string {
    const d = new Date(selected + 'T00:00');
    return `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW[d.getDay()]})`;
  }

  return (
    <div className="msched">
      <div className="msched-cal">
        <div className="msched-cal-head">
          <button onClick={() => setOffset((o) => o - 1)} aria-label="이전 달">
            ‹
          </button>
          <span>
            {year}년 {month + 1}월
          </span>
          <button onClick={() => setOffset((o) => o + 1)} aria-label="다음 달">
            ›
          </button>
        </div>
        <div className="msched-grid">
          {DOW.map((w) => (
            <span key={w} className="msched-dow">
              {w}
            </span>
          ))}
          {cells.map((c, i) => {
            const evs = byDate.get(c.key) ?? [];
            const isMeetingDay = isMeetingDayKey(c.key);
            const chips = evs.slice(0, isMeetingDay ? 1 : 2);
            const overflow = evs.length - chips.length;
            return (
              <button
                key={i}
                className={
                  'msched-day' +
                  (c.cur ? '' : ' out') +
                  (c.key === selected ? ' sel' : '')
                }
                onClick={() => setSelected(c.key)}
              >
                <span
                  className={
                    'msched-day-num' +
                    (c.key === todayKey ? ' today' : '') +
                    (c.key === selected ? ' sel' : '')
                  }
                >
                  {c.day}
                </span>
                <span className="msched-day-events">
                  {isMeetingDay && (
                    <span className="msched-chip meeting" title="이 그룹 일정">
                      <i className="msched-chip-dot" />이 그룹
                    </span>
                  )}
                  {chips.map((e) => (
                    <span key={e.id} className="msched-chip" title={e.title}>
                      {e.time && <b className="msched-chip-time">{e.time}</b>}
                      {e.title}
                    </span>
                  ))}
                  {overflow > 0 && <span className="msched-more">+{overflow}</span>}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="msched-day-panel">
        <div className="msched-day-title">{selectedLabel()}</div>

        {/* 회의 본 일정이 이 날이면 표시 */}
        {isMeetingDayKey(selected) && (
          <div className="msched-main-event">
            <span className="msched-main-event-text">
              📌 이 그룹 일정
              {startsAt && (
                <span>
                  {' '}
                  {new Date(startsAt).getHours()}:{pad(new Date(startsAt).getMinutes())}
                  {endsAt &&
                    ` ~ ${new Date(endsAt).getHours()}:${pad(new Date(endsAt).getMinutes())}`}
                </span>
              )}
            </span>
            {/* 반복 회의면 이 회차만 삭제 (호스트) */}
            {isHost && recur !== 'none' && (
              <button
                type="button"
                className="msched-occ-del"
                title="이 회차만 삭제"
                onClick={() => void excludeOccurrence()}
              >
                이 회차 삭제
              </button>
            )}
          </div>
        )}

        <div className="msched-events">
          {dayEvents.length === 0 ? (
            <div className="msched-empty">이 날 일정이 없어요</div>
          ) : (
            dayEvents.map((ev) => (
              <div key={ev.id} className="msched-event">
                {ev.time && (
                  <span className="msched-event-time">
                    {ev.time}
                    {ev.end_time ? `~${ev.end_time}` : ''}
                  </span>
                )}
                <span className="msched-event-title">
                  {ev.is_call ? (
                    <span className="msched-call-ic">
                      <PhoneIcon size={12} />
                    </span>
                  ) : null}
                  {ev.title}
                </span>
                <span className="msched-event-author">{ev.author}</span>
                {(ev.created_by === userId || isHost) && (
                  <>
                    <button
                      className={`msched-event-edit${editingId === ev.id ? ' on' : ''}`}
                      title="수정"
                      onClick={() => startEdit(ev)}
                    >
                      ✎
                    </button>
                    <button
                      className="msched-event-del"
                      title="삭제"
                      onClick={() => void removeEvent(ev.id)}
                    >
                      ×
                    </button>
                  </>
                )}
              </div>
            ))
          )}
        </div>

        <form className="msched-add" onSubmit={addEvent}>
          <input
            className="msched-add-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={`${selectedLabel()} 통화/일정 제목`}
            maxLength={80}
          />
          <div className="msched-add-times">
            <label>
              <span>시작</span>
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </label>
            <span className="msched-times-sep">~</span>
            <label>
              <span>종료</span>
              <input
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                disabled={!time}
              />
            </label>
            <button
              type="button"
              className={`msched-call-sw${isCall ? ' on' : ''}`}
              onClick={() => time && setIsCall((v) => !v)}
              disabled={!time}
              title={time ? '통화로 등록 (10분 전 알림)' : '시작 시간을 먼저 정하세요'}
            >
              <PhoneIcon size={14} /> 통화
              <span className={`msched-sw${isCall ? ' on' : ''}`}>
                <i />
              </span>
            </button>
          </div>
          <div className="msched-add-actions">
            {editingId != null && (
              <button type="button" className="msched-add-cancel" onClick={resetForm}>
                취소
              </button>
            )}
            <button type="submit" className="msched-add-btn" disabled={!title.trim()}>
              {editingId != null ? '수정 저장' : '일정 추가'}
            </button>
          </div>
          <p className="msched-add-hint">
            {editingId != null
              ? '✎ 일정을 수정하는 중이에요'
              : '🔔 추가하면 참가자 전원에게 알림'}
            {isCall && ' · 통화는 10분 전에 "들어오세요" 알림'}
          </p>
        </form>
      </div>
    </div>
  );
}
