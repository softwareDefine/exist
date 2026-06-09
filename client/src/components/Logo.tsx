import logoDark from '../assets/logo.svg';
import logoLight from '../assets/logo-light.svg';

/**
 * exist 공식 로고. 두 버전을 모두 렌더하고 CSS(.dark)로 토글 →
 * 테마 전환 시 JS 리렌더 없이 자동으로 흰색/검정 버전 전환.
 * (light prop은 항상 라이트(흰색) 버전을 강제하고 싶을 때만)
 */
export default function Logo({ light }: { light?: boolean }) {
  if (light) return <img className="logo-img" src={logoLight} alt="exist" />;
  return (
    <>
      <img className="logo-img logo-asset-dark" src={logoDark} alt="exist" />
      <img className="logo-img logo-asset-light" src={logoLight} alt="exist" />
    </>
  );
}
