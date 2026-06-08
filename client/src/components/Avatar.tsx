/** 아바타 — 값이 이미지 URL이면 사진, 아니면 이모지. 크기·모양은 className으로 */
export default function Avatar({
  value,
  className = '',
}: {
  value?: string | null;
  className?: string;
}) {
  const v = value || '🙂';
  const isImg = v.startsWith('/api') || v.startsWith('http') || v.startsWith('/uploads');
  return (
    <span className={`avatar ${className}`}>
      {isImg ? <img className="avatar-photo" src={v} alt="" /> : v}
    </span>
  );
}
