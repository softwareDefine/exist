import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useAuthStore } from '../store';
import MeetingThumb from './MeetingThumb';

interface MeetingInfo {
  id: number;
  code: string;
  title: string;
  starts_at: string | null;
  ends_at: string | null;
  thumbnail?: string | null;
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
  const token = useAuthStore((s) => s.token);
  const [title, setTitle] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [thumb, setThumb] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!meeting) return;
    setTitle(meeting.title);
    setStart(toLocalInput(meeting.starts_at));
    setEnd(toLocalInput(meeting.ends_at));
    setThumb(meeting.thumbnail ?? null);
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

  async function uploadThumb(file: File) {
    if (!file.type.startsWith('image/')) {
      window.dispatchEvent(new CustomEvent('app:error', { detail: '이미지 파일만 올릴 수 있어요' }));
      return;
    }
    setUploading(true);
    try {
      const res = await fetch(`/api/meetings/${meeting!.code}/thumbnail`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': file.type },
        body: file,
      });
      const data = (await res.json()) as { thumbnail?: string; error?: string };
      if (!res.ok || !data.thumbnail) throw new Error(data.error ?? '업로드 실패');
      setThumb(data.thumbnail);
      onChanged();
    } catch (err) {
      window.dispatchEvent(
        new CustomEvent('app:error', {
          detail: err instanceof Error ? err.message : '사진 업로드에 실패했어요',
        }),
      );
    } finally {
      setUploading(false);
    }
  }

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
      const code = meeting!.code;
      await api(`/api/meetings/${code}`, { method: 'DELETE' });
      window.dispatchEvent(new CustomEvent('exist:meeting-deleted', { detail: { code } }));
      window.dispatchEvent(new CustomEvent('exist:schedule-changed'));
      onChanged();
      onClose();
    } catch {
      /* 전역 에러 토스트 */
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">회의 설정</div>

        {/* 회의 사진 */}
        <div className="meeting-photo">
          <MeetingThumb
            id={meeting.id}
            title={title || meeting.title}
            thumbnail={thumb}
            className="meeting-photo-thumb"
          />
          <div className="meeting-photo-actions">
            <button
              className="avatar-upload-btn"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? '올리는 중…' : thumb ? '📷 사진 변경' : '📷 사진 추가'}
            </button>
            <span className="avatar-upload-hint">JPG·PNG, 최대 5MB · 호스트만</span>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void uploadThumb(f);
              e.target.value = '';
            }}
          />
        </div>

        <form onSubmit={save}>
          <label className="modal-label">
            회의 이름
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
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
