/** Thin REST helpers for test setup — talk to the E2E server directly with Node fetch. */

export interface E2EUser {
  token: string;
  user: { id: number; username: string; name?: string | null; avatar?: string };
  username: string;
}

const base = () => process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4599';
const rnd = () => Math.random().toString(36).slice(2, 8);

export async function api<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; token?: string } = {},
): Promise<T> {
  const r = await fetch(`${base()}${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: {
      'content-type': 'application/json',
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${r.status} ${text}`);
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

/** Register a throw-away user. `prefix` must be [a-zA-Z0-9_]. */
export async function registerUser(prefix: string): Promise<E2EUser> {
  const username = `${prefix}_${rnd()}`.slice(0, 20);
  const r = await api<{ token: string; user: E2EUser['user'] }>('/api/auth/register', {
    body: { username, password: 'e2e-password-123' },
  });
  return { token: r.token, user: r.user, username };
}

export async function createMeeting(host: E2EUser, title: string) {
  return api<{ id: number; code: string; title: string }>('/api/meetings', {
    body: { title },
    token: host.token,
  });
}

export async function joinMeeting(u: E2EUser, code: string) {
  return api<{ id: number; code: string; title: string }>('/api/meetings/join', {
    body: { code },
    token: u.token,
  });
}

/** Host + guest already both participants of a fresh meeting. */
export async function twoPartyMeeting(tag: string) {
  const [a, b] = await Promise.all([registerUser(`${tag}a`), registerUser(`${tag}b`)]);
  const m = await createMeeting(a, `E2E ${tag} ${rnd()}`);
  await joinMeeting(b, m.code);
  return { a, b, code: m.code, meetingId: m.id, title: m.title };
}
