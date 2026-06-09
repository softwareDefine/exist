import { useEffect, useState } from 'react';

interface ErrToast {
  id: number;
  text: string;
}

let nextId = 1;

/** API 오류 전역 토스트 (우상단) — api.ts의 app:error 이벤트 수신 */
export default function ErrorToasts() {
  const [toasts, setToasts] = useState<ErrToast[]>([]);

  useEffect(() => {
    function onError(e: Event) {
      const text = (e as CustomEvent<string>).detail;
      const id = nextId++;
      setToasts((prev) => [...prev.slice(-2), { id, text }]); // 최대 3개
      setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 6000);
    }
    window.addEventListener('app:error', onError);
    return () => window.removeEventListener('app:error', onError);
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="error-toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className="error-toast">
          <span className="error-toast-ic" aria-hidden>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
              <path
                d="M12 7.5v5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
              <circle cx="12" cy="16.3" r="1.1" fill="currentColor" />
            </svg>
          </span>
          <span className="error-toast-text">{t.text}</span>
        </div>
      ))}
    </div>
  );
}
