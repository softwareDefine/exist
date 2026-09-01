import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../test/mockApi';
import { login } from '../../test/auth';
import { useNameStore } from '../../names';

vi.mock('../../lib/socket', () => import('../../test/socket.mock'));
import { fakeSocket } from '../../test/socket.mock';
import HandoverPanel from '../HandoverPanel';

const CODE = 'ABCD';
const T0 = new Date(2026, 7, 20, 8, 5).getTime();

function handover(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    author: 'kim',
    shiftLabel: '주간조 → 야간조',
    sections: { issues: ['2호기 진동'], changes: ['파라미터 63도'], pending: [], notes: ['야간 점검 강화'] },
    checks: [{ label: '알람 확인', done: true }, { label: '파라미터 확인', done: false }],
    source: 'ai',
    ts: T0,
    acks: [],
    ...over,
  };
}

function signAndConfirm() {
  const canvas = document.querySelector('canvas.ho-sign-canvas')!;
  fireEvent.pointerDown(canvas, { clientX: 5, clientY: 5, pointerId: 1 });
  fireEvent.pointerMove(canvas, { clientX: 40, clientY: 30, pointerId: 1 });
  fireEvent.pointerUp(canvas, { pointerId: 1 });
  fireEvent.click(screen.getByRole('button', { name: '서명 완료' }));
}

describe('HandoverPanel', () => {
  let m: ReturnType<typeof mockApi>;
  beforeEach(() => {
    m = mockApi();
    fakeSocket.reset();
    login({ username: 'juho' });
    useNameStore.setState({ map: { kim: '김대리', juho: '이주호' } });
    m.get(`/api/meetings/${CODE}/handovers/checklist`, []);
  });
  afterEach(() => vi.useRealTimers());

  it('로딩 → 빈 안내, embedded면 제목 숨김', async () => {
    m.get(`/api/meetings/${CODE}/handovers`, []);
    const { rerender } = render(<HandoverPanel code={CODE} />);
    expect(screen.getByText('불러오는 중…')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '교대 인수인계' })).toBeInTheDocument();
    expect(await screen.findByText(/아직 인수인계가 없어요/)).toBeInTheDocument();
    rerender(<HandoverPanel code={CODE} embedded />);
    expect(screen.queryByRole('heading', { name: '교대 인수인계' })).not.toBeInTheDocument();
    expect(document.querySelector('.ho-wrap.embedded')).toBeInTheDocument();
  });

  it('카드 렌더 — 섹션·점검 결과·복명복창 대조 배지·서명 스트립, 작성자에겐 서명 버튼 없음', async () => {
    m.get(`/api/meetings/${CODE}/handovers`, [
      handover({
        acks: [
          { username: 'juho', ts: T0, note: '63도 유지', echoCheck: 'ok', echoReason: null, signature: 'data:image/png;base64,x' },
          { username: 'lee', ts: T0, note: '65도 유지', echoCheck: 'mismatch', echoReason: '온도 불일치', signature: null },
        ],
      }),
      handover({ id: 2, author: 'juho', shiftLabel: '', sections: { issues: [], changes: [], pending: [], notes: [] }, checks: [], acks: [] }),
    ]);
    render(<HandoverPanel code={CODE} />);
    expect(await screen.findByText('주간조 → 야간조')).toBeInTheDocument();
    expect(screen.getByText(/김대리 · 8\/20 08:05/)).toBeInTheDocument();
    expect(screen.getByText('2호기 진동')).toBeInTheDocument();
    expect(screen.getByText('설비·작업 이상')).toBeInTheDocument();
    expect(screen.queryByText('미완료 조치')).not.toBeInTheDocument(); // 빈 섹션 숨김
    expect(screen.getByText(/반복 점검 \(/)).toBeInTheDocument();
    expect(screen.getByText(/✓ 알람 확인/)).toBeInTheDocument();
    expect(screen.getByText(/○ 파라미터 확인/)).toBeInTheDocument();
    expect(screen.getByText('이해 일치')).toBeInTheDocument();
    expect(screen.getByText(/해석 확인 필요 — 온도 불일치/)).toBeInTheDocument();
    expect(screen.getByAltText('이주호 서명')).toBeInTheDocument();
    expect(screen.getByText('서명 완료')).toBeInTheDocument(); // 내가 서명한 카드
    expect(screen.getByText(/확인 2명/)).toBeInTheDocument();
    // 두 번째 카드: 내가 작성자 → 서명 버튼 없음, 라벨 폴백
    expect(screen.getByText('인수인계', { selector: '.ho-shift-badge' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /작업 전 서명/ })).not.toBeInTheDocument();
  });

  it('수령 서명 → ack(signature) → 복명복창 한 줄 → ack(note) + 지연 재조회', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    m.get(`/api/meetings/${CODE}/handovers`, [handover()]);
    m.post(`/api/meetings/${CODE}/handovers/1/ack`, { ok: true });
    render(<HandoverPanel code={CODE} />);
    fireEvent.click(await screen.findByRole('button', { name: /확인했어요 — 작업 전 서명/ }));
    expect(screen.getByText('인수인계 수령 서명')).toBeInTheDocument();
    expect(screen.getByText(/주간조 → 야간조 · 김대리/)).toBeInTheDocument();
    signAndConfirm();
    await waitFor(() => expect(m.calls('POST', /\/handovers\/1\/ack$/)).toHaveLength(1));
    expect(m.last('POST').body).toEqual({ signature: 'data:image/png;base64,AAAA' });
    expect(screen.getByText('서명 완료')).toBeInTheDocument();
    expect(screen.getByText(/확인 1명/)).toBeInTheDocument();
    const echo = screen.getByPlaceholderText(/내가 이해한 내용 한 줄/);
    fireEvent.change(echo, { target: { value: '63도 유지, 2호기 점검' } });
    fireEvent.click(screen.getByRole('button', { name: '남기기' }));
    await waitFor(() => expect(m.calls('POST', /\/handovers\/1\/ack$/)).toHaveLength(2));
    expect(m.last('POST').body).toEqual({ note: '63도 유지, 2호기 점검' });
    const gets = () => m.calls('GET', `/api/meetings/${CODE}/handovers`).length;
    await waitFor(() => expect(gets()).toBe(2));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100);
    });
    expect(gets()).toBe(3);
  });

  it('복명복창 건너뛰기 — 서버 호출 없음 / 서명 모달 취소', async () => {
    m.get(`/api/meetings/${CODE}/handovers`, [handover()]);
    m.post(`/api/meetings/${CODE}/handovers/1/ack`, { ok: true });
    render(<HandoverPanel code={CODE} />);
    fireEvent.click(await screen.findByRole('button', { name: /작업 전 서명/ }));
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(screen.queryByText('인수인계 수령 서명')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /작업 전 서명/ }));
    signAndConfirm();
    await waitFor(() => expect(m.calls('POST')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: '건너뛰기' }));
    expect(screen.queryByPlaceholderText(/내가 이해한 내용/)).not.toBeInTheDocument();
    expect(m.calls('POST')).toHaveLength(1);
  });

  it('작성 흐름 — AI 초안 → 체크리스트 → AI 점검 제안 적용 → 발행', async () => {
    m.get(`/api/meetings/${CODE}/handovers`, []);
    m.get(`/api/meetings/${CODE}/handovers/checklist`, [{ id: 1, label: '알람 확인' }]);
    m.post(`/api/meetings/${CODE}/handovers/draft`, {
      source: 'ai',
      sections: { issues: ['2호기 진동'], changes: [], pending: ['필터 교체'], notes: [] },
    });
    m.post(`/api/meetings/${CODE}/handovers/review`, { suggestions: [{ section: 'notes', text: '야간 순찰 2회' }] });
    m.post(`/api/meetings/${CODE}/handovers/checklist`, { id: 2 });
    m.delete(`/api/meetings/${CODE}/handovers/checklist/1`, {});
    m.post(`/api/meetings/${CODE}/handovers`, { id: 5 });
    render(<HandoverPanel code={CODE} />);
    await screen.findByText(/아직 인수인계가 없어요/);
    fireEvent.click(screen.getByRole('button', { name: /인수인계 작성/ }));
    expect(screen.getByText('초안 만드는 중…')).toBeInTheDocument();
    expect(await screen.findByText('AI 초안 — 다듬어 주세요')).toBeInTheDocument();
    const shift = screen.getByPlaceholderText(/교대 \(예/) as HTMLInputElement;
    expect(shift.value).toMatch(/조 → /);
    const areas = document.querySelectorAll<HTMLTextAreaElement>('.ho-sec-edit textarea');
    expect(areas[0].value).toBe('2호기 진동');
    expect(areas[2].value).toBe('필터 교체');

    // 체크리스트 — 체크·추가·삭제
    const cb = screen.getByRole('checkbox');
    fireEvent.click(cb);
    expect(cb).toBeChecked();
    const addInput = screen.getByPlaceholderText('점검 항목 추가');
    expect(screen.getByRole('button', { name: '추가' })).toBeDisabled();
    await userEvent.type(addInput, '파라미터 확인');
    fireEvent.click(screen.getByRole('button', { name: '추가' }));
    await waitFor(() => expect(m.calls('POST', `/api/meetings/${CODE}/handovers/checklist`)).toHaveLength(1));
    expect(m.last('POST', /checklist$/).body).toEqual({ label: '파라미터 확인' });
    fireEvent.click(screen.getByTitle('항목 삭제 (그룹 공통)'));
    await waitFor(() => expect(m.calls('DELETE')).toHaveLength(1));

    // AI 점검
    fireEvent.click(screen.getByRole('button', { name: /AI 점검/ }));
    expect(await screen.findByText('야간 순찰 2회')).toBeInTheDocument();
    expect(screen.getByText('다음 조 유의사항', { selector: '.ho-review-sec' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '+ 추가' }));
    expect(document.querySelectorAll<HTMLTextAreaElement>('.ho-sec-edit textarea')[3].value).toBe('야간 순찰 2회');
    expect(screen.queryByText('+ 추가')).not.toBeInTheDocument();

    // 섹션 편집 후 발행
    fireEvent.change(document.querySelectorAll('.ho-sec-edit textarea')[1], { target: { value: '온도 63도\n\n  속도 유지  ' } });
    fireEvent.change(shift, { target: { value: '주간조 → 야간조' } });
    m.get(`/api/meetings/${CODE}/handovers`, [handover({ id: 5, author: 'juho' })]);
    fireEvent.click(screen.getByRole('button', { name: /발행 — 다음 조에 전달/ }));
    await waitFor(() => expect(m.calls('POST', `/api/meetings/${CODE}/handovers`)).toHaveLength(1));
    const body = m.last('POST', `/api/meetings/${CODE}/handovers`).body as Record<string, unknown>;
    expect(body).toMatchObject({
      shiftLabel: '주간조 → 야간조',
      source: 'ai',
      sections: { issues: ['2호기 진동'], changes: ['온도 63도', '속도 유지'], pending: ['필터 교체'], notes: ['야간 순찰 2회'] },
    });
    // 삭제 후 남은 체크 항목만 (낙관 제거)
    expect((body.checks as unknown[]).length).toBe(0);
    await waitFor(() => expect(screen.queryByText('AI 초안 — 다듬어 주세요')).not.toBeInTheDocument());
    expect(await screen.findByText('주간조 → 야간조', { selector: '.ho-shift-badge' })).toBeInTheDocument();
  });

  it('AI 점검 "빠진 게 없어요" / 취소로 편집기 닫기 / 초안 실패', async () => {
    m.get(`/api/meetings/${CODE}/handovers`, []);
    m.post(`/api/meetings/${CODE}/handovers/draft`, { source: 'rule', sections: { issues: [], changes: [], pending: [], notes: [] } });
    m.post(`/api/meetings/${CODE}/handovers/review`, { suggestions: [] });
    render(<HandoverPanel code={CODE} />);
    fireEvent.click(await screen.findByRole('button', { name: /인수인계 작성/ }));
    expect(await screen.findByText('기록 기반 초안')).toBeInTheDocument();
    expect(screen.getByText(/매 교대 반복되는 점검 항목을 등록해두세요/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /AI 점검/ }));
    expect(await screen.findByText(/빠진 게 없어 보여요/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(screen.queryByText('기록 기반 초안')).not.toBeInTheDocument();

    m.fail('POST', `/api/meetings/${CODE}/handovers/draft`, 500);
    fireEvent.click(screen.getByRole('button', { name: /인수인계 작성/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /인수인계 작성/ })).toBeEnabled());
    expect(screen.queryByText('기록 기반 초안')).not.toBeInTheDocument();
  });

  it('소켓 ledger:changed(내 코드)면 재조회', async () => {
    m.get(`/api/meetings/${CODE}/handovers`, []);
    render(<HandoverPanel code={CODE} />);
    await waitFor(() => expect(m.calls('GET', `/api/meetings/${CODE}/handovers`)).toHaveLength(1));
    act(() => fakeSocket.trigger('ledger:changed', { code: 'ZZZZ' }));
    act(() => fakeSocket.trigger('ledger:changed', { code: CODE }));
    await waitFor(() => expect(m.calls('GET', `/api/meetings/${CODE}/handovers`)).toHaveLength(2));
  });
});
