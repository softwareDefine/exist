import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuthStore, type User } from '../store';
import AuthShell from '../components/AuthShell';
import RecoveryCode from '../components/RecoveryCode';

export default function RegisterPage() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [pendingAuth, setPendingAuth] = useState<{ token: string; user: User } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return setError('아이디는 영문·숫자·_ 조합 3~20자입니다');
    }
    if (password.length < 8) {
      return setError('비밀번호는 8자 이상이어야 합니다');
    }
    if (password !== confirm) {
      return setError('비밀번호가 서로 다릅니다');
    }
    try {
      const data = await api<{ token: string; user: User; recoveryCode: string }>(
        '/api/auth/register',
        { method: 'POST', body: { username, password } },
      );
      // 복구 코드 화면을 보여준 뒤에 로그인 처리 (시작하기 클릭 시)
      setRecoveryCode(data.recoveryCode);
      setPendingAuth({ token: data.token, user: data.user });
    } catch (e) {
      setError(e instanceof Error ? e.message : '가입에 실패했습니다');
    }
  }

  function start() {
    if (pendingAuth) setAuth(pendingAuth.token, pendingAuth.user);
    navigate('/');
  }

  if (recoveryCode) {
    return (
      <AuthShell>
        <RecoveryCode code={recoveryCode} />
        <button type="button" className="submit" onClick={start}>
          시작하기
        </button>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <form
        onSubmit={submit}
        style={{ display: 'contents' }}
      >
        <div className="auth-heading">회원가입</div>
        <input
          placeholder="아이디 (영문·숫자·_ 3~20자)"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
        />
        <input
          type="password"
          placeholder="비밀번호 (8자 이상)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <input
          type="password"
          placeholder="비밀번호 확인"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <button type="submit" className="submit">
          가입하기
        </button>
        {error && <div className="error">{error}</div>}
        <div className="meta">
          <span>이미 계정이 있나요?</span>
          <Link to="/login">로그인</Link>
        </div>
      </form>
    </AuthShell>
  );
}
