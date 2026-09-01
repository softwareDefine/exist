import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi, tick } from '../../test/mockApi';
import { login } from '../../test/auth';
import { captureEvents } from '../../test/render';
import { useNameStore } from '../../names';

vi.mock('../../lib/socket', () => import('../../test/socket.mock'));
import { fakeSocket } from '../../test/socket.mock';
import DecisionLedger from '../DecisionLedger';

const CODE = 'ABCD';
const T0 = new Date(2026, 7, 20, 10, 0).getTime();

function entry(over: Record<string, unknown> = {}) {
  return {
    recapId: 10,
    idx: 0,
    decision: '냉각수 온도 63도로 유지',
    why: '65도에서 라인 알람',
    alts: ['60도 — 생산성 저하'],
    attendees: ['juho', 'kim'],
    ts: T0,
    acks: [],
    ...over,
  };
}

describe('DecisionLedger', () => {
  let m: ReturnType<typeof mockApi>;
  let ev: ReturnType<typeof captureEvents>;
  beforeEach(() => {
    m = mockApi();
    fakeSocket.reset();
    login({ username: 'juho' });
    useNameStore.setState({ map: { kim: '김대리', juho: '이주호' } });
    ev = captureEvents('app:error', 'app:info', 'exist:goto-recap', 'exist:open-file');
  });
  afterEach(() => ev.stop());

  it('빈 원장 안내', async () => {
    m.get(`/api/meetings/${CODE}/decisions`, []);
    render(<DecisionLedger code={CODE} />);
    expect(await screen.findByText('아직 기록된 결정이 없어요')).toBeInTheDocument();
    expect(screen.getByText('0')).toHaveClass('ledger-count');
  });

  it('결정·배경·대안·참석·확인 수 렌더 + 검색 필터 + 정리 보기 이벤트', async () => {
    m.get(`/api/meetings/${CODE}/decisions`, [
      entry({ acks: [{ username: 'kim', ts: T0 + 1 }], todos: [{ title: '라인 반영', done: 1 }, { title: '문서', done: 0 }], revisedFiles: [{ id: 3, rev: 2, name: 'SOP' }] }),
      entry({ recapId: 11, idx: 0, decision: '다른 날 결정', why: '', alts: [], ts: T0 - 86_400_000 * 2, attendees: [] }),
    ]);
    render(<DecisionLedger code={CODE} />);
    expect(await screen.findByText('냉각수 온도 63도로 유지')).toBeInTheDocument();
    expect(screen.getByText('배경 · 65도에서 라인 알람')).toBeInTheDocument();
    expect(screen.getByText('검토된 대안 · 60도 — 생산성 저하')).toBeInTheDocument();
    expect(screen.getByText(/참석 이주호, 김대리/)).toBeInTheDocument();
    expect(screen.getByText(/확인 1명 \(김대리\)/)).toBeInTheDocument();
    expect(screen.getByText(/실행 1\/2/)).toBeInTheDocument();
    expect(screen.getByText(/참석 기록 없음/)).toBeInTheDocument();
    // 날짜 그룹 2개
    expect(screen.getByText('2026년 8월 20일')).toBeInTheDocument();
    expect(screen.getByText('2026년 8월 18일')).toBeInTheDocument();
    expect(screen.getByText('2')).toHaveClass('ledger-count');

    fireEvent.click(screen.getByText('개정 SOP v2'));
    expect(ev.of('exist:open-file')).toEqual([{ code: CODE, fileId: 3 }]);
    fireEvent.click(screen.getAllByText('정리 보기')[0]);
    expect(ev.of('exist:goto-recap')).toEqual([{ code: CODE, recapId: 10 }]);

    await userEvent.type(screen.getByPlaceholderText('결정 검색'), '다른 날');
    expect(screen.queryByText('냉각수 온도 63도로 유지')).not.toBeInTheDocument();
    expect(screen.getByText('다른 날 결정')).toBeInTheDocument();
    await userEvent.clear(screen.getByPlaceholderText('결정 검색'));
    await userEvent.type(screen.getByPlaceholderText('결정 검색'), '없는말');
    expect(screen.getByText('"없는말" 검색 결과가 없어요')).toBeInTheDocument();
  });

  it('확인 버튼 → 낙관 반영 + ack API, 현장 한 줄 메모 저장', async () => {
    m.get(`/api/meetings/${CODE}/decisions`, [entry()]);
    m.post(`/api/meetings/${CODE}/decisions/ack`, { ok: true });
    render(<DecisionLedger code={CODE} />);
    const btn = await screen.findByRole('button', { name: '확인' });
    fireEvent.click(btn);
    expect(screen.getByText('확인함')).toBeInTheDocument();
    expect(screen.getByText(/확인 1명 \(이주호\)/)).toBeInTheDocument();
    await waitFor(() => expect(m.calls('POST', `/api/meetings/${CODE}/decisions/ack`)).toHaveLength(1));
    expect(m.last('POST', `/api/meetings/${CODE}/decisions/ack`).body).toEqual({ recapId: 10, idx: 0 });

    // 메모 폼 — 비우고 제출하면 "건너뛰기"(저장 없음)
    const input = screen.getByPlaceholderText(/현장 한 줄 남기기/);
    expect(screen.getByRole('button', { name: '건너뛰기' })).toBeInTheDocument();
    await userEvent.type(input, '라인에 반영 완료');
    fireEvent.click(screen.getByRole('button', { name: '남기기' }));
    await waitFor(() => expect(m.calls('POST', `/api/meetings/${CODE}/decisions/ack`)).toHaveLength(2));
    expect(m.last('POST', `/api/meetings/${CODE}/decisions/ack`).body).toEqual({ recapId: 10, idx: 0, note: '라인에 반영 완료' });
    expect(screen.getByText('라인에 반영 완료')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/현장 한 줄 남기기/)).not.toBeInTheDocument();
  });

  it('ack 실패 시 서버 상태로 재조회', async () => {
    m.get(`/api/meetings/${CODE}/decisions`, [entry()]);
    m.fail('POST', `/api/meetings/${CODE}/decisions/ack`, 500);
    render(<DecisionLedger code={CODE} />);
    fireEvent.click(await screen.findByRole('button', { name: '확인' }));
    await waitFor(() => expect(m.calls('GET', `/api/meetings/${CODE}/decisions`)).toHaveLength(2));
  });

  it('작업 전 확인 필수 결정은 손 서명 모달을 거쳐 서명과 함께 ack', async () => {
    m.get(`/api/meetings/${CODE}/decisions`, [entry({ critical: true })]);
    m.post(`/api/meetings/${CODE}/decisions/ack`, { ok: true });
    render(<DecisionLedger code={CODE} />);
    expect(await screen.findByText('작업 전 확인 필수')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '확인' }));
    expect(screen.getByText('결정 확인 서명')).toBeInTheDocument();
    expect(m.calls('POST')).toHaveLength(0);
    const canvas = document.querySelector('canvas.ho-sign-canvas')!;
    expect(screen.getByRole('button', { name: '서명 완료' })).toBeDisabled();
    fireEvent.pointerDown(canvas, { clientX: 5, clientY: 5, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 30, clientY: 20, pointerId: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    fireEvent.click(screen.getByRole('button', { name: '서명 완료' }));
    await waitFor(() => expect(m.calls('POST', `/api/meetings/${CODE}/decisions/ack`)).toHaveLength(1));
    expect(m.last('POST').body).toEqual({ recapId: 10, idx: 0, signature: 'data:image/png;base64,AAAA' });
    expect(screen.queryByText('결정 확인 서명')).not.toBeInTheDocument();
    expect(screen.getByAltText('이주호 서명')).toBeInTheDocument();
  });

  it('서명 모달 취소/배경 클릭으로 닫기', async () => {
    m.get(`/api/meetings/${CODE}/decisions`, [entry({ critical: true })]);
    render(<DecisionLedger code={CODE} />);
    fireEvent.click(await screen.findByRole('button', { name: '확인' }));
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(screen.queryByText('결정 확인 서명')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '확인' }));
    fireEvent.click(document.querySelector('.cf-signmodal-backdrop')!);
    expect(screen.queryByText('결정 확인 서명')).not.toBeInTheDocument();
  });

  it('canManage 없으면 정정·철회 버튼 없음', async () => {
    m.get(`/api/meetings/${CODE}/decisions`, [entry()]);
    render(<DecisionLedger code={CODE} />);
    await screen.findByText('냉각수 온도 63도로 유지');
    expect(screen.queryByRole('button', { name: '정정' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '철회' })).not.toBeInTheDocument();
  });

  it('정정 모달 — 사유 필수, PATCH body, 재확인 안내', async () => {
    m.get(`/api/meetings/${CODE}/decisions`, [entry()]);
    m.patch(`/api/meetings/${CODE}/decisions/10/0`, { ok: true, acksReset: true });
    render(<DecisionLedger code={CODE} canManage />);
    fireEvent.click(await screen.findByRole('button', { name: '정정' }));
    expect(screen.getByText('결정 정정')).toBeInTheDocument();
    const textarea = document.querySelector('.ledger-edit-modal textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe('냉각수 온도 63도로 유지');

    fireEvent.click(screen.getByRole('button', { name: '정정하기' }));
    expect(ev.of('app:error')).toEqual(['정정 사유를 적어주세요']);
    expect(m.calls('PATCH')).toHaveLength(0);

    fireEvent.change(textarea, { target: { value: '냉각수 온도 65도로 유지' } });
    fireEvent.change(screen.getByPlaceholderText('없으면 비워두기'), { target: { value: '새 배경' } });
    fireEvent.change(screen.getByPlaceholderText(/회의에서 65도가 아니라/), { target: { value: '원문 확인' } });
    fireEvent.click(screen.getByRole('button', { name: '정정하기' }));
    await waitFor(() => expect(m.calls('PATCH')).toHaveLength(1));
    expect(m.last('PATCH').body).toEqual({ decision: '냉각수 온도 65도로 유지', why: '새 배경', reason: '원문 확인' });
    await waitFor(() => expect(screen.queryByText('결정 정정')).not.toBeInTheDocument());
    expect(ev.of('app:info')[0]).toContain('재확인을 요청했어요');
    expect(m.calls('GET', `/api/meetings/${CODE}/decisions`)).toHaveLength(2);
  });

  it('정정 실패 → 에러 토스트, 모달 유지 / 취소로 닫기', async () => {
    m.get(`/api/meetings/${CODE}/decisions`, [entry()]);
    m.fail('PATCH', `/api/meetings/${CODE}/decisions/10/0`, 403, '권한 없음');
    render(<DecisionLedger code={CODE} canManage />);
    fireEvent.click(await screen.findByRole('button', { name: '정정' }));
    fireEvent.change(screen.getByPlaceholderText(/회의에서 65도가 아니라/), { target: { value: '사유' } });
    fireEvent.click(screen.getByRole('button', { name: '정정하기' }));
    await waitFor(() => expect(ev.of('app:error').some((d) => String(d).includes('권한 없음'))).toBe(true));
    expect(screen.getByText('결정 정정')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(screen.queryByText('결정 정정')).not.toBeInTheDocument();
  });

  it('철회 모달 — 사유 필수, POST, 철회된 행은 배지·사유 표시 + 확인/정정 불가', async () => {
    m.get(`/api/meetings/${CODE}/decisions`, [entry()]);
    m.post(`/api/meetings/${CODE}/decisions/10/0/withdraw`, { ok: true });
    render(<DecisionLedger code={CODE} canManage />);
    fireEvent.click(await screen.findByRole('button', { name: '철회' }));
    expect(screen.getByText('결정 철회')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '철회하기' }));
    expect(ev.of('app:error')).toEqual(['철회 사유를 적어주세요']);

    // 재조회 응답은 철회된 상태
    m.get(`/api/meetings/${CODE}/decisions`, [
      entry({ withdrawn: { reason: '안전팀 보류', by: 'kim', at: T0 + 1000 }, revisions: 1 }),
    ]);
    fireEvent.change(screen.getByPlaceholderText(/안전팀 검토 결과/), { target: { value: '안전팀 보류' } });
    fireEvent.click(screen.getByRole('button', { name: '철회하기' }));
    await waitFor(() => expect(m.calls('POST', /withdraw$/)).toHaveLength(1));
    expect(m.last('POST').body).toEqual({ reason: '안전팀 보류' });
    expect(await screen.findByText('철회됨')).toBeInTheDocument();
    expect(screen.getByText(/철회 · 안전팀 보류 — 김대리, 2026년 8월 20일/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '확인' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '정정' })).not.toBeInTheDocument();
    expect(document.querySelector('.ledger-item.withdrawn')).toBeInTheDocument();
  });

  it('정정 N회 칩 → 이력 펼치기/접기 (diff·구버전 서명)', async () => {
    m.get(`/api/meetings/${CODE}/decisions`, [entry({ revisions: 2 })]);
    m.get(`/api/meetings/${CODE}/decisions/10/0/revisions`, [
      { id: 1, kind: 'edit', prevDecision: '옛 문장', prevWhy: null, newDecision: '냉각수 온도 63도로 유지', newWhy: '65도에서 라인 알람', reason: '원문 확인', prevAcks: ['kim'], editor: 'juho', ts: T0 },
      { id: 2, kind: 'withdraw', prevDecision: null, prevWhy: null, newDecision: null, newWhy: null, reason: '보류', prevAcks: [], editor: 'kim', ts: T0 },
    ]);
    render(<DecisionLedger code={CODE} />);
    const chip = await screen.findByRole('button', { name: '정정 2회' });
    fireEvent.click(chip);
    expect(await screen.findByText(/원문 확인/)).toBeInTheDocument();
    expect(screen.getByText('옛 문장')).toBeInTheDocument();
    expect(screen.getByText('(없음)')).toBeInTheDocument();
    expect(screen.getByText(/구버전 서명 1명 \(김대리\)/)).toBeInTheDocument();
    expect(screen.getByText('철회')).toBeInTheDocument();
    fireEvent.click(chip);
    expect(screen.queryByText(/원문 확인/)).not.toBeInTheDocument();
  });

  it('변경 이력 뷰 — AI 그룹핑 타임라인, 빈 이력', async () => {
    m.get(`/api/meetings/${CODE}/decisions`, [entry()]);
    m.get(`/api/meetings/${CODE}/decisions/history`, {
      source: 'ai',
      generatedAt: T0,
      topics: [
        { title: '냉각수', entries: [
          { recapId: 9, idx: 0, decision: '65도', why: '', ts: T0 - 1000 },
          { recapId: 10, idx: 0, decision: '63도', why: '알람', ts: T0 },
        ] },
      ],
    });
    render(<DecisionLedger code={CODE} />);
    await screen.findByText('냉각수 온도 63도로 유지');
    fireEvent.click(screen.getByRole('tab', { name: '변경 이력' }));
    expect(screen.getByText('이력을 정리하는 중…')).toBeInTheDocument();
    expect(await screen.findByText('AI가 같은 주제끼리 묶었어요')).toBeInTheDocument();
    expect(screen.getByText('냉각수')).toBeInTheDocument();
    expect(screen.getByText('현재')).toBeInTheDocument();
    expect(screen.getByText('배경 · 알람')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('결정 검색')).not.toBeInTheDocument();
    // 원장으로 복귀 — 검색창 다시
    fireEvent.click(screen.getByRole('tab', { name: '원장' }));
    expect(screen.getByPlaceholderText('결정 검색')).toBeInTheDocument();
    // 이력 재진입은 캐시 (재요청 없음)
    fireEvent.click(screen.getByRole('tab', { name: '변경 이력' }));
    expect(m.calls('GET', /history$/)).toHaveLength(1);
  });

  it('이력 API 실패 → 빈 이력 안내', async () => {
    m.get(`/api/meetings/${CODE}/decisions`, []);
    m.fail('GET', `/api/meetings/${CODE}/decisions/history`, 500);
    render(<DecisionLedger code={CODE} />);
    fireEvent.click(await screen.findByRole('tab', { name: '변경 이력' }));
    expect(await screen.findByText('아직 이력으로 묶을 결정이 없어요')).toBeInTheDocument();
  });

  it('소켓 — ledger:changed(내 코드) / agent:notify(recap) 시 재조회, 다른 코드는 무시', async () => {
    m.get(`/api/meetings/${CODE}/decisions`, []);
    render(<DecisionLedger code={CODE} />);
    await waitFor(() => expect(m.calls('GET', `/api/meetings/${CODE}/decisions`)).toHaveLength(1));
    act(() => fakeSocket.trigger('ledger:changed', { code: 'ZZZZ' }));
    act(() => fakeSocket.trigger('agent:notify', { kind: 'todo', meeting: { code: CODE } }));
    await tick();
    expect(m.calls('GET', `/api/meetings/${CODE}/decisions`)).toHaveLength(1);
    act(() => fakeSocket.trigger('ledger:changed', { code: CODE }));
    act(() => fakeSocket.trigger('agent:notify', { kind: 'recap', meeting: { code: CODE } }));
    await waitFor(() => expect(m.calls('GET', `/api/meetings/${CODE}/decisions`)).toHaveLength(3));
  });

  it('exist:open-handover / exist:archive-focus 이벤트로 세그먼트 전환', async () => {
    m.get(`/api/meetings/${CODE}/decisions`, []);
    m.get(`/api/meetings/${CODE}/handovers`, []);
    m.get(`/api/meetings/${CODE}/handovers/checklist`, []);
    m.get(`/api/meetings/${CODE}/recaps`, []);
    render(<DecisionLedger code={CODE} />);
    await screen.findByText('아직 기록된 결정이 없어요');
    act(() => window.dispatchEvent(new CustomEvent('exist:open-handover')));
    expect(screen.getByText('교대 인수인계')).toBeInTheDocument();
    act(() => window.dispatchEvent(new CustomEvent('exist:archive-focus', { detail: { code: 'OTHER', recapId: 1 } })));
    expect(screen.getByText('교대 인수인계')).toBeInTheDocument();
    act(() => window.dispatchEvent(new CustomEvent('exist:archive-focus', { detail: { code: CODE, recapId: 1 } })));
    expect(within(document.querySelector('.ledger-title')!).getByText('회의 기록')).toBeInTheDocument();
  });
});
