import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useAuthStore } from '../store';
import Avatar from './Avatar';
import { SunIcon, MoonIcon } from './Icons';

const AVATARS = ['🐧', '🦊', '🐻', '🐼', '🐯', '🦁', '🐸', '🐰', '🦉', '🐢', '🐳', '🚀'];

interface Props {
  open: boolean;
  onClose: () => void;
  avatar: string;
  onAvatarChange: (a: string) => void;
}

export default function SettingsModal({ open, onClose, avatar, onAvatarChange }: Props) {
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.token);
  const logout = useAuthStore((s) => s.logout);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pwError, setPwError] = useState('');
  const [pwDone, setPwDone] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // 다크모드 — 모바일에선 헤더 토글이 없어서 여기서 변경 (.settings-theme는 모바일에서만 노출)
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  function toggleTheme() {
    const nextDark = !dark;
    document.documentElement.classList.toggle('dark', nextDark);
    localStorage.setItem('exist:theme', nextDark ? 'dark' : 'light');
    setDark(nextDark);
  }

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

  async function uploadPhoto(file: File) {
    if (!file.type.startsWith('image/')) {
      window.dispatchEvent(new CustomEvent('app:error', { detail: '이미지 파일만 올릴 수 있어요' }));
      return;
    }
    setUploading(true);
    try {
      const res = await fetch('/api/auth/avatar', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': file.type },
        body: file,
      });
      const data = (await res.json()) as { avatar?: string; error?: string };
      if (!res.ok || !data.avatar) throw new Error(data.error ?? '업로드 실패');
      onAvatarChange(data.avatar);
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
          <Avatar value={avatar} className="settings-avatar" />
          <b>{user?.username}</b>
          {/* 모바일 전용 — 헤더 프로필 메뉴가 없어서 로그아웃이 여기 */}
          <button className="settings-logout" onClick={logout}>
            로그아웃
          </button>
        </div>

        <div className="settings-theme">
          <div className="settings-section">화면 테마</div>
          <button type="button" className="theme-row" onClick={toggleTheme}>
            <span className="theme-row-label">
              {dark ? <MoonIcon size={16} /> : <SunIcon size={16} />}
              {dark ? '다크 모드' : '라이트 모드'}
            </span>
            <span className={`theme-switch${dark ? ' on' : ''}`}>
              <span className="theme-knob" />
            </span>
          </button>
        </div>

        <div className="settings-section">프로필 사진</div>
        <div className="avatar-upload">
          <button
            className="avatar-upload-btn"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? '올리는 중…' : '📷 사진 업로드'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void uploadPhoto(f);
              e.target.value = '';
            }}
          />
          <span className="avatar-upload-hint">JPG·PNG, 최대 5MB</span>
        </div>

        <div className="settings-section">이모지로 선택</div>
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
