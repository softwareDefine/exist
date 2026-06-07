import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuthStore, type User } from '../store';
import AuthShell from '../components/AuthShell';
import RecoveryCode from '../components/RecoveryCode';

export default function ForgotPage() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [username, setUsername] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [newCode, setNewCode] = useState('');
  const [pendingAuth, setPendingAuth] = useState<{ token: string; user: User } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password.length < 8) return setError('비밀번호는 8자 이상이어야 합니다');
    if (password !== confirm) return setError('비밀번호가 서로 다릅니다');
    try {
      const data = await api<{ token: string; user: User; recoveryCode: string }>(
        '/api/auth/reset',
        { method: 'POST', body: { username, recoveryCode: code, newPassword: password } },
      );
      setNewCode(data.recoveryCode);
      setPendingAuth({ token: data.token, user: data.user });
    } catch (e) {
      setError(e instanceof Error ? e.message : '재설정에 실패했습니다');
    }
  }

  function start() {
    if (pendingAuth) setAuth(pendingAuth.token, pendingAuth.user);
    navigate('/');
  }

  if (newCode) {
    return (
      <AuthShell>
        <div className="auth-heading">비밀번호가 변경됐어요</div>
        <RecoveryCode code={newCode} />
        <button type="button" className="submit" onClick={start}>
          시작하기
        </button>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <form onSubmit={submit} style={{ display: 'contents' }}>
        <div className="auth-heading">비밀번호 재설정</div>
        <div className="auth-hint">가입할 때 받은 복구 코드가 필요해요</div>
        <input
          placeholder="아이디"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
        />
        <input
          placeholder="복구 코드 (XXXX-XXXX-XXXX-XXXX)"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <input
          type="password"
          placeholder="새 비밀번호 (8자 이상)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <input
          type="password"
          placeholder="새 비밀번호 확인"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <button type="submit" className="submit">
          재설정
        </button>
        {error && <div className="error">{error}</div>}
        <div className="meta">
          <Link to="/login">로그인으로 돌아가기</Link>
          <Link to="/register">회원가입</Link>
        </div>
      </form>
    </AuthShell>
  );
}
