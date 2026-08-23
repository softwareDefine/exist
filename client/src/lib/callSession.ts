/* ── 전역 통화 세션 — "한 번에 한 통화" 강제 ──
 * 그룹 탭마다 MeetingHub가 독립적으로 통화(inCall)를 가질 수 있어서, A 그룹 통화 중
 * B 그룹 통화에 들어가면 마이크·소켓 방 상태가 꼬인다 (서버는 소켓당 방 하나만 기억).
 * 여기 등록된 통화가 유일한 활성 통화 — 새 통화 입장 전 leaveOtherCall()이 기존 것을 정리한다. */
import { create } from 'zustand';

interface CallSession {
  code: string | null;
  leave: (() => void) | null;
}

export const useCallSession = create<CallSession>(() => ({ code: null, leave: null }));

/** 통화 시작 시 등록 — leave는 그 그룹 허브의 통화 종료 루틴 (뷰 언마운트 → room:leave·트랙 정지) */
export function registerCall(code: string, leave: () => void): void {
  useCallSession.setState({ code: code.toUpperCase(), leave });
}

/** 통화 종료 시 해제 — 내 통화일 때만 (다른 그룹이 이미 새로 등록했을 수 있음) */
export function clearCall(code: string): void {
  const s = useCallSession.getState();
  if (s.code === code.toUpperCase()) useCallSession.setState({ code: null, leave: null });
}

/** 다른 그룹 통화가 살아 있으면 종료 — 새 통화 입장 직전에 호출 */
export function leaveOtherCall(code: string): void {
  const s = useCallSession.getState();
  if (s.code && s.code !== code.toUpperCase()) {
    try {
      s.leave?.();
    } catch {
      /* 종료 루틴 실패해도 진행 — 서버 유령 정리가 받쳐준다 */
    }
    useCallSession.setState({ code: null, leave: null });
  }
}
