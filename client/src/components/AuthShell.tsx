import Logo from './Logo';
import heroImg from '../assets/login-hero.png';

/** 로그인/회원가입/비밀번호 찾기 공용 레이아웃 (좌측 일러스트 + 우측 폼) */
export default function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="login-page">
      <div className="login-hero">
        <img className="hero-img" src={heroImg} alt="화상회의 일러스트" />
      </div>
      <div className="login-form-wrap">
        <div className="login-form">
          <Logo />
          {children}
        </div>
      </div>
    </div>
  );
}
