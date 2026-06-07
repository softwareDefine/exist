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
          ⚠️ {t.text}
        </div>
      ))}
    </div>
  );
}
