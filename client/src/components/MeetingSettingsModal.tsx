import { useEffect, useState } from 'react';
import { api } from '../api';

interface MeetingInfo {
  code: string;
  title: string;
  starts_at: string | null;
  ends_at: string | null;
}

interface Props {
  meeting: MeetingInfo | null; // null이면 닫힘
  onClose: () => void;
  onChanged: () => void;
}

/** ISO/SQLite datetime → datetime-local 입력값 */
function toLocalInput(v: string | null): string {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function MeetingSettingsModal({ meeting, onClose, onChanged }: Props) {
  const [title, setTitle] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!meeting) return;
    setTitle(meeting.title);
    setStart(toLocalInput(meeting.starts_at));
    setEnd(toLocalInput(meeting.ends_at));
    setConfirmDelete(false);
  }, [meeting]);

  useEffect(() => {
    if (!meeting) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [meeting, onClose]);

  if (!meeting) return null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      await api(`/api/meetings/${meeting!.code}`, {
        method: 'PATCH',
        body: { title, starts_at: start || null, ends_at: end || null },
      });
      onChanged();
      onClose();
    } catch {
      /* 전역 에러 토스트 (호스트 아님 등) */
    }
  }

  async function remove() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    try {
      await api(`/api/meetings/${meeting!.code}`, { method: 'DELETE' });
      onChanged();
      onClose();
    } catch {
      /* 전역 에러 토스트 */
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={save}>
          <div className="modal-head">회의 설정</div>
          <label className="modal-label">
            회의 이름
            <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </label>
          <label className="modal-label">
            시작
            <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="modal-label">
            종료
            <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
          <div className="modal-actions">
            <button type="button" className="modal-cancel" onClick={onClose}>
              취소
            </button>
            <button type="submit" className="modal-primary" disabled={!title.trim()}>
              저장
            </button>
          </div>
        </form>

        <button className={`modal-danger${confirmDelete ? ' confirm' : ''}`} onClick={remove}>
          {confirmDelete ? '정말 삭제할까요? 채팅 기록도 사라져요 — 한 번 더 클릭' : '회의 삭제'}
        </button>
        <div className="modal-hint">수정·삭제는 호스트만 가능해요</div>
      </div>
    </div>
  );
}
