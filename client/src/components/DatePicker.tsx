import { useState } from 'react';
import { CalendarIcon } from './Icons';

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

/** 앱 디자인에 맞춘 커스텀 날짜 선택기 (월 달력 팝오버) */
export default function DatePicker({
  value,
  onChange,
  placeholder = '날짜 선택',
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const sel = value ? new Date(value + 'T00:00:00') : null;
  const [view, setView] = useState(() => {
    const base = sel ?? new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });

  const year = view.getFullYear();
  const month = view.getMonth();
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();
  const isToday = (d: number) =>
    d === today.getDate() && month === today.getMonth() && year === today.getFullYear();
  const isSel = (d: number) =>
    !!sel && d === sel.getDate() && month === sel.getMonth() && year === sel.getFullYear();

  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  return (
    <div className="datepick">
      <button type="button" className="datepick-btn" onClick={() => setOpen((v) => !v)}>
        <CalendarIcon size={14} />
        {value ? (
          <span className="datepick-val">{value.replace(/-/g, '. ')}</span>
        ) : (
          <span className="datepick-ph">{placeholder}</span>
        )}
      </button>
      {open && (
        <>
          <div className="datepick-back" onClick={() => setOpen(false)} />
          <div className="datepick-pop">
            <div className="datepick-head">
              <button type="button" onClick={() => setView(new Date(year, month - 1, 1))}>
                ‹
              </button>
              <span>
                {year}년 {month + 1}월
              </span>
              <button type="button" onClick={() => setView(new Date(year, month + 1, 1))}>
                ›
              </button>
            </div>
            <div className="datepick-dow">
              {DOW.map((d) => (
                <span key={d}>{d}</span>
              ))}
            </div>
            <div className="datepick-grid">
              {cells.map((d, i) =>
                d === null ? (
                  <span key={i} />
                ) : (
                  <button
                    type="button"
                    key={i}
                    className={`datepick-day${isSel(d) ? ' sel' : ''}${isToday(d) ? ' today' : ''}`}
                    onClick={() => {
                      onChange(ymd(new Date(year, month, d)));
                      setOpen(false);
                    }}
                  >
                    {d}
                  </button>
                ),
              )}
            </div>
            {value && (
              <button
                type="button"
                className="datepick-clear"
                onClick={() => {
                  onChange(null);
                  setOpen(false);
                }}
              >
                지우기
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
