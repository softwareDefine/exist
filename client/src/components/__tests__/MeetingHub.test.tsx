import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../test/mockApi';
import { login } from '../../test/auth';
import { renderWithRouter, captureEvents } from '../../test/render';
import { useNameStore } from '../../names';

vi.mock('../../lib/socket', () => import('../../test/socket.mock'));
// 무거운 자식(WebRTC·Yjs 에디터·일정)은 스텁 — 허브의 채팅/이벤트 배선만 검증
vi.mock('../MeetingView', () => ({ default: () => <div data-testid="meeting-view" /> }));
vi.mock('../CollabFiles', () => ({ default: () => <div data-testid="collab-files" /> }));
vi.mock('../MeetingSchedule', () => ({ default: () => <div data-testid="schedule" /> }));
vi.mock('../RecapPanel', () => ({ default: () => <div data-testid="recap" /> }));
vi.mock('../DecisionLedger', () => ({ default: () => <div data-testid="ledger" /> }));

import { fakeSocket } from '../../test/socket.mock';
import MeetingHub from '../MeetingHub';

const CODE = 'ABCD';
const NOW = Date.now();

const detail = {
  id: 1,
  code: CODE,
  title: '생산1팀',
  starts_at: null,
  ends_at: null,
  host: 'juho',
  isHost: true,
  canManage: true,
  orgId: 5,
  orgName: '런타임',
  thumbnail: null,
  online: 0,
  participants: [
    { userId: 1, username: 'juho', avatar: null, role: 'owner', position: null, department: null, isHost: true },
    { userId: 2, username: 'kim', avatar: null, role: 'member', position: '대리', department: '생산' },
    { userId: 3, username: 'guest', avatar: null, role: null, position: null, department: null },
  ],
  callPeers: [],
};

function setupRoutes(m: ReturnType<typeof mockApi>, messages: unknown[] = []) {
  m.get(`/api/meetings/${CODE}`, detail);
  m.get(`/api/meetings/${CODE}/channels`, [
    { id: 1, name: '일반', isDefault: true },
    { id: 2, name: '설비', isDefault: false, createdBy: 2 },
  ]);
  m.get(/\/api\/meetings\/ABCD\/messages\?channel=1$/, messages);
  m.get(/\/api\/meetings\/ABCD\/messages\?channel=2$/, []);
  m.post(`/api/meetings/${CODE}/messages/read`, {});
  m.get(/\/api\/todos\?meeting=ABCD$/, []);
  m.get(`/api/meetings/${CODE}/decisions`, []);
  m.get(`/api/meetings/${CODE}/agenda`, { items: [] });
  m.get(`/api/meetings/${CODE}/glossary`, { terms: [] });
  m.get('/api/presence', { users: ['kim'] });
  m.get(/\/api\/dm\/\w+\/with\/\d+$/, []);
}

async function openChat() {
  await screen.findAllByText('생산1팀');
  // 상단 서브탭(.hub-tab) — 모바일 메뉴(.hub-m-item)에도 같은 라벨이 있어 셀렉터로 구분
  const tab = [...document.querySelectorAll<HTMLButtonElement>('.hub-tab')].find((b) => b.textContent?.includes('채팅'))!;
  fireEvent.click(tab);
  await screen.findByPlaceholderText('#일반에 메시지 입력');
}

describe('MeetingHub — 채팅', () => {
  let m: ReturnType<typeof mockApi>;
  beforeEach(() => {
    m = mockApi();
    fakeSocket.reset();
    login({ id: 1, username: 'juho' }, 'tok');
    useNameStore.setState({ map: { kim: '김대리' } });
  });
  afterEach(() => vi.useRealTimers());

  it('대시보드 → 채팅 탭: 히스토리·안읽음 구분선·chat:join·읽음 처리·viewing', async () => {
    setupRoutes(m, [
      { id: 1, from: 'kim', avatar: null, text: '어제 메시지', ts: NOW - 86_400_000, channelId: 1 },
      { id: 2, from: 'juho', avatar: null, text: '내 메시지', ts: NOW - 60_000, channelId: 1 },
      { id: 3, from: 'kim', avatar: null, text: '새 메시지', ts: NOW, channelId: 1, unread: true },
    ]);
    renderWithRouter(<MeetingHub code={CODE} />);
    expect(screen.getByText('그룹 정보를 불러오는 중…')).toBeInTheDocument();
    await openChat();
    expect(await screen.findByText('새 메시지')).toBeInTheDocument();
    expect(screen.getByText('여기까지 읽었어요')).toBeInTheDocument();
    expect(screen.getByText('내 메시지').closest('.chat-row')).toHaveClass('mine');
    expect(screen.getAllByText('김대리').length).toBeGreaterThan(0);
    expect(screen.getByText('어제')).toBeInTheDocument();
    expect(fakeSocket.emittedOf('chat:join')[0].args[0]).toEqual({ code: CODE });
    expect(fakeSocket.emittedOf('chat:viewing')[0].args[0]).toEqual({ code: CODE });
    await waitFor(() => expect(m.calls('POST', `/api/meetings/${CODE}/messages/read`).length).toBeGreaterThan(0));
    // 채널 목록·헤더
    expect(screen.getByText('설비')).toBeInTheDocument();
    expect(document.querySelector('.hub-chat-chhead')?.textContent).toContain('일반');
  });

  it('메시지 전송은 소켓 chat:send(채널 포함), 빈 입력은 무시', async () => {
    setupRoutes(m);
    renderWithRouter(<MeetingHub code={CODE} />);
    await openChat();
    expect(screen.getByText('아직 대화가 없어요')).toBeInTheDocument();
    const input = screen.getByPlaceholderText('#일반에 메시지 입력');
    fireEvent.submit(input.closest('form')!);
    expect(fakeSocket.emittedOf('chat:send')).toHaveLength(0);
    await userEvent.type(input, '안녕하세요');
    fireEvent.click(screen.getByRole('button', { name: '전송' }));
    expect(fakeSocket.emittedOf('chat:send')[0].args[0]).toEqual({ code: CODE, text: '안녕하세요', channelId: 1 });
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('소켓 chat:message — 내 채널이면 추가, 다른 채널은 안읽음 점, 다른 그룹은 무시 + meeting:message 이벤트', async () => {
    setupRoutes(m);
    const ev = captureEvents('meeting:message');
    renderWithRouter(<MeetingHub code={CODE} />);
    await openChat();
    act(() => fakeSocket.trigger('chat:message', { code: 'ZZZZ', from: 'kim', text: '다른 그룹', ts: NOW, channelId: 1 }));
    expect(screen.queryByText('다른 그룹')).not.toBeInTheDocument();
    act(() => fakeSocket.trigger('chat:message', { code: CODE, from: 'kim', text: '설비 채널', ts: NOW, channelId: 2 }));
    expect(screen.queryByText('설비 채널')).not.toBeInTheDocument();
    expect(document.querySelector('.hub-channel-dot')).toBeInTheDocument();
    act(() => fakeSocket.trigger('chat:message', { code: CODE, from: 'kim', text: '일반 채널', ts: NOW, channelId: 1 }));
    expect(screen.getByText('일반 채널')).toBeInTheDocument();
    expect(ev.of('meeting:message')).toHaveLength(2);
    // 채널 전환 → 점 해제 + 해당 히스토리 로드 + 플레이스홀더
    fireEvent.click(screen.getByText('설비').closest('button')!);
    await screen.findByPlaceholderText('#설비에 메시지 입력');
    expect(document.querySelector('.hub-channel-dot')).not.toBeInTheDocument();
    await waitFor(() => expect(m.calls('GET', /messages\?channel=2/)).toHaveLength(1));
    ev.stop();
  });

  it('@AI 준비 중 표시 — chat:ai-thinking(내 그룹·채널)에 켜지고 exist AI 메시지에 꺼짐', async () => {
    setupRoutes(m);
    renderWithRouter(<MeetingHub code={CODE} />);
    await openChat();
    act(() => fakeSocket.trigger('chat:ai-thinking', { code: 'ZZZZ', channelId: 1 }));
    expect(document.querySelector('.ai-thinking')).not.toBeInTheDocument();
    act(() => fakeSocket.trigger('chat:ai-thinking', { code: CODE, channelId: 2 }));
    expect(document.querySelector('.ai-thinking')).not.toBeInTheDocument();
    act(() => fakeSocket.trigger('chat:ai-thinking', { code: CODE, channelId: 1 }));
    expect(document.querySelector('.ai-thinking')).toBeInTheDocument();
    expect(within(document.querySelector('.ai-thinking') as HTMLElement).getByText('exist AI')).toBeInTheDocument();
    act(() => fakeSocket.trigger('chat:message', { code: CODE, from: 'exist AI', avatar: '✦', text: '정리했어요', ts: NOW, channelId: 1 }));
    expect(document.querySelector('.ai-thinking')).not.toBeInTheDocument();
    expect(screen.getByText('정리했어요')).toBeInTheDocument();
  });

  it('@AI 준비 중 표시는 45초 후 자동 해제', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setupRoutes(m);
    renderWithRouter(<MeetingHub code={CODE} />);
    await openChat();
    act(() => fakeSocket.trigger('chat:ai-thinking', { code: CODE }));
    expect(document.querySelector('.ai-thinking')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_100);
    });
    expect(document.querySelector('.ai-thinking')).not.toBeInTheDocument();
  });

  it('이미지 메시지 — 썸네일 클릭 → 라이트박스(파일명·다운로드), Esc/배경/닫기, ⬇ 다운로드 앵커', async () => {
    setupRoutes(m, [
      { id: 1, from: 'kim', avatar: null, text: '', ts: NOW, channelId: 1, file: { name: 'photo.PNG', url: '/api/meetings/ABCD/files/9/download', size: 2048 } },
    ]);
    renderWithRouter(<MeetingHub code={CODE} />);
    await openChat();
    const thumb = (await screen.findByAltText('photo.PNG')) as HTMLImageElement;
    expect(thumb).toHaveClass('chat-file-img');
    expect(thumb.getAttribute('src')).toBe('/api/meetings/ABCD/files/9/download?token=tok');
    const dl = document.querySelector<HTMLAnchorElement>('.chat-img-dl')!;
    expect(dl).toHaveAttribute('download', 'photo.PNG');
    expect(dl).toHaveAttribute('href', '/api/meetings/ABCD/files/9/download?token=tok');
    expect(dl).toHaveAttribute('target', '_blank');
    expect(document.querySelector('.img-viewer')).not.toBeInTheDocument();

    fireEvent.click(thumb);
    const viewer = document.querySelector('.img-viewer')!;
    expect(viewer).toBeInTheDocument();
    expect(viewer.parentElement).toBe(document.body);
    expect(within(viewer as HTMLElement).getByText('photo.PNG')).toHaveClass('img-viewer-name');
    const link = within(viewer as HTMLElement).getByRole('link', { name: /다운로드/ });
    expect(link).toHaveAttribute('download', 'photo.PNG');
    expect(link).toHaveAttribute('href', '/api/meetings/ABCD/files/9/download?token=tok');
    expect(within(viewer as HTMLElement).getByRole('img')).toHaveAttribute('alt', 'photo.PNG');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.querySelector('.img-viewer')).not.toBeInTheDocument();

    fireEvent.click(thumb);
    fireEvent.click(document.querySelector('.img-viewer-img')!); // 이미지 자체 클릭은 닫지 않음
    expect(document.querySelector('.img-viewer')).toBeInTheDocument();
    fireEvent.click(document.querySelector('.img-viewer-bar')!);
    expect(document.querySelector('.img-viewer')).toBeInTheDocument();
    fireEvent.click(document.querySelector('.img-viewer')!); // 배경
    expect(document.querySelector('.img-viewer')).not.toBeInTheDocument();

    fireEvent.click(thumb);
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    expect(document.querySelector('.img-viewer')).not.toBeInTheDocument();
    // Esc 리스너는 닫힌 뒤 정리됨
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.querySelector('.img-viewer')).not.toBeInTheDocument();
  });

  it('파일 카드 — 공동편집 문서(fileId)는 클릭 시 딥링크, 일반 파일은 다운로드 앵커, 워크스페이스 업로드는 토큰 없음', async () => {
    setupRoutes(m, [
      { id: 1, from: 'kim', avatar: null, text: '', ts: NOW, channelId: 1, file: { name: 'SOP.doc', fileId: 12 } },
      { id: 2, from: 'kim', avatar: null, text: '', ts: NOW + 1, channelId: 1, file: { name: 'spec.pdf', url: '/api/workspaces/uploads/spec.pdf', size: 3 * 1024 * 1024 } },
    ]);
    const ev = captureEvents('exist:deeplink');
    renderWithRouter(<MeetingHub code={CODE} />);
    await openChat();
    const cards = await screen.findAllByText(/SOP\.doc|spec\.pdf/);
    expect(cards.length).toBeGreaterThanOrEqual(2);
    const docCard = screen.getByText('SOP.doc').closest('a')!;
    fireEvent.click(docCard);
    expect(ev.of('exist:deeplink')).toEqual([{ code: CODE, fileId: 12 }]);
    const pdfCard = screen.getByText('spec.pdf').closest('a')!;
    expect(pdfCard).toHaveAttribute('href', '/api/workspaces/uploads/spec.pdf');
    expect(pdfCard).toHaveAttribute('download', 'spec.pdf');
    expect(screen.getByText('3.0 MB')).toBeInTheDocument();
    ev.stop();
  });

  it('exist:call-dm — 내 그룹 코드일 때만 DM 창, 조직 멤버는 조직 스코프·게스트는 개인 스코프', async () => {
    setupRoutes(m);
    renderWithRouter(<MeetingHub code={CODE} />);
    await screen.findAllByText('생산1팀');
    act(() => window.dispatchEvent(new CustomEvent('exist:call-dm', { detail: { username: 'kim', code: 'ZZZZ' } })));
    expect(document.querySelector('.dm-window')).not.toBeInTheDocument();
    act(() => window.dispatchEvent(new CustomEvent('exist:call-dm', { detail: { username: 'nobody', code: CODE } })));
    expect(document.querySelector('.dm-window')).not.toBeInTheDocument();
    act(() => window.dispatchEvent(new CustomEvent('exist:call-dm', { detail: { username: 'kim', code: 'abcd' } })));
    expect(document.querySelector('.dm-window')).toBeInTheDocument();
    expect(document.querySelector('.dm-head-name')?.textContent).toBe('김대리');
    await waitFor(() => expect(m.calls('GET', '/api/dm/5/with/2')).toHaveLength(1));
    fireEvent.click(screen.getByTitle('닫기'));
    expect(document.querySelector('.dm-window')).not.toBeInTheDocument();
    // 코드 없는 이벤트(구버전)는 허용 — 게스트(role null)는 개인 스코프
    act(() => window.dispatchEvent(new CustomEvent('exist:call-dm', { detail: { username: 'guest' } })));
    await waitFor(() => expect(m.calls('GET', '/api/dm/personal/with/3')).toHaveLength(1));
  });

  it('call:presence로 통화 인원 즉시 갱신, meeting:kicked(내 그룹)면 안내, 404면 meeting:gone', async () => {
    setupRoutes(m);
    const ev = captureEvents('app:error', 'meeting:gone', 'meeting:org');
    renderWithRouter(<MeetingHub code={CODE} />);
    await screen.findAllByText('생산1팀');
    expect(ev.of('meeting:org')).toEqual([{ code: CODE, orgId: 5, orgName: '런타임' }]);
    expect(screen.getByText('대기 중')).toBeInTheDocument();
    act(() => fakeSocket.trigger('call:presence', { code: CODE, peers: ['kim', 'lee'] }));
    // 채널 구독 이펙트 안의 리스너 — 채팅 히스토리가 로드된 뒤 등록됨
    await waitFor(() => expect(screen.getByText(/2명 통화 중/)).toBeInTheDocument());
    act(() => fakeSocket.trigger('meeting:kicked', { code: 'zzzz' }));
    expect(ev.of('app:error')).toHaveLength(0);
    act(() => fakeSocket.trigger('meeting:kicked', { code: 'abcd' }));
    expect(ev.of('app:error')).toEqual(['그룹에서 내보내졌어요.']);
    ev.stop();
  });

  it('삭제된 그룹(404)은 meeting:gone 이벤트로 탭 닫기 요청', async () => {
    m.fail('GET', `/api/meetings/${CODE}`, 404, 'not found');
    m.get(`/api/meetings/${CODE}/channels`, []);
    m.get(/\/api\/todos/, []);
    m.get('/api/presence', { users: [] });
    const ev = captureEvents('meeting:gone', 'app:error');
    renderWithRouter(<MeetingHub code={CODE} />);
    await waitFor(() => expect(ev.of('meeting:gone')).toEqual([{ code: CODE }]));
    expect(ev.of('app:error')).toHaveLength(0);
    ev.stop();
  });

  it('gotoTab — 지정 탭으로 이동, handover는 기록 탭 + exist:open-handover 신호', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setupRoutes(m);
    const ev = captureEvents('exist:open-handover');
    const { rerender } = render(
      <MemoryRouter>
        <MeetingHub code={CODE} gotoTab={{ tab: 'chat', ts: 1 }} />
      </MemoryRouter>,
    );
    await screen.findByPlaceholderText('#일반에 메시지 입력');
    rerender(
      <MemoryRouter>
        <MeetingHub code={CODE} gotoTab={{ tab: 'handover', ts: 2 }} />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('ledger')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(ev.of('exist:open-handover')).toHaveLength(1);
    ev.stop();
  });
});

describe('MeetingHub — 대시보드(할 일·용어집)', () => {
  let m: ReturnType<typeof mockApi>;
  beforeEach(() => {
    m = mockApi();
    fakeSocket.reset();
    login({ id: 1, username: 'juho' }, 'tok');
    useNameStore.setState({ map: { kim: '김대리' } });
  });

  it('회의 할 일 — 목록·추가·완료 토글·삭제', async () => {
    setupRoutes(m);
    m.get(/\/api\/todos\?meeting=ABCD$/, [
      { id: 1, title: '필터 교체', done: 0, assignees: ['kim'], due_at: '2026-01-01' },
      { id: 2, title: '끝난 일', done: 1, assignees: [] },
    ]);
    m.post('/api/todos', { id: 3 });
    m.patch(/\/api\/todos\/\d+$/, {});
    m.delete(/\/api\/todos\/\d+$/, {});
    renderWithRouter(<MeetingHub code={CODE} />);
    expect(await screen.findByText('필터 교체')).toBeInTheDocument();
    expect(document.querySelectorAll('.hub-todo')).toHaveLength(2);
    expect(document.querySelector('.hub-todo.done')).toBeInTheDocument();
    // 추가
    const input = screen.getByPlaceholderText('할 일 추가');
    fireEvent.submit(input.closest('form')!);
    expect(m.calls('POST', '/api/todos')).toHaveLength(0);
    await userEvent.type(input, '점검표 갱신');
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(m.calls('POST', '/api/todos')).toHaveLength(1));
    expect(m.last('POST', '/api/todos').body).toEqual({ title: '점검표 갱신', meeting: CODE });
    expect((input as HTMLInputElement).value).toBe('');
    // 완료 토글
    const cb = document.querySelector('.hub-todo input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(cb);
    await waitFor(() => expect(m.calls('PATCH', '/api/todos/1')).toHaveLength(1));
    expect(m.last('PATCH').body).toEqual({ done: true });
    // 삭제
    fireEvent.click(document.querySelector('.hub-todo .hub-todo-del')!);
    await waitFor(() => expect(m.calls('DELETE', '/api/todos/1')).toHaveLength(1));
  });

  it('용어집 — 2자 이상만 추가, 삭제', async () => {
    setupRoutes(m);
    m.get(`/api/meetings/${CODE}/glossary`, { terms: [{ id: 1, term: '밸리데이션', added_by: 'kim' }] });
    m.post(`/api/meetings/${CODE}/glossary`, { id: 2 });
    m.delete(`/api/meetings/${CODE}/glossary/1`, {});
    renderWithRouter(<MeetingHub code={CODE} />);
    await screen.findAllByText('생산1팀');
    // 용어집은 설정 탭 (자막 교정 사전)
    fireEvent.click([...document.querySelectorAll<HTMLButtonElement>('.hub-tab')].find((b) => b.textContent?.includes('설정'))!);
    expect(await screen.findByText('밸리데이션')).toBeInTheDocument();
    expect(screen.getByText('1개')).toHaveClass('hub-fold-meta');
    const input = screen.getByPlaceholderText('예: 방열판, 밸리데이션, CAPA');
    const submit = input.closest('form')!.querySelector('button[type="submit"]') as HTMLButtonElement;
    await userEvent.type(input, '방');
    expect(submit).toBeDisabled();
    await userEvent.type(input, '열판');
    expect(submit).toBeEnabled();
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(m.calls('POST', `/api/meetings/${CODE}/glossary`)).toHaveLength(1));
    expect(m.last('POST', /glossary$/).body).toEqual({ term: '방열판' });
    m.delete(/\/glossary\/\d+$/, {});
    const before = document.querySelectorAll('[title="용어 삭제"]').length;
    fireEvent.click(screen.getAllByTitle('용어 삭제')[0]);
    expect(document.querySelectorAll('[title="용어 삭제"]')).toHaveLength(before - 1); // 낙관 제거
    await waitFor(() => expect(m.calls('DELETE', /\/glossary\/\d+$/)).toHaveLength(1));
  });

  it('exist:goto-recap(내 코드) → 기록 탭 + archive-focus 재전달, exist:open-file → 공동편집 탭', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setupRoutes(m);
    const ev = captureEvents('exist:archive-focus', 'exist:open-file-now');
    renderWithRouter(<MeetingHub code={CODE} />);
    await screen.findAllByText('생산1팀');
    act(() => window.dispatchEvent(new CustomEvent('exist:goto-recap', { detail: { code: 'ZZZZ', recapId: 1 } })));
    expect(screen.queryByTestId('ledger')).not.toBeInTheDocument();
    act(() => window.dispatchEvent(new CustomEvent('exist:goto-recap', { detail: { code: CODE, recapId: 7 } })));
    expect(await screen.findByTestId('ledger')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    expect(ev.of('exist:archive-focus')).toEqual([{ code: CODE, recapId: 7 }]);
    act(() => window.dispatchEvent(new CustomEvent('exist:open-file', { detail: { code: CODE, fileId: 3 } })));
    expect(await screen.findByTestId('collab-files')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    expect(ev.of('exist:open-file-now')).toEqual([{ code: CODE, fileId: 3 }]);
    ev.stop();
  });
});
