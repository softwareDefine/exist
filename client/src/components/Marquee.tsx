import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

/**
 * 넘치는 한 줄 텍스트를 좌↔우로 천천히 흘려주는 래퍼.
 * 컨테이너에 다 들어가면 애니메이션 없음 — 넘칠 때만 동작 (ResizeObserver로 감지).
 */
export default function Marquee({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const [dist, setDist] = useState(0);

  useEffect(() => {
    const measure = () => {
      const o = outer.current;
      const i = inner.current;
      if (!o || !i) return;
      const d = i.scrollWidth - o.clientWidth;
      setDist(d > 4 ? d : 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (outer.current) ro.observe(outer.current);
    if (inner.current) ro.observe(inner.current);
    return () => ro.disconnect();
  }, [children]);

  return (
    <div ref={outer} className={`marquee${className ? ` ${className}` : ''}`}>
      <span
        ref={inner}
        className={`marquee-inner${dist ? ' on' : ''}`}
        style={
          dist
            ? ({
                '--marquee-dist': `-${dist}px`,
                // 넘친 길이에 비례한 속도 (최소 4초) — 짧게 넘치면 천천히 왕복
                animationDuration: `${Math.max(4, dist / 25 + 2)}s`,
              } as CSSProperties)
            : undefined
        }
      >
        {children}
      </span>
    </div>
  );
}
