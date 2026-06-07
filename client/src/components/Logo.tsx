import logoDark from '../assets/logo.svg';
import logoLight from '../assets/logo-light.svg';

/** exist 공식 로고 (Group 1.svg) — light=true면 다크 배경용 흰색 버전 */
export default function Logo({ light = false }: { light?: boolean }) {
  return <img className="logo-img" src={light ? logoLight : logoDark} alt="exist" />;
}
