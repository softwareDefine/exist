import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/** react-router 훅(useNavigate 등)을 쓰는 컴포넌트용 */
export function renderWithRouter(ui: ReactElement, initialEntries: string[] = ['/']) {
  return render(<MemoryRouter initialEntries={initialEntries}>{ui}</MemoryRouter>);
}

/** window CustomEvent 수집기 — app:error / app:info / exist:* 검증용 */
export function captureEvents(...names: string[]) {
  const got: { name: string; detail: unknown }[] = [];
  const handlers = names.map((name) => {
    const h = (e: Event) => got.push({ name, detail: (e as CustomEvent).detail });
    window.addEventListener(name, h);
    return [name, h] as const;
  });
  return {
    got,
    of: (name: string) => got.filter((g) => g.name === name).map((g) => g.detail),
    stop: () => handlers.forEach(([n, h]) => window.removeEventListener(n, h)),
  };
}
