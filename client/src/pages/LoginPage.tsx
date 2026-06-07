import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuthStore, type User } from '../store';
import AuthShell from '../components/AuthShell';

export default function LoginPage() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const data = await api<{ token: string; user: User }>('/api/auth/login', {
        method: 'POST',
        body: { username, password },
      });
      setAuth(data.token, data.user);
      navigate('/');
    } catch (e) {
      setError(e instanceof Error ? e.message : '오류가 발생했습니다');
    }
  }

  return (
    <AuthShell>
      <form onSubmit={submit} style={{ display: 'contents' }}>
        <input
          placeholder="아이디"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
        />
        <input
          type="password"
          placeholder="비밀번호"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit" className="submit">
          로그인
        </button>
        {error && <div className="error">{error}</div>}
        <div className="meta">
          <Link to="/forgot">아이디/비번을 잊어버리셨나요?</Link>
          <Link to="/register">회원가입</Link>
        </div>
      </form>
    </AuthShell>
  );
}
