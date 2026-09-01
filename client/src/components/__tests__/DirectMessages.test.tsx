import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi, tick } from '../../test/mockApi';
import { login } from '../../test/auth';
import { captureEvents } from '../../test/render';
import { useNameStore } from '../../names';

vi.mock('../../lib/socket', () => import('../../test/socket.mock'));
import { fakeSocket } from '../../test/socket.mock';
import DirectMessages, { DmWindow, relTime, type Thread } from '../DirectMessages';

const NOW = Date.now();
const peer: Thread = {
  userId: 2,
  username: 'kim',
  avatar: null,
  position: '대리',
  department: '생산1팀',
  lastText: '넵',
  lastTs: NOW - 60_000,
  lastMine: false,
  unread: 2,
};
const msg = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  fromId: 2,
  from: 'kim',
  avatar: null,
  mine: false,
  text: `메시지 ${id}`,
  ts: NOW - (10 - id) * 60_000,
  ...over,
});

describe('relTime', () => {
  it('방금/분/시간/일', () => {
    expect(relTime(Date.now())).toBe('방금');
    expect(relTime(Date.now() - 5 * 60_000)).toBe('5분');
    expect(relTime(Date.now() - 3 * 3_600_000)).toBe('3시간');
    expect(relTime(Date.now() - 2 * 86_400_000)).toBe('2일');
  });
});

describe('DmWindow', () => {
  let m: ReturnType<typeof mockApi>;
  const onClose = vi.fn();
  const onActivity = vi.fn();
  beforeEach(() => {
    m = mockApi();
    fakeSocket.reset();
    onClose.mockClear();
    onActivity.mockClear();
    login({ id: 1, username: 'juho' });
    useNameStore.setState({ map: { kim: '김대리' } });
  });

  it('히스토리 로드 + 안읽음 구분선 + dm:viewing 통지, 닫기', async () => {
    m.get('/api/dm/5/with/2', [msg(1, { ts: NOW - 86_400_000 * 3 }), msg(2, { mine: true, fromId: 1, from: 'juho' }), msg(3, { unread: true })]);
    const { unmount } = render(<DmWindow scope={5} peer={peer} onClose={onClose} onActivity={onActivity} />);
    expect(fakeSocket.emittedOf('dm:viewing')[0].args[0]).toEqual({ peerId: 2 });
    expect(screen.getByText('김대리')).toBeInTheDocument();
    expect(screen.getByText('생산1팀 · 대리')).toBeInTheDocument();
    expect(await screen.findByText('메시지 3')).toBeInTheDocument();
    expect(screen.getByText('여기까지 읽었어요')).toBeInTheDocument();
    expect(document.querySelectorAll('.chat-row.mine')).toHaveLength(1);
    // 날짜 구분 — 3일 전 + 오늘
    expect(screen.getByText('오늘')).toBeInTheDocument();
    expect(document.querySelectorAll('.chat-date')).toHaveLength(2);
    fireEvent.click(screen.getByTitle('닫기'));
    expect(onClose).toHaveBeenCalled();
    unmount();
    expect(fakeSocket.emittedOf('dm:viewing').at(-1)!.args[0]).toEqual({ peerId: null });
    expect(fakeSocket.listenerCount('dm:message')).toBe(0);
  });

  it('빈 대화 안내 → 전송: POST + 낙관 추가 + onActivity, 소켓 echo는 중복 제거', async () => {
    m.get('/api/dm/personal/with/2', []);
    m.post('/api/dm/personal/with/2', { id: 77, orgId: null, fromId: 1, toId: 2, from: 'juho', avatar: null, text: '안녕', ts: NOW });
    render(<DmWindow scope="personal" peer={peer} onClose={onClose} onActivity={onActivity} />);
    expect(await screen.findByText('김대리님과의 대화')).toBeInTheDocument();
    const input = screen.getByPlaceholderText('메시지 입력');
    const send = screen.getByRole('button', { name: '전송' });
    expect(send).toBeDisabled();
    await userEvent.type(input, '안녕');
    expect(send).toBeEnabled();
    fireEvent.click(send);
    await waitFor(() => expect(m.calls('POST', '/api/dm/personal/with/2')).toHaveLength(1));
    expect(m.last('POST').body).toEqual({ text: '안녕' });
    expect(await screen.findByText('안녕')).toBeInTheDocument();
    expect(onActivity).toHaveBeenCalledTimes(1);
    expect((input as HTMLInputElement).value).toBe('');
    // 소켓 echo 같은 id → 한 번만
    act(() => fakeSocket.trigger('dm:message', { id: 77, orgId: null, fromId: 1, toId: 2, from: 'juho', avatar: null, text: '안녕', ts: NOW }));
    expect(screen.getAllByText('안녕')).toHaveLength(1);
  });

  it('전송 실패 → 입력 복원', async () => {
    m.get('/api/dm/personal/with/2', []);
    m.fail('POST', '/api/dm/personal/with/2', 500, '실패');
    render(<DmWindow scope="personal" peer={peer} onClose={onClose} onActivity={onActivity} />);
    const input = screen.getByPlaceholderText('메시지 입력');
    await userEvent.type(input, '다시');
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('다시'));
    expect(onActivity).not.toHaveBeenCalled();
  });

  it('소켓 수신 — 스코프(orgId) 불일치·다른 상대는 무시, 상대 메시지는 추가 + 읽음 처리', async () => {
    m.get('/api/dm/5/with/2', []);
    m.post('/api/dm/5/with/2/read', {});
    render(<DmWindow scope={5} peer={peer} onClose={onClose} onActivity={onActivity} />);
    await tick();
    const base = { avatar: null, ts: NOW };
    act(() => fakeSocket.trigger('dm:message', { id: 1, orgId: null, fromId: 2, toId: 1, from: 'kim', text: '개인 스코프', ...base }));
    act(() => fakeSocket.trigger('dm:message', { id: 2, orgId: 9, fromId: 2, toId: 1, from: 'kim', text: '다른 조직', ...base }));
    act(() => fakeSocket.trigger('dm:message', { id: 3, orgId: 5, fromId: 3, toId: 1, from: 'lee', text: '다른 사람', ...base }));
    expect(screen.queryByText('개인 스코프')).not.toBeInTheDocument();
    expect(screen.queryByText('다른 조직')).not.toBeInTheDocument();
    expect(screen.queryByText('다른 사람')).not.toBeInTheDocument();
    act(() => fakeSocket.trigger('dm:message', { id: 4, orgId: 5, fromId: 2, toId: 1, from: 'kim', text: '맞는 메시지', ...base }));
    expect(screen.getByText('맞는 메시지')).toBeInTheDocument();
    await waitFor(() => expect(m.calls('POST', '/api/dm/5/with/2/read')).toHaveLength(1));
    // 내가 다른 탭에서 보낸 것도 이 창에 (mine)
    act(() => fakeSocket.trigger('dm:message', { id: 5, orgId: 5, fromId: 1, toId: 2, from: 'juho', text: '내가 보냄', ...base }));
    expect(screen.getByText('내가 보냄').closest('.chat-row')).toHaveClass('mine');
    expect(m.calls('POST', '/api/dm/5/with/2/read')).toHaveLength(1);
  });

  it('exist AI 상대 — 전송 직후 준비 중 표시, 답 도착 시 해제', async () => {
    const ai: Thread = { ...peer, userId: 99, username: 'exist AI', avatar: '✦' };
    m.get('/api/dm/personal/with/99', []);
    m.post('/api/dm/personal/with/99', { id: 1, orgId: null, fromId: 1, toId: 99, from: 'juho', avatar: null, text: '질문', ts: NOW });
    m.post('/api/dm/personal/with/99/read', {});
    render(<DmWindow scope="personal" peer={ai} onClose={onClose} onActivity={onActivity} />);
    await userEvent.type(screen.getByPlaceholderText('메시지 입력'), '질문');
    fireEvent.click(screen.getByRole('button', { name: '전송' }));
    expect(document.querySelector('.chat-typing')).toBeInTheDocument();
    await screen.findByText('질문');
    act(() => fakeSocket.trigger('dm:message', { id: 2, orgId: null, fromId: 99, toId: 1, from: 'exist AI', avatar: '✦', text: '답변', ts: NOW + 1 }));
    expect(screen.getByText('답변')).toBeInTheDocument();
    expect(document.querySelector('.chat-typing')).not.toBeInTheDocument();
  });

  it('파일 공유 DM 꼬리 딥링크 → "문서 바로 열기" 버튼 → exist:deeplink', async () => {
    m.get('/api/dm/personal/with/2', [msg(1, { text: 'SOP 개정본 봐주세요\n/?g=abcd&file=12' })]);
    const ev = captureEvents('exist:deeplink');
    render(<DmWindow scope="personal" peer={peer} onClose={onClose} onActivity={onActivity} />);
    fireEvent.click(await screen.findByRole('button', { name: /문서 바로 열기/ }));
    expect(ev.of('exist:deeplink')).toEqual([{ code: 'ABCD', fileId: 12 }]);
    ev.stop();
  });
});

describe('DirectMessages (목록)', () => {
  let m: ReturnType<typeof mockApi>;
  beforeEach(() => {
    m = mockApi();
    fakeSocket.reset();
    login({ id: 1, username: 'juho' });
    useNameStore.setState({ map: { kim: '김대리', lee: '이과장' } });
  });
  afterEach(() => vi.useRealTimers());

  const threads: Thread[] = [
    peer,
    { userId: 3, username: 'lee', avatar: null, position: null, department: null, lastText: '회의 자료', lastTs: NOW - 3_600_000, lastMine: true, unread: 0 },
    { userId: 4, username: 'park', avatar: null, position: '사원', department: '품질', lastText: null, lastTs: null, lastMine: false, unread: 12 },
  ];

  it('조직 스코프 — 스레드 목록·안읽음 배지·미리보기, 열면 안읽음 0 + 창', async () => {
    m.get('/api/dm/5/threads', threads);
    m.get('/api/dm/5/with/2', []);
    render(<DirectMessages scope={5} />);
    expect(await screen.findByText('김대리')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('이름으로 검색해 새 대화')).not.toBeInTheDocument();
    expect(screen.getByText('2')).toHaveClass('dm-item-badge');
    expect(screen.getByText('9+')).toHaveClass('dm-item-badge');
    expect(screen.getByText('나:')).toBeInTheDocument();
    expect(screen.getByText('품질 · 사원')).toBeInTheDocument();
    fireEvent.click(screen.getByText('김대리').closest('button')!);
    expect(screen.queryByText('2')).not.toBeInTheDocument();
    expect(document.querySelector('.dm-window')).toBeInTheDocument();
    expect(document.querySelector('.dm-item.active')).toBeInTheDocument();
  });

  it('빈 목록 안내 (조직/개인)', async () => {
    m.get('/api/dm/5/threads', []);
    const { rerender } = render(<DirectMessages scope={5} />);
    expect(await screen.findByText('이 조직에 다른 멤버가 없어요')).toBeInTheDocument();
    m.get('/api/dm/personal/threads', []);
    rerender(<DirectMessages scope="personal" />);
    expect(await screen.findByText('위에서 이름을 검색해 대화를 시작해보세요')).toBeInTheDocument();
  });

  it('개인 스코프 — 이름 검색(디바운스) → 새 대화 열기 / 기존 스레드면 그걸로', async () => {
    m.get('/api/dm/personal/threads', [peer]);
    m.get(/\/api\/dm\/personal\/search\?q=/, [
      { userId: 2, username: 'kim', avatar: null },
      { userId: 9, username: 'new', avatar: null },
    ]);
    m.get(/\/api\/dm\/personal\/with\/\d+$/, []);
    render(<DirectMessages scope="personal" />);
    await screen.findByText('김대리');
    const search = screen.getByPlaceholderText('이름으로 검색해 새 대화');
    await userEvent.type(search, 'k');
    await waitFor(() => expect(screen.getByText('new')).toBeInTheDocument());
    expect(m.last('GET', /search/).url).toContain('q=k');
    fireEvent.click(screen.getByText('new').closest('button')!);
    expect(document.querySelectorAll('.dm-search-hit')).toHaveLength(0); // 검색 결과 닫힘
    expect(document.querySelector('.dm-head-name')?.textContent).toBe('new');
    expect((search as HTMLInputElement).value).toBe('');

    await userEvent.type(search, 'k');
    await waitFor(() => expect(document.querySelectorAll('.dm-search-hit')).toHaveLength(2));
    fireEvent.click(document.querySelectorAll('.dm-search-hit')[0]);
    expect(document.querySelector('.dm-head-name')?.textContent).toBe('김대리');
  });

  it('소켓 dm:message — 미리보기·안읽음 갱신(맨 위로), 열린 상대는 안읽음 증가 없음, 스코프 불일치 무시, 새 상대는 재조회', async () => {
    m.get('/api/dm/5/threads', threads);
    m.get('/api/dm/5/with/3', []);
    render(<DirectMessages scope={5} />);
    await screen.findByText('김대리');
    const base = { avatar: null, ts: NOW + 1000 };
    act(() => fakeSocket.trigger('dm:message', { id: 1, orgId: null, fromId: 3, toId: 1, from: 'lee', text: '개인', ...base }));
    expect(screen.queryByText('개인')).not.toBeInTheDocument();
    act(() => fakeSocket.trigger('dm:message', { id: 2, orgId: 5, fromId: 3, toId: 1, from: 'lee', text: '새 소식', ...base }));
    const items = document.querySelectorAll('.dm-item');
    expect(items[0].textContent).toContain('이과장');
    expect(items[0].textContent).toContain('새 소식');
    expect(items[0].querySelector('.dm-item-badge')?.textContent).toBe('1');
    // 이과장 창을 열어두면 안읽음 안 오름
    fireEvent.click(items[0]);
    act(() => fakeSocket.trigger('dm:message', { id: 3, orgId: 5, fromId: 3, toId: 1, from: 'lee', text: '또', ...base }));
    expect(document.querySelectorAll('.dm-item')[0].querySelector('.dm-item-badge')).toBeNull();
    // 내가 보낸 메시지는 "나:" 미리보기
    act(() => fakeSocket.trigger('dm:message', { id: 4, orgId: 5, fromId: 1, toId: 2, from: 'juho', text: '답장', ...base }));
    expect(document.querySelectorAll('.dm-item')[0].textContent).toContain('나:');
    // 모르는 상대 → 목록 재조회
    expect(m.calls('GET', '/api/dm/5/threads')).toHaveLength(1);
    act(() => fakeSocket.trigger('dm:message', { id: 5, orgId: 5, fromId: 42, toId: 1, from: 'x', text: '?', ...base }));
    await waitFor(() => expect(m.calls('GET', '/api/dm/5/threads')).toHaveLength(2));
  });

  it('스코프가 바뀌면 창 닫고 목록 재조회', async () => {
    m.get('/api/dm/5/threads', threads);
    m.get('/api/dm/personal/threads', []);
    m.get('/api/dm/5/with/2', []);
    const { rerender } = render(<DirectMessages scope={5} />);
    fireEvent.click((await screen.findByText('김대리')).closest('button')!);
    expect(document.querySelector('.dm-window')).toBeInTheDocument();
    rerender(<DirectMessages scope="personal" />);
    expect(document.querySelector('.dm-window')).not.toBeInTheDocument();
    await waitFor(() => expect(m.calls('GET', '/api/dm/personal/threads')).toHaveLength(1));
  });
});
