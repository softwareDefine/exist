/** 회의 썸네일 — 사진이 있으면 이미지, 없으면 id 기반 그라디언트 + 제목 첫 글자 */
export default function MeetingThumb({
  id,
  title,
  thumbnail,
  className = '',
}: {
  id: number;
  title: string;
  thumbnail?: string | null;
  className?: string;
}) {
  if (thumbnail) {
    return (
      <span className={`mthumb ${className}`}>
        <img className="mthumb-img" src={thumbnail} alt="" />
      </span>
    );
  }
  const hue = (id * 67) % 360;
  return (
    <span
      className={`mthumb ${className}`}
      style={{
        background: `linear-gradient(135deg, hsl(${hue} 60% 55%), hsl(${(hue + 40) % 360} 60% 45%))`,
      }}
    >
      {title.slice(0, 1)}
    </span>
  );
}
