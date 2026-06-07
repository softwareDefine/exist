import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export default function CreateMeetingModal({ open, onClose, onCreated }: Props) {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [created, setCreated] = useState<{ code: string; title: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // 모달이 열리는 순간에만 초기화 (onClose 정체성 변화에 영향받지 않게 분리)
  useEffect(() => {
    if (!open) return;
    setTitle('');
    setStart('');
    setEnd('');
    setCreated(null);
    setCopied(false);
  }, [open]);

  // ESC 닫기
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      const m = await api<{ code: string; title: string }>('/api/meetings', {
        method: 'POST',
        body: { title, starts_at: start || null, ends_at: end || null },
      });
      setCreated({ code: m.code, title });
      onCreated();
    } catch {
      /* 전역 에러 토스트가 표시 */
    }
  }

  async function copyCode() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* 수동 복사 */
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        {created ? (
          <>
            <div className="modal-head">🎉 회의가 만들어졌어요</div>
            <div className="modal-sub">팀원에게 코드를 공유하면 바로 참여할 수 있어요</div>
            <div className="meeting-code-box" onClick={copyCode} title="클릭해서 복사">
              {created.code}
            </div>
            <button className="modal-ghost" onClick={copyCode}>
              {copied ? '✓ 복사됨' : '코드 복사하기'}
            </button>
            <div className="modal-actions">
              <button className="modal-cancel" onClick={onClose}>
                닫기
              </button>
              <button
                className="modal-primary"
                onClick={() => navigate(`/meeting/${created.code}`)}
              >
                지금 입장
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={submit}>
            <div className="modal-head">새 회의 만들기</div>
            <label className="modal-label">
              회의 이름
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="예: 주간 스프린트 리뷰"
                autoFocus
              />
            </label>
            <label className="modal-label">
              시작 (선택)
              <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
            </label>
            <label className="modal-label">
              종료 (선택)
              <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
            </label>
            <div className="modal-actions">
              <button type="button" className="modal-cancel" onClick={onClose}>
                취소
              </button>
              <button type="submit" className="modal-primary" disabled={!title.trim()}>
                만들기
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
