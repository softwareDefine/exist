import { useAuthStore, type User } from '../store';

export const TEST_USER: User = { id: 1, username: 'juho', name: '이주호' };

/** 로그인 상태 세팅 — persist 미들웨어가 localStorage(exist-auth)에도 쓴다 */
export function login(user: Partial<User> = {}, token = 'test-token') {
  useAuthStore.setState({ token, user: { ...TEST_USER, ...user } });
}
export function logout() {
  useAuthStore.setState({ token: null, user: null });
}
