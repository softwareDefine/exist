import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useAuthStore } from '../store';
import { PhoneIcon } from './Icons';
import Marquee from './Marquee';

interface MEvent {
  id: number;
  title: string;
  date: string; // YYYY-MM-DD
  time: string | null; // HH:MM (시작)
  end_time: string | null; // HH:MM (종료)
  is_call?: number; // 1이면 통화 일정 (10분 전 "통화 들어오세요" 알림)
  memo: string | null; // 일정 메모 (애플 캘린더식)
  people: { id: number; username: string; name: string | null }[]; // 관련자
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
  /** 회의 참가자 — 일정 관련자 선택 칩에 사용 */
  participants?: { userId: number; username: string }[];
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

type ViewMode = 'day' | 'week' | 'month';
const VIEW_LABEL: Record<ViewMode, string> = { day: '일', week: '주', month: '월' };

/** 주 뷰 한 시간 행 높이(px) — CSS .msched-week-cell 높이와 일치해야 함 */
const WEEK_ROWH = 40;

/** 시간 눈금 라벨 — 0→오전 12시, 13→오후 1시, 24→오전 12시 */
function hourLabel(h: number): string {
  const ampm = h % 24 < 12 ? '오전' : '오후';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${ampm} ${hh}시`;
}

/** 분 단위 시작·종료 → 주 뷰 블록 top/height (종료 없으면 1시간) */
function blockPos(startMin: number, endMin: number | null) {
  const dur = Math.max((endMin ?? startMin + 60) - startMin, 20);
  return {
    top: (startMin / 60) * WEEK_ROWH,
    height: (dur / 60) * WEEK_ROWH,
  };
}

const toMin = (t: string) => parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3, 5), 10);

/** 겹침 배치 기준 — 시작 차이가 이 분 미만이면 제목이 가려지므로 좌우 분할, 이상이면 애플식 겹쳐 얹기 */
const NEAR_MIN = 30;

/** 일·주 뷰 — 겹치는 시간 일정 배치 (애플 캘린더식).
 *  시작이 가까우면 좌우 분할(col/ncols), 시작이 충분히 다르면 들여쓰기(indent)해서
 *  위에 겹쳐 얹는다 — 앞 일정의 제목 줄은 가려지지 않음. z는 나중 시작이 위. */
function layoutDayBlocks(evts: MEvent[]) {
  const items = evts
    .map((ev) => {
      const sm = toMin(ev.time!);
      const em = ev.end_time ? Math.max(toMin(ev.end_time), sm + 20) : sm + 60;
      return { ev, sm, em, col: 0, ncols: 1, indent: 0, z: 1 };
    })
    .sort((a, b) => a.sm - b.sm || b.em - a.em);
  const placed: typeof items = [];
  items.forEach((it, i) => {
    it.z = i + 1;
    const overlaps = placed.filter((p) => p.em > it.sm);
    const cascade = overlaps.filter((p) => it.sm - p.sm >= NEAR_MIN);
    it.indent = cascade.length > 0 ? Math.max(...cascade.map((p) => p.indent)) + 1 : 0;
    // 같은 들여쓰기 단계에서 시작이 가까운 것들과는 빈 열 찾아 좌우 분할
    const near = overlaps.filter((p) => it.sm - p.sm < NEAR_MIN && p.indent === it.indent);
    const used = new Set(near.map((p) => p.col));
    while (used.has(it.col)) it.col++;
    placed.push(it);
  });
  for (const it of items) {
    const peers = items.filter(
      (o) =>
        o.indent === it.indent && o.em > it.sm && it.em > o.sm && Math.abs(o.sm - it.sm) < NEAR_MIN,
    );
    it.ncols = Math.max(...peers.map((p) => p.col), it.col) + 1;
  }
  return items;
}

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
  participants = [],
}: Props) {
  const userId = useAuthStore((s) => s.user?.id);
  const [events, setEvents] = useState<MEvent[]>([]);
  const [view, setView] = useState<ViewMode>('month');
  const [cursor, setCursor] = useState<Date>(() => new Date()); // 뷰 기준 날짜
  const [selected, setSelected] = useState<string>(() => ymd(new Date()));
  const [title, setTitle] = useState('');
  const [time, setTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [allDay, setAllDay] = useState(false); // 하루 종일 — 시간 없이 날짜에만 (애플 캘린더식)
  const [isCall, setIsCall] = useState(false);
  const [memo, setMemo] = useState('');
  const [people, setPeople] = useState<{ id: number; username: string }[]>([]); // 선택된 관련자
  const [pq, setPq] = useState(''); // 관련자 검색어
  const [pplOpen, setPplOpen] = useState(false);
  const [pplIdx, setPplIdx] = useState(0);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [now, setNow] = useState<Date>(() => new Date()); // 일·주 뷰 "지금" 선
  const dayviewRef = useRef<HTMLDivElement | null>(null);
  const weekRef = useRef<HTMLDivElement | null>(null);

  // 일·주 뷰일 때만 30초마다 현재 시각 갱신
  useEffect(() => {
    if (view === 'month') return;
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, [view]);

  // 일 뷰 진입 시 지금 시각 근처로 스크롤
  useEffect(() => {
    if (view !== 'day') return;
    const el = dayviewRef.current?.querySelector<HTMLElement>(`[data-hour="${new Date().getHours()}"]`);
    el?.scrollIntoView({ block: 'center' });
  }, [view, selected]);

  // 주 뷰 진입 시 지금 시각 근처로 스크롤
  useEffect(() => {
    if (view !== 'week') return;
    const box = weekRef.current;
    if (!box) return;
    const headH = box.querySelector('.msched-week-head')?.clientHeight ?? 0;
    const nowTop = ((new Date().getHours() * 60 + new Date().getMinutes()) / 60) * WEEK_ROWH;
    box.scrollTop = Math.max(0, headH + nowTop - box.clientHeight / 2);
  }, [view]);

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

  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const todayKey = ymd(new Date());

  // 월 뷰 셀
  const first = new Date(year, month, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
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

  // 주 뷰: cursor가 속한 주 (일요일 시작)
  const weekDays = useMemo(() => {
    const start = new Date(cursor);
    start.setDate(start.getDate() - start.getDay());
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [cursor]);

  const dayEvents = byDate.get(selected) ?? [];

  function nav(dir: -1 | 1) {
    const c = new Date(cursor);
    if (view === 'month') {
      c.setDate(1);
      c.setMonth(c.getMonth() + dir);
    } else if (view === 'week') {
      c.setDate(c.getDate() + 7 * dir);
    } else {
      c.setDate(c.getDate() + dir);
    }
    setCursor(c);
    if (view === 'day') setSelected(ymd(c));
  }

  function goToday() {
    const t = new Date();
    setCursor(t);
    setSelected(ymd(t));
  }

  function switchView(v: ViewMode) {
    setView(v);
    // 일 뷰는 커서=선택 날짜로 정렬
    if (v === 'day') setCursor(new Date(selected + 'T00:00'));
  }

  function headLabel(): string {
    if (view === 'month') return `${year}년 ${month + 1}월`;
    if (view === 'week') {
      const a = weekDays[0];
      const b = weekDays[6];
      const left = `${a.getMonth() + 1}월 ${a.getDate()}일`;
      const right =
        a.getMonth() === b.getMonth() ? `${b.getDate()}일` : `${b.getMonth() + 1}월 ${b.getDate()}일`;
      return `${left} ~ ${right}`;
    }
    const d = new Date(selected + 'T00:00');
    return `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW[d.getDay()]})`;
  }

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
    setAllDay(false);
    setIsCall(false);
    setMemo('');
    setPeople([]);
    setPq('');
    setPplOpen(false);
    setEditingId(null);
  }

  function startEdit(ev: MEvent) {
    setEditingId(ev.id);
    setSelected(ev.date);
    setTitle(ev.title);
    setAllDay(!ev.time);
    setTime(ev.time ?? '');
    setEndTime(ev.end_time ?? '');
    setIsCall(!!ev.is_call);
    setMemo(ev.memo ?? '');
    setPeople(ev.people?.map((p) => ({ id: p.id, username: p.name || p.username })) ?? []);
  }

  // 검색어에 맞는 참가자 (이미 선택된 사람 제외, 최대 8명)
  const pplMatches = useMemo(() => {
    const q = pq.trim().toLowerCase();
    return participants
      .filter((p) => !people.some((s) => s.id === p.userId))
      .filter((p) => !q || p.username.toLowerCase().includes(q))
      .slice(0, 8);
  }, [participants, people, pq]);

  function addPerson(p: { userId: number; username: string }) {
    setPeople((prev) => [...prev, { id: p.userId, username: p.username }]);
    setPq('');
    setPplIdx(0);
  }

  function removePerson(id: number) {
    setPeople((prev) => prev.filter((x) => x.id !== id));
  }

  function pplKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !pq && people.length > 0) {
      removePerson(people[people.length - 1].id);
      return;
    }
    if (!pplOpen || pplMatches.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setPplIdx((i) => (i + 1) % pplMatches.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setPplIdx((i) => (i - 1 + pplMatches.length) % pplMatches.length);
    } else if (e.key === 'Enter') {
      e.preventDefault(); // 폼 제출 막고 선택으로
      addPerson(pplMatches[Math.min(pplIdx, pplMatches.length - 1)]);
    } else if (e.key === 'Escape') {
      setPplOpen(false);
    }
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
      time: allDay ? null : time || null,
      end_time: !allDay && time ? endTime || null : null,
      is_call: isCall && !allDay && !!time, // 통화는 시작 시간이 있어야 의미 있음
      memo: memo.trim() || null,
      people: people.map((p) => p.id),
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

  // 일 뷰 타임라인 재료
  const timed = [...dayEvents.filter((e) => e.time)].sort((a, b) =>
    a.time!.localeCompare(b.time!),
  );
  const untimed = dayEvents.filter((e) => !e.time);
  const meetingToday = isMeetingDayKey(selected);
  const meetStart = startsAt ? new Date(startsAt) : null;
  const meetOk = meetingToday && meetStart != null && !isNaN(meetStart.getTime());
  // 오전 12시(0시) ~ 밤 11시 — 하루 전체 시간선
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const isToday = selected === todayKey;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  // 지금 배지와 겹치는 눈금 라벨은 숨김 (정각 ±20분)
  const labelHidden = (h: number) => Math.abs(nowMin - h * 60) < 20;
  const todayInWeek = weekDays.some((d) => ymd(d) === todayKey);

  const eventRow = (ev: MEvent, compact = false) => (
    <div
      key={ev.id}
      className={'msched-event' + (compact ? ' compact' : '') + (ev.is_call ? ' call' : '')}
    >
      {!ev.time && <span className="msched-event-time allday">하루 종일</span>}
      {ev.time && (
        <span className="msched-event-time">
          {ev.time}
          {ev.end_time ? `~${ev.end_time}` : ''}
        </span>
      )}
      <Marquee className="msched-event-title">
        {ev.is_call ? (
          <span className="msched-call-ic">
            <PhoneIcon size={12} />
          </span>
        ) : null}
        {ev.title}
      </Marquee>
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
          <button className="msched-event-del" title="삭제" onClick={() => void removeEvent(ev.id)}>
            ×
          </button>
        </>
      )}
      {/* 관련자·메모 — 있는 것만 다음 줄에 (애플 캘린더 상세 느낌) */}
      {((ev.people?.length ?? 0) > 0 || ev.memo) && (
        <div className="msched-event-extra">
          {(ev.people?.length ?? 0) > 0 && (
            <span className="msched-event-ppl">
              {ev.people.map((p) => (
                <span key={p.id} className="msched-event-person">
                  {p.name || p.username}
                </span>
              ))}
            </span>
          )}
          {ev.memo && <span className="msched-event-memo">{ev.memo}</span>}
        </div>
      )}
    </div>
  );

  return (
    <div className={`msched msched-view-${view}`}>
      <div className="msched-cal">
        <div className="msched-cal-head">
          <button onClick={() => nav(-1)} aria-label="이전">
            ‹
          </button>
          <span className="msched-head-label">{headLabel()}</span>
          <button onClick={() => nav(1)} aria-label="다음">
            ›
          </button>
          <button type="button" className="msched-today-btn" onClick={goToday}>
            오늘
          </button>
          <div className="msched-seg" role="tablist" aria-label="일정 보기 단위">
            {(['day', 'week', 'month'] as const).map((v) => (
              <button
                key={v}
                type="button"
                className={view === v ? 'on' : ''}
                onClick={() => switchView(v)}
              >
                {VIEW_LABEL[v]}
              </button>
            ))}
          </div>
        </div>

        {view === 'week' && (
          <div className="msched-weekwrap" ref={weekRef}>
            {/* 헤더 + 종일 레인을 한 덩어리로 sticky — 따로 붙이면 스크롤 중 겹쳐 높이가 변해 보임 */}
            <div className="msched-week-sticky">
            <div className="msched-week-head">
              <span className="msched-week-gutter-spacer" />
              {weekDays.map((d) => {
                const key = ymd(d);
                const dayUntimed = (byDate.get(key) ?? []).filter((e) => !e.time);
                return (
                  <button
                    key={key}
                    className={
                      'msched-wday-btn' +
                      (key === selected ? ' sel' : '') +
                      (key === todayKey ? ' today' : '')
                    }
                    onClick={() => setSelected(key)}
                  >
                    <span className="msched-wcol-dow">{DOW[d.getDay()]}</span>
                    <span className={'msched-wcol-num' + (key === todayKey ? ' today' : '')}>
                      {d.getDate()}
                    </span>
                    {dayUntimed.length > 0 && (
                      <span className="msched-wday-untimed" title="하루 종일 일정">
                        {dayUntimed.length}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* 하루 종일 레인 — 날짜 헤더 바로 아래, 애플 캘린더식 */}
            {weekDays.some((d) => (byDate.get(ymd(d)) ?? []).some((e) => !e.time)) && (
              <div className="msched-week-allday">
                <span className="msched-week-gutter-spacer allday">종일</span>
                {weekDays.map((d) => {
                  const key = ymd(d);
                  const dayUntimed = (byDate.get(key) ?? []).filter((e) => !e.time);
                  return (
                    <div
                      key={key}
                      className={'msched-wallday-col' + (key === selected ? ' sel' : '')}
                      onClick={() => setSelected(key)}
                    >
                      {dayUntimed.map((e) => (
                        <span key={e.id} className="msched-wallday-chip" title={`${e.title} · ${e.author}${e.memo ? ` — ${e.memo}` : ''}`}>
                          {e.title}
                        </span>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
            </div>
            <div className="msched-week-body">
              <div className="msched-week-gutter">
                {hours.map((h) => (
                  <span key={h} className="msched-week-hlabel">
                    {todayInWeek && labelHidden(h) ? '' : hourLabel(h)}
                  </span>
                ))}
                <span className="msched-week-hlabel end">{hourLabel(24)}</span>
                {todayInWeek && (
                  <span
                    className="msched-nowline-time week"
                    style={{ top: ((now.getHours() * 60 + now.getMinutes()) / 60) * WEEK_ROWH }}
                  >
                    {pad(now.getHours())}:{pad(now.getMinutes())}
                  </span>
                )}
              </div>
              <div className="msched-week-grid">
                {weekDays.map((d) => {
                  const key = ymd(d);
                  const dayTimed = (byDate.get(key) ?? [])
                    .filter((e) => e.time)
                    .sort((a, b) => a.time!.localeCompare(b.time!));
                  const meet = isMeetingDayKey(key);
                  return (
                    <div
                      key={key}
                      className={
                        'msched-week-col' +
                        (key === selected ? ' sel' : '') +
                        (key === todayKey ? ' today' : '')
                      }
                    >
                      {hours.map((h) => (
                        <div
                          key={h}
                          className="msched-week-cell"
                          onClick={() => {
                            setSelected(key);
                            setTime(`${pad(h)}:00`);
                            setEndTime('');
                          }}
                          title="이 시간으로 일정 추가"
                        />
                      ))}
                      {meet && meetStart && !isNaN(meetStart.getTime()) && (
                        <div
                          className="msched-wblock meeting"
                          style={blockPos(
                            meetStart.getHours() * 60 + meetStart.getMinutes(),
                            endsAt
                              ? new Date(endsAt).getHours() * 60 + new Date(endsAt).getMinutes()
                              : null,
                          )}
                          title="이 그룹 일정"
                        >
                          📌 이 그룹
                        </div>
                      )}
                      {/* 겹치는 일정은 일 뷰와 같은 열 분할 (포개져 안 보이던 문제) */}
                      {layoutDayBlocks(dayTimed).map(({ ev: e, sm, em, col, ncols, indent, z }) => (
                        <button
                          key={e.id}
                          className={'msched-wblock' + (e.is_call ? ' call' : '')}
                          style={{
                            ...blockPos(sm, em),
                            left: `calc((100% - ${indent * 8 + 4}px) * ${(col / ncols).toFixed(4)} + ${indent * 8 + 2}px)`,
                            width: `calc((100% - ${indent * 8 + 4}px) / ${ncols})`,
                            zIndex: z,
                          }}
                          title={`${e.time} ${e.title}${e.memo ? ` — ${e.memo}` : ''}`}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            setSelected(key);
                          }}
                        >
                          {/* 애플처럼 제목 먼저, 시간은 아랫줄 */}
                          <span className="msched-wblock-t">{e.title}</span>
                          <span className="msched-wblock-time">
                            {e.time}
                            {e.end_time ? `~${e.end_time}` : ''}
                          </span>
                        </button>
                      ))}
                      {todayInWeek && (
                        <div
                          className={'msched-nowline week' + (key === todayKey ? '' : ' dim')}
                          style={{ top: (nowMin / 60) * WEEK_ROWH }}
                        >
                          {key === todayKey && <i className="msched-nowline-dot" />}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {view === 'day' && (
          <div className="msched-dayview" ref={dayviewRef}>
            {untimed.length > 0 && (
              <div className="msched-allday">
                <span className="msched-hour-label">종일</span>
                <div className="msched-allday-list">{untimed.map((e) => eventRow(e, true))}</div>
              </div>
            )}
            <div className="msched-hours">
              {hours.map((h) => (
                <div
                  key={h}
                  data-hour={h}
                  className="msched-hour"
                  onClick={() => {
                    setAllDay(false);
                    setTime(`${pad(h)}:00`);
                    setEndTime('');
                  }}
                  title="이 시간으로 일정 추가"
                >
                  <span className="msched-hour-label">
                    {isToday && labelHidden(h) ? '' : hourLabel(h)}
                  </span>
                  {isToday && now.getHours() === h && (
                    <div
                      className="msched-nowline"
                      style={{ top: `${(now.getMinutes() / 60) * 100}%` }}
                    >
                      <span className="msched-nowline-time">
                        {pad(now.getHours())}:{pad(now.getMinutes())}
                      </span>
                    </div>
                  )}
                  <div className="msched-hour-slot" />
                </div>
              ))}

              {/* 시간 일정 — 주 뷰처럼 분 비례 절대 배치 (칸이 늘어나 시간선이 밀리던 문제 해결) */}
              <div className="msched-day-layer">
                {meetOk && (
                  <div
                    className="msched-dblock meeting"
                    style={blockPos(
                      meetStart!.getHours() * 60 + meetStart!.getMinutes(),
                      endsAt
                        ? new Date(endsAt).getHours() * 60 + new Date(endsAt).getMinutes()
                        : null,
                    )}
                  >
                    <span className="msched-event-title">📌 이 그룹 일정</span>
                    <span className="msched-event-time">
                      {meetStart!.getHours()}:{pad(meetStart!.getMinutes())}
                      {endsAt &&
                        `~${new Date(endsAt).getHours()}:${pad(new Date(endsAt).getMinutes())}`}
                    </span>
                    {isHost && recur !== 'none' && (
                      <button
                        type="button"
                        className="msched-occ-del"
                        onClick={(e) => {
                          e.stopPropagation();
                          void excludeOccurrence();
                        }}
                      >
                        이 회차 삭제
                      </button>
                    )}
                  </div>
                )}
                {layoutDayBlocks(timed).map(({ ev, sm, em, col, ncols, indent, z }) => (
                  <div
                    key={ev.id}
                    className={'msched-dblock' + (ev.is_call ? ' call' : '')}
                    style={{
                      top: (sm / 60) * WEEK_ROWH,
                      height: Math.max(((em - sm) / 60) * WEEK_ROWH - 2, 22),
                      left: `calc((100% - ${indent * 12}px) * ${(col / ncols).toFixed(4)} + ${indent * 12 + (col > 0 ? 2 : 0)}px)`,
                      width: `calc((100% - ${indent * 12}px) / ${ncols}${ncols > 1 ? ' - 2px' : ''})`,
                      zIndex: z,
                    }}
                  >
                    <Marquee className="msched-event-title">
                      {ev.is_call ? (
                        <span className="msched-call-ic">
                          <PhoneIcon size={12} />
                        </span>
                      ) : null}
                      {ev.title}
                    </Marquee>
                    <span className="msched-event-time">
                      {ev.time}
                      {ev.end_time ? `~${ev.end_time}` : ''}
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
                ))}
              </div>
              {/* 하루 끝 경계선 */}
              <div className="msched-hour msched-hour-end" aria-hidden>
                <span className="msched-hour-label">{hourLabel(24)}</span>
                <div className="msched-hour-slot" />
              </div>
            </div>
          </div>
        )}

        {view === 'month' && (
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
        )}
      </div>

      <div className="msched-day-panel">
        {view !== 'day' && <div className="msched-day-title">{selectedLabel()}</div>}

        {/* 회의 본 일정이 이 날이면 표시 (일 뷰는 타임라인에 이미 있음) */}
        {view !== 'day' && isMeetingDayKey(selected) && (
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

        {view !== 'day' && (
          <div className="msched-events">
            {dayEvents.length === 0 ? (
              <div className="msched-empty">이 날 일정이 없어요</div>
            ) : (
              dayEvents.map((ev) => eventRow(ev))
            )}
          </div>
        )}
        {view === 'day' && dayEvents.length === 0 && !meetingToday && (
          <div className="msched-empty">이 날 일정이 없어요 — 시간을 눌러 바로 추가할 수 있어요</div>
        )}

        <form className="msched-add" onSubmit={addEvent}>
          <input
            className="msched-add-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={`${selectedLabel()} 통화/일정 제목`}
            maxLength={80}
          />
          <div className="msched-add-times">
            {/* 하루 종일 — 켜면 시간 없이 날짜에만 등록 (애플 캘린더식) */}
            <button
              type="button"
              className={`msched-call-sw${allDay ? ' on' : ''}`}
              onClick={() =>
                setAllDay((v) => {
                  const next = !v;
                  if (next) {
                    setTime('');
                    setEndTime('');
                    setIsCall(false);
                  }
                  return next;
                })
              }
              title="시간 없이 하루 종일 일정으로 등록"
            >
              하루 종일
              <span className={`msched-sw${allDay ? ' on' : ''}`}>
                <i />
              </span>
            </button>
            {!allDay && (
              <>
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
              </>
            )}
          </div>
          {/* 관련자 — 검색해서 추가 (애플 캘린더 초대 느낌) */}
          {participants.length > 0 && (
            <div className="msched-add-people">
              <span className="msched-people-label">관련자</span>
              {people.map((p) => (
                <span key={p.id} className="msched-person on">
                  {p.username}
                  <button
                    type="button"
                    className="msched-person-x"
                    aria-label={`${p.username} 제외`}
                    onClick={() => removePerson(p.id)}
                  >
                    ×
                  </button>
                </span>
              ))}
              <div className="msched-ppl-search">
                <input
                  value={pq}
                  onChange={(e) => {
                    setPq(e.target.value);
                    setPplIdx(0);
                  }}
                  onFocus={() => setPplOpen(true)}
                  onBlur={() => setPplOpen(false)}
                  onKeyDown={pplKeyDown}
                  placeholder={people.length === 0 ? '참가자 검색해서 추가' : '더 추가'}
                />
                {pplOpen && pplMatches.length > 0 && (
                  <div className="msched-ppl-pop">
                    {pplMatches.map((p, i) => (
                      <button
                        type="button"
                        key={p.userId}
                        className={'msched-ppl-item' + (i === pplIdx ? ' active' : '')}
                        // blur보다 먼저 잡아야 클릭이 살아남음 (MentionInput과 동일한 트릭)
                        onMouseDown={(e) => {
                          e.preventDefault();
                          addPerson(p);
                        }}
                        onMouseEnter={() => setPplIdx(i)}
                      >
                        {p.username}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
          <input
            className="msched-add-memo"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="메모 (선택)"
            maxLength={500}
          />
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
