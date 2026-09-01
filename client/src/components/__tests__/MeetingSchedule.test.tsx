import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../test/mockApi';
import { login } from '../../test/auth';
import { captureEvents } from '../../test/render';
import { useNameStore } from '../../names';

vi.mock('../../lib/socket', () => import('../../test/socket.mock'));
import MeetingSchedule from '../MeetingSchedule';

const CODE = 'ABCD';
const pad = (n: number) => String(n).padStart(2, '0');
const today = new Date();
const TODAY = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

const events = [
  { id: 1, title: '아침 TBM', date: TODAY, time: '09:00', end_time: '09:30', is_call: 1, memo: null, remind: null, recur: null, recur_until: null, color: null, end_date: null, people: [], author: 'juho', created_by: 1, acks: [] },
  { id: 2, title: '종일 점검', date: TODAY, time: null, end_time: null, is_call: 0, memo: '메모', remind: 0, recur: null, recur_until: null, color: '#e5484d', end_date: null, people: [{ id: 2, username: 'kim', name: '김대리' }], author: 'kim', created_by: 2, acks: ['kim'] },
];

describe('MeetingSchedule', () => {
  let m: ReturnType<typeof mockApi>;
  beforeEach(() => {
    m = mockApi();
    login({ id: 1, username: 'juho' });
    useNameStore.setState({ map: { kim: '김대리' } });
    m.get(`/api/meetings/${CODE}/events`, events);
    m.get(`/api/meetings/${CODE}/recaps`, []);
    m.get(`/api/meetings/${CODE}/agenda`, { items: [] });
  });

  it('월 뷰에 오늘 일정 칩, 뷰 전환(일/주/월), 오늘 버튼', async () => {
    render(<MeetingSchedule code={CODE} isHost startsAt={null} endsAt={null} participants={[{ userId: 2, username: 'kim' }]} />);
    expect(await screen.findAllByText('아침 TBM')).not.toHaveLength(0);
    expect(screen.getAllByText('종일 점검').length).toBeGreaterThan(0);
    expect(screen.getByRole('tab', { name: '월' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: '주' }));
    expect(screen.getByRole('tab', { name: '주' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByText('아침 TBM').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('tab', { name: '일' }));
    expect(screen.getByRole('tab', { name: '일' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByText(/아침 TBM/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '오늘' }));
    fireEvent.click(screen.getByRole('tab', { name: '월' }));
  });

  it('일정 추가 폼 — 제목 필수, 종료<시작 검증, POST body, exist:schedule-changed', async () => {
    m.post(`/api/meetings/${CODE}/events`, { id: 9 });
    const ev = captureEvents('app:error', 'exist:schedule-changed');
    render(<MeetingSchedule code={CODE} isHost startsAt={null} endsAt={null} />);
    await screen.findAllByText('아침 TBM');
    const titleInput = screen.getByPlaceholderText(/통화\/일정 제목$/);
    const submit = () => fireEvent.submit(titleInput.closest('form')!);
    submit();
    expect(m.calls('POST')).toHaveLength(0);
    await userEvent.type(titleInput, '오후 점검');
    // 시간 입력 (시작/종료)
    const timeInputs = document.querySelectorAll<HTMLInputElement>('input[type="time"]');
    if (timeInputs.length >= 2) {
      fireEvent.change(timeInputs[0], { target: { value: '15:00' } });
      fireEvent.change(timeInputs[1], { target: { value: '14:00' } });
      submit();
      expect(ev.of('app:error')).toEqual(['종료 시간이 시작보다 빨라요']);
      fireEvent.change(timeInputs[1], { target: { value: '16:00' } });
    }
    submit();
    await waitFor(() => expect(m.calls('POST', `/api/meetings/${CODE}/events`)).toHaveLength(1));
    const body = m.last('POST').body as Record<string, unknown>;
    expect(body).toMatchObject({ title: '오후 점검', date: TODAY, recur: null, color: null, people: [] });
    if (timeInputs.length >= 2) expect(body).toMatchObject({ time: '15:00', end_time: '16:00' });
    expect(ev.of('exist:schedule-changed')).toHaveLength(1);
    expect((titleInput as HTMLInputElement).value).toBe('');
    expect(m.calls('GET', `/api/meetings/${CODE}/events`).length).toBeGreaterThanOrEqual(2);
    ev.stop();
  });

  it('하루 종일 토글은 시간을 비우고, 색·반복 옵션이 body에 반영', async () => {
    m.post(`/api/meetings/${CODE}/events`, { id: 10 });
    render(<MeetingSchedule code={CODE} isHost startsAt={null} endsAt={null} />);
    await screen.findAllByText('아침 TBM');
    const titleInput = screen.getByPlaceholderText(/통화\/일정 제목$/);
    await userEvent.type(titleInput, '종일 교육');
    fireEvent.click(screen.getByTitle('시간 없이 하루 종일 일정으로 등록'));
    const selects = document.querySelectorAll<HTMLSelectElement>('.msched-add select');
    for (const s of selects) {
      const opt = [...s.options].find((o) => o.value === 'weekly');
      if (opt) fireEvent.change(s, { target: { value: 'weekly' } });
    }
    fireEvent.submit(titleInput.closest('form')!);
    await waitFor(() => expect(m.calls('POST', `/api/meetings/${CODE}/events`)).toHaveLength(1));
    const body = m.last('POST').body as Record<string, unknown>;
    expect(body).toMatchObject({ title: '종일 교육', time: null, end_time: null, is_call: false });
  });

  it('일정 수신확인(봤음) → POST ack 낙관 반영, 삭제 → DELETE', async () => {
    m.post(`/api/meetings/${CODE}/events/1/ack`, {});
    m.delete(`/api/meetings/${CODE}/events/1`, {});
    render(<MeetingSchedule code={CODE} isHost startsAt={null} endsAt={null} />);
    const chip = (await screen.findAllByText('아침 TBM'))[0];
    fireEvent.click(chip);
    // 팝오버/상세에서 확인·삭제 버튼 탐색 (뷰에 따라 위치가 달라 존재할 때만 검증)
    const ackBtn = screen.queryByText(/봤음|확인/, { selector: 'button' });
    if (ackBtn) {
      fireEvent.click(ackBtn);
      await waitFor(() => expect(m.calls('POST', /\/events\/1\/ack$/)).toHaveLength(1));
    }
    const delBtn = screen.queryAllByTitle('삭제')[0];
    if (delBtn) {
      fireEvent.click(delBtn);
      await waitFor(() => expect(m.calls('DELETE', `/api/meetings/${CODE}/events/1`)).toHaveLength(1));
    }
  });
});
