import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { mockApi } from '../../test/mockApi';
import { login } from '../../test/auth';
import { renderWithRouter, captureEvents } from '../../test/render';
import { useNameStore } from '../../names';
import { useOrgStore, type Org } from '../../orgStore';

vi.mock('../../lib/socket', () => import('../../test/socket.mock'));
import { fakeSocket } from '../../test/socket.mock';
import ProfileDashboard from '../ProfileDashboard';

const NOW = Date.now();
const todayIso = (h: number) => {
  const d = new Date();
  d.setHours(h, 0, 0, 0);
  return d.toISOString();
};

function orgOf(id: number, extra: Partial<Org> = {}): Org {
  return { id, name: '런타임', joinCode: 'RT-1', role: 'member', isManager: false, canCreateGroup: false, memberCount: 5, pendingCount: 0, ...extra };
}

function routes(m: ReturnType<typeof mockApi>, org: string) {
  const q = (p: string) => new RegExp(`/api/${p}\\?org=${org}$`);
  m.get(q('agent/overview'), {
    avatar: '🐯',
    meetingCount: 3,
    todoUndone: 2,
    todoOverdue: 1,
    unreadTotal: 4,
    pendingAcks: 1,
    weekDecisions: 5,
    liveCalls: [{ title: '생산1팀', code: 'ABCD', inCall: 2 }],
    recentMeetings: [{ title: '생산1팀', code: 'ABCD', inCall: 2 }],
    nextMeeting: { title: '주간회의', code: 'ABCD', startsAt: todayIso(15) },
  });
  m.get(q('todos'), [
    { id: 1, title: '보고서 작성', done: 0, due_at: '2026-01-01', meeting_title: '생산1팀' },
    { id: 2, title: '끝난 일', done: 1, due_at: null },
  ]);
  m.get(q('meetings/schedule'), [
    { id: 1, code: 'ABCD', title: '주간회의', starts_at: todayIso(15), ends_at: todayIso(16) },
  ]);
  m.get(q('agent/daily'), { text: '오늘은 결정 1건 확인이 남았어요' });
  m.get(q('agent/catchup'), { headline: '못 본 사이', items: [{ type: 'recap', text: '냉각수 결정', meeting: { code: 'ABCD', title: '생산1팀' } }] });
  m.get(q('agent/pending-decisions'), { items: [{ recapId: 10, idx: 0, decision: '냉각수 63도', code: 'ABCD', title: '생산1팀', ts: NOW }] });
  m.get(q('agent/actions'), {
    decisions: [{ recapId: 10, idx: 0, decision: '냉각수 63도', code: 'ABCD', title: '생산1팀', ts: NOW }],
    todos: [{ id: 3, title: '필터 교체', due_at: '2026-01-02', code: 'ABCD', mtitle: '생산1팀' }],
    dms: [{ userId: 7, username: 'kim', name: '김대리', avatar: null, unread: 2, lastText: '확인 부탁', ts: NOW }],
    pendingAcks: [{ fileId: 3, name: '작업지침', code: 'ABCD', title: '생산1팀' }],
    pendingAcksTotal: 1,
  });
  m.get(q('agent/sent'), {
    entries: [{ recapId: 11, idx: 0, decision: '내가 보낸 결정', code: 'ABCD', title: '생산1팀', ts: NOW, acked: 1, total: 3, missing: ['kim', 'lee'], critical: false }],
    totalSent: 1,
  });
  m.get(new RegExp(`/api/meetings/inbox\\?org=${org}$`), []);
  m.get(`/api/dm/${org}/threads`, []);
  m.get(/\/api\/dm\/\w+\/with\/\d+$/, []);
}

describe('ProfileDashboard', () => {
  let m: ReturnType<typeof mockApi>;
  beforeEach(() => {
    m = mockApi();
    fakeSocket.reset();
    login({ id: 1, username: 'juho', name: '이주호' });
    useNameStore.setState({ map: { kim: '김대리' } });
    useOrgStore.setState({ orgs: [orgOf(5)], current: 'personal', loaded: true });
  });

  it('개인 홈 — 히어로 카운트·오늘 브리핑·전체 할 일·인박스(결정/서명/할일/DM)·발신 현황', async () => {
    routes(m, 'personal');
    const ev = captureEvents('exist:open-meeting', 'exist:deeplink');
    renderWithRouter(<ProfileDashboard />);
    expect(await screen.findByText('오늘은 결정 1건 확인이 남았어요')).toBeInTheDocument();
    expect(screen.getByText('보고서 작성')).toBeInTheDocument();
    expect(screen.getByText(/1\/1 지남/)).toBeInTheDocument();
    expect(screen.getByText('냉각수 63도')).toBeInTheDocument();
    expect(screen.getByText(/『작업지침』 열람 서명/)).toBeInTheDocument();
    expect(screen.getByText('필터 교체')).toBeInTheDocument();
    expect(screen.getByText('안 읽은 메시지 2건')).toBeInTheDocument();
    expect(screen.getByText('내가 보낸 결정')).toBeInTheDocument();
    // NOTE: 미확인자 명단은 dn()을 안 거쳐 아이디 그대로 노출 (다른 카드는 표시 이름) — 리포트 대상
    expect(document.querySelector('.pd-sent-missing')?.textContent).toContain('미확인: 김대리, lee');

    // 결정 확인 → POST ack + 행 제거
    m.post('/api/meetings/ABCD/decisions/ack', { ok: true });
    fireEvent.click(screen.getByTitle('수신확인 — 회람 사인'));
    await waitFor(() => expect(m.calls('POST', '/api/meetings/ABCD/decisions/ack')).toHaveLength(1));
    expect(m.last('POST').body).toEqual({ recapId: 10, idx: 0 });
    // 서명 대기 문서 → 딥링크
    fireEvent.click(screen.getByTitle('문서를 열어 열람 서명'));
    expect(ev.of('exist:deeplink')).toEqual([{ code: 'ABCD', fileId: 3 }]);
    // 그룹 열기 (결정 행 본문 클릭)
    fireEvent.click(screen.getByText('내가 보낸 결정').closest('.pd-act-main')!);
    expect(ev.of('exist:open-meeting')).toEqual([{ code: 'ABCD', title: '생산1팀' }]);
    ev.stop();
  });

  it('개인 홈 — 전체 할 일 토글/삭제, 인박스 DM은 개인 스코프 창', async () => {
    routes(m, 'personal');
    m.patch('/api/todos/1', { ok: true });
    m.delete('/api/todos/2', {});
    renderWithRouter(<ProfileDashboard />);
    await screen.findByText('보고서 작성');
    const cb = screen.getAllByRole('checkbox')[0];
    fireEvent.click(cb);
    await waitFor(() => expect(m.calls('PATCH', '/api/todos/1')).toHaveLength(1));
    expect(m.last('PATCH').body).toEqual({ done: true });
    fireEvent.click(screen.getAllByTitle('삭제')[1]);
    await waitFor(() => expect(m.calls('DELETE', '/api/todos/2')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText('끝난 일')).not.toBeInTheDocument());
    // DM 답장 → DmWindow(personal)
    fireEvent.click(screen.getByText('안 읽은 메시지 2건').closest('.pd-act-main')!);
    expect(await screen.findByText('김대리', { selector: '.dm-head-name' })).toBeInTheDocument();
    await waitFor(() => expect(m.calls('GET', '/api/dm/personal/with/7')).toHaveLength(1));
    fireEvent.click(screen.getByTitle('닫기'));
    await waitFor(() => expect(m.calls('GET', /agent\/actions/).length).toBeGreaterThanOrEqual(2));
  });

  it('할 일 토글 실패 시 원복', async () => {
    routes(m, 'personal');
    m.fail('PATCH', '/api/todos/1', 500);
    renderWithRouter(<ProfileDashboard />);
    await screen.findByText('보고서 작성');
    const cb = screen.getAllByRole('checkbox')[0] as HTMLInputElement;
    fireEvent.click(cb);
    expect(cb.checked).toBe(true);
    await waitFor(() => expect(cb.checked).toBe(false));
  });

  it('소켓 — ledger:changed로 인박스 재조회, call:presence로 라이브 통화 갱신, exist:todos-changed로 할 일 재조회', async () => {
    routes(m, 'personal');
    renderWithRouter(<ProfileDashboard />);
    await screen.findByText('보고서 작성');
    const actionsBefore = m.calls('GET', /agent\/actions/).length;
    act(() => fakeSocket.trigger('ledger:changed', { code: 'ABCD' }));
    await waitFor(() => expect(m.calls('GET', /agent\/actions/).length).toBe(actionsBefore + 1));
    act(() => fakeSocket.trigger('files:changed', { code: 'ABCD' }));
    await waitFor(() => expect(m.calls('GET', /agent\/actions/).length).toBe(actionsBefore + 2));
    const todosBefore = m.calls('GET', /\/api\/todos\?org=personal/).length;
    act(() => window.dispatchEvent(new CustomEvent('exist:todos-changed')));
    await waitFor(() => expect(m.calls('GET', /\/api\/todos\?org=personal/).length).toBe(todosBefore + 1));
    act(() => fakeSocket.trigger('call:presence', { code: 'ABCD', title: '생산1팀', peers: ['a', 'b', 'c'] }));
    await waitFor(() => expect(screen.getByText(/3명/)).toBeInTheDocument());
  });

  it('조직 홈(멤버) — 내 포커스 + 통합 메시지, DM은 조직 스코프', async () => {
    useOrgStore.setState({ orgs: [orgOf(5)], current: 5 });
    routes(m, '5');
    m.get('/api/orgs/5/my-focus', {
      todos: [{ id: 1, title: '조직 할 일', dueAt: null, meetingCode: 'ABCD', meetingTitle: '생산1팀' }],
      events: [{ id: 1, title: '점검', date: '2026-09-01', time: '10:00', meetingCode: 'ABCD', meetingTitle: '생산1팀' }],
      unread: [{ meetingCode: 'ABCD', meetingTitle: '생산1팀', count: 3 }],
    });
    renderWithRouter(<ProfileDashboard />);
    const toggle = await screen.findByText(/내 포커스/, { selector: 'button' });
    fireEvent.click(toggle);
    expect(await screen.findByText('조직 할 일')).toBeInTheDocument();
    expect(m.calls('GET', /team-acks/)).toHaveLength(0); // 일반 멤버는 조회 안 함
    fireEvent.click(screen.getByText('안 읽은 메시지 2건').closest('.pd-act-main')!);
    await waitFor(() => expect(m.calls('GET', '/api/dm/5/with/7')).toHaveLength(1));
  });

  it('조직 홈(관리자) — 팀 인사이트 + 우리 조 확인 현황 카드', async () => {
    useOrgStore.setState({ orgs: [orgOf(5, { isManager: true, role: 'owner', myTier: 'hq' })], current: 5 });
    routes(m, '5');
    m.get('/api/orgs/5/team-acks', {
      department: '생산1팀',
      items: [{ recapId: 10, idx: 0, text: '냉각수 63도', meetingCode: 'ABCD', meetingTitle: '생산1팀', total: 4, acked: 1, missing: ['kim', 'lee', 'park', 'choi'] }],
    });
    m.get('/api/insights/5', {
      metrics: {
        orgName: '런타임', periodDays: 30, memberCount: 5, meetingCount: 3,
        todos: { total: 10, done: 6, overdue: 1, completionRate: 60 },
        calls: { count: 4, totalMinutes: 120 }, activity: { calls: 4, messages: 80 },
        participation: [{ username: 'kim', messages: 40 }], quietMembers: ['lee'],
        esg: { replacedCommutes: 8, savedKm: 120, savedCo2Kg: 20, savedHours: 6 },
      },
      insights: { summary: '협업이 활발해요', trend: '상승', burnoutRisk: { level: 'low', reason: '' }, delayRisk: { level: 'mid', reason: '지연 1건' }, risks: ['지연'], recommendations: ['리마인드'] },
      source: 'ai',
    });
    m.post('/api/orgs/5/team-acks/remind', { reminded: 3 });
    renderWithRouter(<ProfileDashboard />);
    expect(await screen.findByText('우리 조 확인 현황')).toBeInTheDocument();
    expect(document.querySelector('.pd-teamacks .pd-sent-missing')?.textContent).toContain('미확인: 김대리, lee, park 외 1명');
    fireEvent.click(screen.getByText(/팀 인사이트/, { selector: 'button' }));
    expect(await screen.findByText('협업이 활발해요')).toBeInTheDocument();
  });
});
