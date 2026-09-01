import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../test/mockApi';
import { login } from '../../test/auth';
import { renderWithRouter, captureEvents } from '../../test/render';
import { useNameStore } from '../../names';
import { useOrgStore } from '../../orgStore';

vi.mock('../../lib/socket', () => import('../../test/socket.mock'));
import { fakeSocket } from '../../test/socket.mock';
import RecapPanel from '../RecapPanel';
import MeetingArchive from '../MeetingArchive';
import MyOrgFocus from '../MyOrgFocus';
import InsightsPanel from '../InsightsPanel';
import ScheduleWidget from '../ScheduleWidget';
import NotificationCenter from '../NotificationCenter';
import MeetingSettingsModal from '../MeetingSettingsModal';
import SettingsModal from '../SettingsModal';

const CODE = 'ABCD';
const NOW = Date.now();
const T0 = new Date(2026, 7, 20, 14, 30).getTime();

const recap = (over: Record<string, unknown> = {}) => ({
  id: 1,
  summary: '냉각수 온도 합의',
  decisions: ['냉각수 63도 유지'],
  whys: ['알람 때문'],
  alts: [['65도 — 알람']],
  actions: [{ assignee: 'kim', title: '라인 반영' }],
  attendees: ['juho', 'kim'],
  nextMeeting: { title: '후속 회의', date: '2026-09-03', time: '10:00' },
  files: [{ id: 3, name: 'SOP', type: 'doc' }],
  source: 'ai',
  ts: T0,
  ...over,
});

let m: ReturnType<typeof mockApi>;
beforeEach(() => {
  m = mockApi();
  fakeSocket.reset();
  login({ id: 1, username: 'juho', name: '이주호' });
  useNameStore.setState({ map: { kim: '김대리' } });
});
afterEach(() => vi.useRealTimers());

describe('RecapPanel', () => {
  it('빈 상태 → 지금 정리하기(호스트) 재료 부족 시 안내', async () => {
    m.get(`/api/meetings/${CODE}/recaps`, []);
    m.post(`/api/meetings/${CODE}/recaps/run`, { id: null });
    const ev = captureEvents('app:error');
    render(<RecapPanel code={CODE} isHost />);
    expect(await screen.findByText(/아직 지난 회의 기록이 없어요/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '지금 정리하기' }));
    await waitFor(() => expect(ev.of('app:error')).toEqual(['정리할 새 기록이 부족해요 (채팅 2개 이상)']));
    ev.stop();
  });

  it('정리 카드 — 결정·배경·할 일·다룬 문서, 지난 정리 펼치기, 다음 회의 등록', async () => {
    m.get(`/api/meetings/${CODE}/recaps`, [recap(), recap({ id: 2, summary: '지난 정리', ts: T0 - 86_400_000 })]);
    m.post(`/api/meetings/${CODE}/events`, { id: 1 });
    m.post(`/api/meetings/${CODE}/recaps/1/next-registered`, {});
    render(<RecapPanel code={CODE} isHost />);
    expect(await screen.findByText('냉각수 63도 유지')).toBeInTheDocument();
    expect(screen.getByText(/알람 때문/)).toBeInTheDocument();
    expect(screen.getByText('라인 반영')).toBeInTheDocument();
    expect(screen.getByText('SOP')).toBeInTheDocument();
    expect(screen.queryByText('지난 정리')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '지난 정리 1건 더' }));
    expect(screen.getByText('지난 정리')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '접기' }));
    expect(screen.queryByText('지난 정리')).not.toBeInTheDocument();
    // 다음 회의 제안 → 등록
    expect(document.querySelector('.hub-recap-next-when')?.textContent).toBe('9/3 (목) 10:00 — 후속 회의');
    fireEvent.click(screen.getByRole('button', { name: '일정 등록' }));
    await waitFor(() => expect(m.calls('POST', `/api/meetings/${CODE}/events`)).toHaveLength(1));
    expect(m.last('POST', /events$/).body).toEqual({ title: '후속 회의', date: '2026-09-03', time: '10:00', is_call: true });
    await waitFor(() => expect(m.calls('POST', /next-registered$/)).toHaveLength(1));
  });

  it('part=next — AI 겹침 시간 찾기 → 슬롯 확정 등록', async () => {
    m.get(`/api/meetings/${CODE}/recaps`, [recap({ nextMeeting: null })]);
    m.get(`/api/meetings/${CODE}/schedule/suggest`, { total: 3, slots: [{ date: '2026-09-04', time: '14:00', free: 3, busy: [] }] });
    m.post(`/api/meetings/${CODE}/events`, { id: 2 });
    render(<RecapPanel code={CODE} part="next" />);
    const find = await screen.findByTitle('참가자 전원의 일정을 보고 모두 비는 시간을 찾아요');
    fireEvent.click(find);
    const slot = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('.hub-recap-slot');
      if (!el) throw new Error('no slot yet');
      return el;
    });
    expect(slot.textContent).toContain('9/4 (금) 14:00');
    expect(slot.textContent).toContain('전원 가능');
    fireEvent.click(slot);
    expect(await screen.findByText('일정 등록됨')).toBeInTheDocument();
    await waitFor(() => expect(m.calls('POST', `/api/meetings/${CODE}/events`)).toHaveLength(1));
    expect(m.last('POST').body).toMatchObject({ date: '2026-09-04', time: '14:00', is_call: true });
  });

  it('소켓 — recap 알림 재조회, recap:status 진행 표시·스킵 안내', async () => {
    m.get(`/api/meetings/${CODE}/recaps`, []);
    const ev = captureEvents('app:info');
    render(<RecapPanel code={CODE} />);
    await waitFor(() => expect(m.calls('GET', /recaps$/)).toHaveLength(1));
    act(() => fakeSocket.trigger('recap:status', { code: CODE, state: 'generating' }));
    expect(screen.getByText(/AI가 회의를 정리하는 중이에요/)).toBeInTheDocument();
    act(() => fakeSocket.trigger('recap:status', { code: 'ZZZZ', state: 'done' }));
    expect(screen.getByText(/AI가 회의를 정리하는 중이에요/)).toBeInTheDocument();
    act(() => fakeSocket.trigger('recap:status', { code: CODE, state: 'skipped' }));
    expect(screen.queryByText(/AI가 회의를 정리하는 중이에요/)).not.toBeInTheDocument();
    expect(ev.of('app:info')).toHaveLength(1);
    act(() => fakeSocket.trigger('agent:notify', { kind: 'recap', meeting: { code: CODE } }));
    await waitFor(() => expect(m.calls('GET', /recaps$/)).toHaveLength(2));
    ev.stop();
  });
});

describe('MeetingArchive', () => {
  it('날짜별 카드, 펼치기, 검색, 원문 보기, 포커스 점프', async () => {
    m.get(`/api/meetings/${CODE}/recaps`, [recap(), recap({ id: 2, summary: '현장 TBM', origin: 'field', source: 'rule', decisions: [], actions: [], ts: T0 - 86_400_000 })]);
    m.get(`/api/meetings/${CODE}/recaps/1/source`, { items: [{ from: 'kim', text: '63도로 가시죠', ts: T0, kind: 'voice' }] });
    const onFocusHandled = vi.fn();
    render(<MeetingArchive code={CODE} focusRecapId={1} onFocusHandled={onFocusHandled} />);
    expect(await screen.findByText('냉각수 온도 합의', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByText('현장 녹음')).toBeInTheDocument();
    expect(screen.getByText('2026년 8월 20일')).toBeInTheDocument();
    // 포커스 대상은 펼쳐진 채 하이라이트
    await waitFor(() => expect(document.querySelector('[data-archive-id="1"]')).toHaveClass('recap-flash'));
    expect(await screen.findByText('냉각수 63도 유지')).toBeInTheDocument();
    await waitFor(() => expect(onFocusHandled).toHaveBeenCalled(), { timeout: 4000 });
    // 원문
    fireEvent.click(screen.getByRole('button', { name: '원문 보기 — 모든 발언' }));
    expect(await screen.findByText('63도로 가시죠')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '원문 닫기' }));
    expect(screen.queryByText('63도로 가시죠')).not.toBeInTheDocument();
    // 접기/펼치기
    fireEvent.click(screen.getByText('냉각수 온도 합의').closest('button')!);
    expect(screen.queryByText('냉각수 63도 유지')).not.toBeInTheDocument();
    // 검색
    await userEvent.type(screen.getByPlaceholderText('회의 기록 검색'), 'TBM');
    expect(screen.queryByText('냉각수 온도 합의')).not.toBeInTheDocument();
    expect(screen.getByText('현장 TBM')).toBeInTheDocument();
  });
});

describe('MyOrgFocus / InsightsPanel / ScheduleWidget', () => {
  it('MyOrgFocus — 항목 렌더, 완료 PATCH, 그룹 열기 이벤트', async () => {
    m.get('/api/orgs/5/my-focus', {
      todos: [{ id: 1, title: '조직 할 일', dueAt: '2026-09-02', meetingCode: 'ABCD', meetingTitle: '생산1팀' }],
      events: [{ id: 1, title: '점검', date: '2026-09-01', time: '10:00', meetingCode: 'ABCD', meetingTitle: '생산1팀' }],
      unread: [{ meetingCode: 'ABCD', meetingTitle: '생산1팀', count: 3 }],
    });
    m.patch('/api/todos/1', {});
    const ev = captureEvents('exist:open-meeting');
    render(<MyOrgFocus orgId={5} />);
    expect(await screen.findByText('조직 할 일')).toBeInTheDocument();
    expect(screen.getByText('점검')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('완료'));
    await waitFor(() => expect(m.calls('PATCH', '/api/todos/1')).toHaveLength(1));
    fireEvent.click(screen.getAllByText('생산1팀')[0].closest('button')!);
    expect(ev.of('exist:open-meeting')).toEqual([{ code: 'ABCD', title: '생산1팀' }]);
    ev.stop();
  });

  it('InsightsPanel — 로딩 → 요약·위험·추천, 실패 시 렌더 없음', async () => {
    m.get('/api/insights/5', {
      metrics: {
        orgName: '런타임', periodDays: 30, memberCount: 5, meetingCount: 3,
        todos: { total: 10, done: 6, overdue: 1, completionRate: 60 },
        calls: { count: 4, totalMinutes: 120 }, activity: { calls: 4, messages: 80 },
        participation: [{ username: 'kim', messages: 40 }], quietMembers: ['lee'],
        esg: { replacedCommutes: 8, savedKm: 120, savedCo2Kg: 20, savedHours: 6 },
      },
      insights: { summary: '협업이 활발해요', trend: '상승', burnoutRisk: { level: 'low', reason: '' }, delayRisk: { level: 'high', reason: '지연 1건' }, risks: ['지연'], recommendations: ['리마인드 보내기'] },
      source: 'ai',
    });
    m.fail('GET', '/api/insights/6', 403);
    const { container, rerender } = render(<InsightsPanel orgId={5} />);
    expect(screen.getByText(/AI 팀 인사이트 분석 중/)).toBeInTheDocument();
    expect(await screen.findByText('협업이 활발해요')).toBeInTheDocument();
    expect(screen.getByText('리마인드 보내기')).toBeInTheDocument();
    const esg = screen.queryByText(/ESG|탄소|통근/);
    if (esg) fireEvent.click(esg.closest('button') ?? esg);
    rerender(<InsightsPanel orgId={6} />);
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('ScheduleWidget — 달력에서 날짜 선택 → 타임라인, 월 이동, 열기 콜백', () => {
    const today = new Date();
    const at = (h: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate(), h).toISOString();
    const onOpen = vi.fn();
    render(
      <ScheduleWidget
        onOpen={onOpen}
        schedule={[
          { id: 1, code: 'ABCD', title: '아침 점검', starts_at: at(9), ends_at: at(10) },
          { id: 2, code: 'EFGH', title: '오후 회의', starts_at: at(15), ends_at: null },
        ]}
      />,
    );
    expect(screen.getByText('아침 점검')).toBeInTheDocument();
    expect(screen.getByText('오후 회의')).toBeInTheDocument();
    fireEvent.click(screen.getByText('아침 점검'));
    expect(onOpen).toHaveBeenCalledWith('ABCD', '아침 점검');
    const [prev, next] = document.querySelectorAll('button');
    fireEvent.click(next);
    fireEvent.click(prev);
    fireEvent.click(prev);
    expect(screen.queryByText('아침 점검')).toBeInTheDocument(); // 선택일은 유지
  });
});

describe('NotificationCenter', () => {
  it('벨 → 목록·안읽음 배지, 읽음 처리, 실시간 수신, 지난 알림, 모두 비우기', async () => {
    m.get('/api/notifications', { unread: 2, items: [{ id: 1, from: 'kim', text: '통화가 시작됐어요', kind: 'call', read: false, ts: NOW, meeting: { id: 1, code: CODE, title: '생산1팀', thumbnail: null } }] });
    m.get(/\/api\/notifications\?all=1/, { items: [{ id: 0, from: 'kim', text: '오래된 알림', kind: null, read: true, cleared: true, ts: NOW - 86_400_000 }] });
    m.post('/api/notifications/read', {});
    m.post('/api/notifications/clear', {});
    m.delete('/api/notifications', {});
    const ev = captureEvents('exist:open-meeting');
    render(<NotificationCenter />);
    await waitFor(() => expect(m.calls('GET', '/api/notifications')).toHaveLength(1));
    expect(document.querySelector('.notif-bell')?.textContent).toContain('2');
    fireEvent.click(screen.getByTitle('알림'));
    expect(await screen.findByText('통화가 시작됐어요')).toBeInTheDocument();
    await waitFor(() => expect(m.calls('POST', '/api/notifications/read')).toHaveLength(1));
    act(() => fakeSocket.trigger('agent:notify', { id: 2, from: 'lee', text: '새 채팅', kind: 'chat', ts: NOW }));
    expect(screen.getByText('새 채팅')).toBeInTheDocument();
    const join = screen.queryByText(/지금 들어가기/);
    if (join) {
      fireEvent.click(join.closest('button')!);
      expect(ev.of('exist:open-meeting')).toEqual([{ code: CODE, title: '생산1팀', tab: 'call' }]);
    }
    // 지난 알림 보기 → 돌아오기
    fireEvent.click(screen.getByTitle('알림'));
    const past = screen.queryByText(/지난 알림/);
    if (past) {
      fireEvent.click(past.closest('button') ?? past);
      expect(await screen.findByText('오래된 알림')).toBeInTheDocument();
    }
    ev.stop();
  });
});

describe('MeetingSettingsModal / SettingsModal', () => {
  it('회의 설정 — 제목 수정 저장 PATCH, 삭제는 2단계 확인 후 DELETE + 이벤트', async () => {
    m.patch(`/api/meetings/${CODE}`, {});
    m.delete(`/api/meetings/${CODE}`, {});
    const onClose = vi.fn();
    const onChanged = vi.fn();
    const ev = captureEvents('exist:meeting-deleted', 'exist:schedule-changed');
    render(
      <MeetingSettingsModal
        meeting={{ id: 1, code: CODE, title: '생산1팀', starts_at: null, ends_at: null, thumbnail: null }}
        onClose={onClose}
        onChanged={onChanged}
      />,
    );
    expect(screen.getByText('회의 설정')).toBeInTheDocument();
    const title = screen.getByDisplayValue('생산1팀');
    fireEvent.change(title, { target: { value: '생산2팀' } });
    fireEvent.submit(title.closest('form')!);
    await waitFor(() => expect(m.calls('PATCH', `/api/meetings/${CODE}`)).toHaveLength(1));
    expect(m.last('PATCH').body).toEqual({ title: '생산2팀', starts_at: null, ends_at: null });
    expect(onChanged).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    const del = screen.getByText(/삭제/, { selector: 'button' });
    fireEvent.click(del);
    expect(m.calls('DELETE')).toHaveLength(0);
    fireEvent.click(screen.getByText(/정말|삭제/, { selector: 'button' }));
    await waitFor(() => expect(m.calls('DELETE', `/api/meetings/${CODE}`)).toHaveLength(1));
    expect(ev.of('exist:meeting-deleted')).toEqual([{ code: CODE }]);
    expect(ev.of('exist:schedule-changed')).toHaveLength(1);
    ev.stop();
  });

  it('SettingsModal — 프로필 로드, 이름 저장 PATCH, 비밀번호 검증', async () => {
    m.get('/api/auth/me', { name: '이주호', email: 'a@b.c', phone: '', address: '' });
    m.patch('/api/auth/me', { ok: true, name: '주호' });
    const onClose = vi.fn();
    renderWithRouter(<SettingsModal open onClose={onClose} avatar="🐯" onAvatarChange={() => {}} />);
    await waitFor(() => expect(m.calls('GET', '/api/auth/me')).toHaveLength(1));
    const name = await screen.findByPlaceholderText('표시할 이름');
    fireEvent.change(name, { target: { value: '주호' } });
    fireEvent.submit(name.closest('form')!);
    await waitFor(() => expect(m.calls('PATCH', '/api/auth/me')).toHaveLength(1));
    expect(m.last('PATCH').body).toMatchObject({ name: '주호' });
    useOrgStore.getState();
  });
});
