import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../test/mockApi';
import { login } from '../../test/auth';
import { captureEvents } from '../../test/render';
import { useNameStore } from '../../names';

vi.mock('../../lib/socket', () => import('../../test/socket.mock'));
import { fakeSocket } from '../../test/socket.mock';
import UnifiedInbox from '../UnifiedInbox';

const NOW = Date.now();
const utc = (ts: number) => new Date(ts).toISOString().slice(0, 19).replace('T', ' '); // SQLite datetime('now') 형식

describe('UnifiedInbox', () => {
  let m: ReturnType<typeof mockApi>;
  beforeEach(() => {
    m = mockApi();
    fakeSocket.reset();
    login({ id: 1, username: 'juho' });
    useNameStore.setState({ map: { kim: '김대리' } });
  });
  afterEach(() => vi.useRealTimers());

  const groups = [
    { id: 1, code: 'ABCD', title: '생산1팀', thumbnail: null, lastText: '오늘 회의', lastTs: utc(NOW - 2 * 60_000), unread: 3 },
    { id: 2, code: 'EFGH', title: '조용한 그룹', thumbnail: null, lastText: null, lastTs: null, unread: 0 },
  ];
  const threads = [
    { userId: 2, username: 'kim', avatar: null, position: '대리', department: '생산', lastText: '넵', lastTs: NOW - 60_000, lastMine: true, unread: 1 },
  ];

  it('그룹+DM 병합 최근순, UTC 보정, 안읽음 배지', async () => {
    m.get(/\/api\/meetings\/inbox\?org=5$/, groups);
    m.get('/api/dm/5/threads', threads);
    render(<UnifiedInbox scope={5} />);
    await screen.findByText('김대리');
    await screen.findByText('생산1팀');
    const items = [...document.querySelectorAll('.dm-item')].map((el) => el.textContent ?? '');
    expect(items[0]).toContain('김대리'); // 1분 전
    expect(items[1]).toContain('생산1팀'); // 2분 전
    expect(items[2]).toContain('조용한 그룹'); // 메시지 없음 → 맨 뒤
    expect(items[0]).toContain('나:');
    expect(items[1]).toContain('2분');
    expect(items[2]).toContain('아직 메시지가 없어요');
    expect(screen.getByText('3')).toHaveClass('dm-item-badge');
    // 목록의 그룹 룸 구독
    await waitFor(() => expect(fakeSocket.emittedOf('chat:join')).toHaveLength(2));
    expect(fakeSocket.emittedOf('chat:join').map((e) => (e.args[0] as { code: string }).code)).toEqual(['ABCD', 'EFGH']);
  });

  it('빈 목록 안내', async () => {
    m.get(/\/api\/meetings\/inbox\?org=personal$/, []);
    m.get('/api/dm/personal/threads', []);
    render(<UnifiedInbox scope="personal" />);
    expect(await screen.findByText('아직 대화가 없어요')).toBeInTheDocument();
  });

  it('그룹 클릭 → exist:open-meeting(chat 탭) + 안읽음 0 / DM 클릭 → 창', async () => {
    m.get(/\/api\/meetings\/inbox\?org=5$/, groups);
    m.get('/api/dm/5/threads', threads);
    m.get('/api/dm/5/with/2', []);
    const ev = captureEvents('exist:open-meeting');
    render(<UnifiedInbox scope={5} />);
    fireEvent.click((await screen.findByText('생산1팀')).closest('button')!);
    expect(ev.of('exist:open-meeting')).toEqual([{ code: 'ABCD', title: '생산1팀', tab: 'chat' }]);
    expect(screen.queryByText('3')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('김대리').closest('button')!);
    expect(document.querySelector('.dm-window')).toBeInTheDocument();
    expect(document.querySelector('.dm-item-badge')).toBeNull();
    fireEvent.click(screen.getByTitle('닫기'));
    expect(document.querySelector('.dm-window')).not.toBeInTheDocument();
    ev.stop();
  });

  it('이름 검색 → 새 상대는 임시 스레드로 창, 기존 상대는 그 스레드로', async () => {
    m.get(/\/api\/meetings\/inbox\?org=personal$/, []);
    m.get('/api/dm/personal/threads', threads);
    m.get(/\/api\/dm\/personal\/search/, [
      { userId: 2, username: 'kim', avatar: null },
      { userId: 7, username: 'new', avatar: null },
    ]);
    m.get(/\/api\/dm\/personal\/with\/\d+$/, []);
    render(<UnifiedInbox scope="personal" />);
    await screen.findByText('김대리');
    await userEvent.type(screen.getByPlaceholderText('이름으로 검색해 새 대화'), 'n');
    const hit = await screen.findByText('new');
    fireEvent.click(hit.closest('button')!);
    expect(document.querySelector('.dm-head-name')?.textContent).toBe('new');
    await userEvent.type(screen.getByPlaceholderText('이름으로 검색해 새 대화'), 'k');
    await waitFor(() => expect(document.querySelectorAll('.dm-search-hit')).toHaveLength(2));
    fireEvent.click(document.querySelectorAll('.dm-search-hit')[0]);
    expect(document.querySelector('.dm-head-name')?.textContent).toBe('김대리');
  });

  it('소켓 — chat:message/inbox:changed는 300ms 묶음 재조회, dm:message는 스레드 재조회, reconnect는 전부', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    m.get(/\/api\/meetings\/inbox\?org=5$/, groups);
    m.get('/api/dm/5/threads', threads);
    render(<UnifiedInbox scope={5} />);
    await waitFor(() => expect(m.calls('GET', /inbox/)).toHaveLength(1));
    act(() => {
      fakeSocket.trigger('chat:message', {});
      fakeSocket.trigger('chat:message', {});
      fakeSocket.trigger('inbox:changed', {});
      fakeSocket.trigger('dm:message', {});
      fakeSocket.trigger('dm:message', {});
    });
    expect(m.calls('GET', /inbox/)).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    expect(m.calls('GET', /inbox/)).toHaveLength(2);
    expect(m.calls('GET', '/api/dm/5/threads')).toHaveLength(2);
    act(() => fakeSocket.triggerIo('reconnect'));
    await waitFor(() => expect(m.calls('GET', /inbox/)).toHaveLength(3));
    expect(m.calls('GET', '/api/dm/5/threads')).toHaveLength(3);
  });
});
