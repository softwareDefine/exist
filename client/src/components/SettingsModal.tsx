import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuthStore } from '../store';

const AVATARS = ['🐧', '🦊', '🐻', '🐼', '🐯', '🦁', '🐸', '🐰', '🦉', '🐢', '🐳', '🚀'];

interface Props {
  open: boolean;
  onClose: () => void;
  avatar: string;
  onAvatarChange: (a: string) => void;
}

export default function SettingsModal({ open, onClose, avatar, onAvatarChange }: Props) {
  const user = useAuthStore((s) => s.user);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pwError, setPwError] = useState('');
  const [pwDone, setPwDone] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCurrent('');
    setNext('');
    setConfirm('');
    setPwError('');
    setPwDone(false);
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function pickAvatar(a: string) {
    onAvatarChange(a); // 낙관적 반영
    try {
      await api('/api/auth/me', { method: 'PATCH', body: { avatar: a } });
    } catch {
      /* 전역 토스트 */
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwError('');
    setPwDone(false);
    if (next.length < 8) return setPwError('새 비밀번호는 8자 이상이어야 합니다');
    if (next !== confirm) return setPwError('새 비밀번호가 서로 다릅니다');
    try {
      await api('/api/auth/password', {
        method: 'POST',
        body: { currentPassword: current, newPassword: next },
      });
      setPwDone(true);
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      setPwError(err instanceof Error ? err.message : '변경에 실패했습니다');
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">설정</div>
        <div className="settings-user">
          <span className="settings-avatar">{avatar}</span>
          <b>{user?.username}</b>
        </div>

        <div className="settings-section">아바타</div>
        <div className="avatar-grid">
          {AVATARS.map((a) => (
            <button
              key={a}
              className={`avatar-pick${a === avatar ? ' active' : ''}`}
              onClick={() => void pickAvatar(a)}
            >
              {a}
            </button>
          ))}
        </div>

        <div className="settings-section">비밀번호 변경</div>
        <form onSubmit={changePassword}>
          <label className="modal-label">
            현재 비밀번호
            <input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          <label className="modal-label">
            새 비밀번호 (8자 이상)
            <input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          <label className="modal-label">
            새 비밀번호 확인
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          {pwError && <div className="error" style={{ color: '#d33', fontSize: 13 }}>{pwError}</div>}
          {pwDone && (
            <div style={{ color: 'var(--green)', fontSize: 13, fontWeight: 700 }}>
              ✓ 비밀번호가 변경됐어요 (다른 기기 세션은 모두 로그아웃됨)
            </div>
          )}
          <div className="modal-actions">
            <button type="button" className="modal-cancel" onClick={onClose}>
              닫기
            </button>
            <button
              type="submit"
              className="modal-primary"
              disabled={!current || !next || !confirm}
            >
              비밀번호 변경
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
