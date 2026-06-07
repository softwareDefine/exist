import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuthStore, type User } from '../store';

export default function LoginPage() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function submit(mode: 'login' | 'register') {
    setError('');
    try {
      const data = await api<{ token: string; user: User }>(`/api/auth/${mode}`, {
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
    <div className="login-page">
      <div className="login-hero">
        <div className="hero-scene">
          <div className="hero-call">
            <div className="hero-lock">🔒</div>
            <div className="hero-tile" style={{ background: '#ffe7d6' }}>
              🧑‍🦰
            </div>
            <div className="hero-tile" style={{ background: '#d6e8ff' }}>
              👨‍💻
            </div>
            <div className="hero-tile" style={{ background: '#e3f6d9' }}>
              👩🏽‍💼
            </div>
            <div className="hero-tile" style={{ background: '#f3e2ff' }}>
              🧑🏿‍💻
            </div>
          </div>
          <div className="hero-caption">
            완전한 대면근무의 대체.
            <br />
            팀의 존재감이 살아있는 재택근무 플랫폼
          </div>
        </div>
      </div>
      <div className="login-form-wrap">
        <form
          className="login-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit('login');
          }}
        >
          <span className="logo">exist</span>
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
            <span>아이디/비번을 잊어버리셨나요?</span>
            <button type="button" onClick={() => void submit('register')}>
              회원가입
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
