import { SparklesIcon } from './Icons';

/** 아바타 — 값이 이미지 URL이면 사진, '✦'(exist AI)면 별 아이콘, 아니면 이모지 */
export default function Avatar({
  value,
  className = '',
}: {
  value?: string | null;
  className?: string;
}) {
  const v = value || '🙂';
  if (v === '✦')
    return (
      <span className={`avatar avatar-ai ${className}`}>
        <SparklesIcon size={16} />
      </span>
    );
  const isImg = v.startsWith('/api') || v.startsWith('http') || v.startsWith('/uploads');
  return (
    <span className={`avatar ${className}`}>
      {isImg ? <img className="avatar-photo" src={v} alt="" /> : v}
    </span>
  );
}
