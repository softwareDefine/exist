import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useAuthStore } from '../store';

interface MEvent {
  id: number;
  title: string;
  date: string; // YYYY-MM-DD
  time: string | null; // HH:MM
  author: string;
  created_by: number;
}

interface Props {
  code: string;
  isHost: boolean;
  startsAt: string | null;
  endsAt: string | null;
}

const pad = (n: number) => String(n).padStart(2, '0');
function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

/** 회의 일정 달력 — 이벤트를 날짜에 표시하고 추가·삭제로 관리 */
export default function MeetingSchedule({ code, isHost, startsAt, endsAt }: Props) {
  const userId = useAuthStore((s) => s.user?.id);
  const [events, setEvents] = useState<MEvent[]>([]);
  const [offset, setOffset] = useState(0); // 월 이동
  const [selected, setSelected] = useState<string>(() => ymd(new Date()));
  const [title, setTitle] = useState('');
  const [time, setTime] = useState('');

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

  // 회의 메인 일정 날짜 (특별 표시)
  const meetingDay = startsAt ? ymd(new Date(startsAt)) : null;

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

  async function addEvent(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    await api(`/api/meetings/${code}/events`, {
      method: 'POST',
      body: { title, date: selected, time: time || null },
    });
    setTitle('');
    setTime('');
    void load();
  }
  async function removeEvent(id: number) {
    await api(`/api/meetings/${code}/events/${id}`, { method: 'DELETE' });
    void load();
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
            const isMeetingDay = c.key === meetingDay;
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
                    <span className="msched-chip meeting" title="이 회의 일정">
                      <i className="msched-chip-dot" />이 회의
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
        {selected === meetingDay && (
          <div className="msched-main-event">
            📌 이 회의 일정
            {startsAt && (
              <span>
                {' '}
                {new Date(startsAt).getHours()}:{pad(new Date(startsAt).getMinutes())}
                {endsAt &&
                  ` ~ ${new Date(endsAt).getHours()}:${pad(new Date(endsAt).getMinutes())}`}
              </span>
            )}
          </div>
        )}

        <div className="msched-events">
          {dayEvents.length === 0 ? (
            <div className="msched-empty">이 날 일정이 없어요</div>
          ) : (
            dayEvents.map((ev) => (
              <div key={ev.id} className="msched-event">
                {ev.time && <span className="msched-event-time">{ev.time}</span>}
                <span className="msched-event-title">{ev.title}</span>
                <span className="msched-event-author">{ev.author}</span>
                {(ev.created_by === userId || isHost) && (
                  <button className="msched-event-del" onClick={() => void removeEvent(ev.id)}>
                    ×
                  </button>
                )}
              </div>
            ))
          )}
        </div>

        <form className="msched-add" onSubmit={addEvent}>
          <div className="msched-add-row">
            <input
              className="msched-add-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={`${selectedLabel()} 일정 추가`}
              maxLength={80}
            />
            <input
              className="msched-add-time"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </div>
          <button type="submit" className="msched-add-btn" disabled={!title.trim()}>
            일정 추가
          </button>
          <p className="msched-add-hint">🔔 추가하면 회의 참가자 전원에게 알림이 가요</p>
        </form>
      </div>
    </div>
  );
}
