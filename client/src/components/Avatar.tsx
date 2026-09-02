import { SparklesIcon } from './Icons';
import { useNameStore } from '../names';
import { avatarColor, avatarInitial, DEFAULT_AVATAR } from '../lib/avatar';

/**
 * 아바타 — 값이 이미지 URL이면 사진, '✦'(exist AI)면 별 아이콘.
 * name(username)이 있으면: 사진이 없을 때 "이니셜 + 인물 고정색"이 기본(기본 펭귄 대체),
 * 직접 고른 이모지는 유지하되 배경만 인물 고정색 — 같은 사람은 어디서나 같은 색 (design-0903 결함 #8).
 * 모양 규칙(정사각 + 살짝 radius, 원형 금지)은 각 위치의 CSS 클래스가 유지한다.
 */
export default function Avatar({
  value,
  name,
  className = '',
}: {
  value?: string | null;
  /** 인물 식별 키(username) — 고정색 해시 + 이니셜용 표시 이름 조회에 사용 */
  name?: string | null;
  className?: string;
}) {
  // 이니셜은 표시 이름(한글이면 첫 음절), 색 해시는 username(화면 간 고정)
  const display = useNameStore((s) => (name ? (s.map[name] ?? name) : ''));
  const v = value || '🙂';
  if (v === '✦')
    return (
      <span className={`avatar avatar-ai ${className}`}>
        <SparklesIcon size={16} />
      </span>
    );
  const isImg = v.startsWith('/api') || v.startsWith('http') || v.startsWith('/uploads');
  if (isImg)
    return (
      <span className={`avatar ${className}`}>
        <img className="avatar-photo" src={v} alt="" />
      </span>
    );
  if (name) {
    const c = avatarColor(name);
    if (!value || value === DEFAULT_AVATAR)
      return (
        <span
          className={`avatar avatar-initial ${className}`}
          style={{ background: c.bg, color: c.fg }}
        >
          {avatarInitial(display)}
        </span>
      );
    // 직접 고른 이모지 — 유지하되 배경은 인물 고정색 (클래스별 배경 재추첨 방지)
    return (
      <span className={`avatar ${className}`} style={{ background: c.bg }}>
        {v}
      </span>
    );
  }
  return <span className={`avatar ${className}`}>{v}</span>;
}
