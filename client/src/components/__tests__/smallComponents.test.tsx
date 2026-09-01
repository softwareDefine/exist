import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useNameStore } from '../../names';
import Avatar from '../Avatar';
import MeetingThumb from '../MeetingThumb';
import Marquee from '../Marquee';
import PillSeg from '../PillSeg';
import SignPad from '../SignPad';
import ErrorToasts from '../ErrorToasts';
import MentionInput from '../MentionInput';
import RecoveryCode from '../RecoveryCode';
import DatePicker from '../DatePicker';
import ColorGrid from '../ColorGrid';
import Logo from '../Logo';
import AuthShell from '../AuthShell';
import * as Icons from '../Icons';

afterEach(() => vi.useRealTimers());

describe('Avatar / MeetingThumb / Marquee / Logo / AuthShell', () => {
  it('Avatar — 이모지·이미지·AI 별', () => {
    const { container, rerender } = render(<Avatar value="🐯" className="x" />);
    expect(container.firstChild).toHaveClass('avatar', 'x');
    expect(container.textContent).toBe('🐯');
    rerender(<Avatar value="/api/uploads/a.png" />);
    expect(container.querySelector('img.avatar-photo')).toHaveAttribute('src', '/api/uploads/a.png');
    rerender(<Avatar value="https://x/y.jpg" />);
    expect(container.querySelector('img')).toBeInTheDocument();
    rerender(<Avatar value="✦" />);
    expect(container.firstChild).toHaveClass('avatar-ai');
    rerender(<Avatar value={null} />);
    expect(container.textContent).toBe('🙂');
  });

  it('MeetingThumb — 썸네일 있으면 이미지, 없으면 첫 글자 + id 기반 그라디언트', () => {
    const { container, rerender } = render(<MeetingThumb id={3} title="생산1팀" />);
    expect(container.textContent).toBe('생');
    expect((container.firstChild as HTMLElement).style.background).toContain('linear-gradient');
    rerender(<MeetingThumb id={3} title="생산1팀" thumbnail="/t.png" />);
    expect(container.querySelector('img.mthumb-img')).toHaveAttribute('src', '/t.png');
  });

  it('Marquee — 넘치지 않으면 애니메이션 없음, 넘치면 on + 거리 변수', () => {
    const { container, rerender } = render(<Marquee className="m">짧음</Marquee>);
    expect(container.querySelector('.marquee-inner')).not.toHaveClass('on');
    const inner = container.querySelector<HTMLElement>('.marquee-inner')!;
    const outer = container.querySelector<HTMLElement>('.marquee')!;
    Object.defineProperty(inner, 'scrollWidth', { configurable: true, value: 300 });
    Object.defineProperty(outer, 'clientWidth', { configurable: true, value: 100 });
    rerender(<Marquee className="m">아주 아주 긴 텍스트</Marquee>);
    expect(inner).toHaveClass('on');
    expect(inner.style.getPropertyValue('--marquee-dist')).toBe('-200px');
    expect(inner.style.animationDuration).toBe('10s');
  });

  it('Logo / AuthShell', () => {
    const { container, rerender } = render(<Logo />);
    expect(container.querySelectorAll('img')).toHaveLength(2);
    rerender(<Logo light />);
    expect(container.querySelectorAll('img')).toHaveLength(1);
    render(
      <AuthShell>
        <p>폼</p>
      </AuthShell>,
    );
    expect(screen.getByText('폼')).toBeInTheDocument();
    expect(screen.getByAltText('화상회의 일러스트')).toBeInTheDocument();
  });

  it('Icons — 모든 아이콘이 svg를 렌더', () => {
    const entries = Object.entries(Icons).filter(([, v]) => typeof v === 'function') as [string, React.FC<{ size?: number }>][];
    expect(entries.length).toBeGreaterThan(60);
    for (const [name, Icon] of entries) {
      const { container, unmount } = render(<Icon size={12} />);
      expect(container.querySelector('svg'), name).toBeInTheDocument();
      unmount();
    }
    const glyphs: Icons.FolderGlyph[] = ['log', 'gear', 'shield', 'check', 'book', 'ruler', 'people'];
    for (const g of glyphs) {
      const { container, unmount } = render(<Icons.FolderGlyphIcon glyph={g} size={12} />);
      expect(container.querySelector('svg')).toBeInTheDocument();
      unmount();
    }
  });
});

describe('PillSeg', () => {
  it('탭 역할·선택 상태·onChange', () => {
    const onChange = vi.fn();
    render(
      <PillSeg
        ariaLabel="보기"
        options={[
          { key: 'a', label: 'A' },
          { key: 'b', label: 'B' },
        ]}
        value="a"
        onChange={onChange}
      />,
    );
    expect(screen.getByRole('tablist', { name: '보기' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'A' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'B' })).toHaveAttribute('aria-selected', 'false');
    fireEvent.click(screen.getByRole('tab', { name: 'B' }));
    expect(onChange).toHaveBeenCalledWith('b');
    expect(document.querySelector('.pillseg-thumb')).toBeInTheDocument();
  });
});

describe('SignPad', () => {
  it('그리기 전엔 완료 불가, 그리면 dataURL 전달, 다시 쓰기로 초기화, 취소', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<SignPad onConfirm={onConfirm} onCancel={onCancel} title="서명해요" />);
    expect(screen.getByText('서명해요')).toBeInTheDocument();
    const done = screen.getByRole('button', { name: '서명 완료' });
    expect(done).toBeDisabled();
    const canvas = document.querySelector('canvas')!;
    fireEvent.pointerMove(canvas, { clientX: 1, clientY: 1 }); // 누르기 전 이동은 무시
    expect(done).toBeDisabled();
    fireEvent.pointerDown(canvas, { clientX: 1, clientY: 1, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    expect(done).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '다시 쓰기' }));
    expect(done).toBeDisabled();
    fireEvent.pointerDown(canvas, { clientX: 1, clientY: 1, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.click(done);
    expect(onConfirm).toHaveBeenCalledWith('data:image/png;base64,AAAA');
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('fluid — 컨테이너 폭에 맞춰 캔버스 크기', () => {
    const { container } = render(<SignPad fluid onConfirm={() => {}} onCancel={() => {}} />);
    const canvas = container.querySelector('canvas')!;
    expect(container.firstChild).toHaveClass('fluid');
    expect(canvas.style.height).toBe('140px');
  });
});

describe('ErrorToasts', () => {
  it('app:error/app:info 수신, 중복 억제, 최대 3개, 6초 후 사라짐', () => {
    vi.useFakeTimers();
    render(<ErrorToasts />);
    expect(document.querySelector('.error-toast-stack')).toBeNull();
    act(() => {
      window.dispatchEvent(new CustomEvent('app:error', { detail: '실패 1' }));
      window.dispatchEvent(new CustomEvent('app:error', { detail: '실패 1' }));
      window.dispatchEvent(new CustomEvent('app:info', { detail: '안내' }));
    });
    expect(screen.getAllByText('실패 1')).toHaveLength(1);
    expect(screen.getByText('안내').closest('.error-toast')).toHaveClass('info');
    act(() => {
      window.dispatchEvent(new CustomEvent('app:error', { detail: '실패 2' }));
      window.dispatchEvent(new CustomEvent('app:error', { detail: '실패 3' }));
    });
    expect(document.querySelectorAll('.error-toast')).toHaveLength(3);
    expect(screen.queryByText('실패 1')).not.toBeInTheDocument(); // 오래된 것부터 밀림
    act(() => vi.advanceTimersByTime(6100));
    expect(document.querySelector('.error-toast-stack')).toBeNull();
  });
});

describe('MentionInput', () => {
  const cands = [
    { username: 'AI', avatar: '✦', sub: 'AI 총무' },
    { username: 'kim', avatar: null, sub: '대리 · 생산' },
    { username: 'lee', avatar: null },
  ];
  /** pick()은 requestAnimationFrame 뒤에 캐럿을 멘션 뒤로 옮긴다 — 그 전에 타이핑하면 캐럿 위치가 환경마다
   *  달라 "@lee A@"처럼 꼬인다(CI 실패, 로컬은 통과). 캐럿이 정착한 뒤 끝 위치를 명시하고 입력 */
  async function caretSettled(input: HTMLInputElement) {
    await waitFor(() => expect(input.selectionStart).toBe(input.value.length));
    return { initialSelectionStart: input.value.length, initialSelectionEnd: input.value.length };
  }

  function Harness({ initial = '' }: { initial?: string }) {
    const [v, setV] = useState(initial);
    return <MentionInput value={v} onChange={setV} candidates={cands} placeholder="입력" />;
  }

  it('@토큰 → 후보 팝업(표시 이름 매칭) → Enter로 삽입, Esc로 닫기', async () => {
    useNameStore.setState({ map: { kim: '김대리' } });
    render(<Harness />);
    const input = screen.getByPlaceholderText('입력') as HTMLInputElement;
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await userEvent.type(input, '안녕 @김');
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());
    expect(screen.getByRole('option', { name: /김대리/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('대리 · 생산')).toBeInTheDocument();
    await userEvent.keyboard('{Enter}');
    expect(input.value).toBe('안녕 @kim ');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await userEvent.type(input, '@', await caretSettled(input));
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{ArrowUp}{ArrowUp}');
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('클릭(mousedown)으로 선택, Tab으로도 확정, blur로 닫힘', async () => {
    render(<Harness />);
    const input = screen.getByPlaceholderText('입력') as HTMLInputElement;
    await userEvent.type(input, '@l');
    const opt = await screen.findByRole('option', { name: /lee/ });
    fireEvent.mouseEnter(opt);
    fireEvent.mouseDown(opt);
    expect(input.value).toBe('@lee ');
    await userEvent.type(input, '@A', await caretSettled(input));
    await screen.findByRole('option', { name: /AI/ });
    await userEvent.keyboard('{Tab}');
    expect(input.value).toBe('@lee @AI ');
    await userEvent.type(input, '@k', await caretSettled(input));
    await screen.findByRole('listbox');
    fireEvent.blur(input);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});

describe('RecoveryCode', () => {
  it('코드 표시 + 복사 → "복사됨" 2초', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<RecoveryCode code="AAAA-BBBB" />);
    expect(screen.getByText('AAAA-BBBB')).toHaveClass('recovery-box');
    fireEvent.click(screen.getByRole('button', { name: '복사하기' }));
    await waitFor(() => expect(screen.getByText('복사됨')).toBeInTheDocument());
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('AAAA-BBBB');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(screen.getByRole('button', { name: '복사하기' })).toBeInTheDocument();
  });
});

describe('DatePicker', () => {
  it('열기 → 월 이동 → 날짜 선택(YYYY-MM-DD) → 지우기, min 이전은 비활성', () => {
    const onChange = vi.fn();
    const first = render(<DatePicker value={null} onChange={onChange} />);
    expect(screen.getByText('날짜 선택')).toBeInTheDocument();
    fireEvent.click(screen.getByText('날짜 선택'));
    const now = new Date();
    const y = now.getFullYear();
    const mo = now.getMonth();
    expect(screen.getByText(`${y}년 ${mo + 1}월`)).toBeInTheDocument();
    // 다음 달로 이동 후 다시 돌아오기
    const [prev, next] = document.querySelectorAll('.datepick-head button');
    fireEvent.click(next);
    const nm = new Date(y, mo + 1, 1);
    expect(screen.getByText(`${nm.getFullYear()}년 ${nm.getMonth() + 1}월`)).toBeInTheDocument();
    fireEvent.click(prev);
    expect(screen.getByText(`${y}년 ${mo + 1}월`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: String(now.getDate()) })).toHaveClass('today');
    first.unmount();
    // 값이 있으면 그 달로 열린다
    render(<DatePicker value="2026-08-20" onChange={onChange} min="2026-08-10" />);
    expect(screen.getByText('2026. 08. 20')).toBeInTheDocument();
    fireEvent.click(screen.getByText('2026. 08. 20'));
    fireEvent.click(screen.getByText('2026. 08. 20')); // 토글 닫힘
    fireEvent.click(screen.getByText('2026. 08. 20'));
    expect(screen.getByText('2026년 8월')).toBeInTheDocument();
    const day5 = screen.getByRole('button', { name: '5' });
    expect(day5).toBeDisabled();
    expect(day5).toHaveClass('disabled');
    expect(screen.getByRole('button', { name: '20' })).toHaveClass('sel');
    fireEvent.click(screen.getByRole('button', { name: '25' }));
    expect(onChange).toHaveBeenCalledWith('2026-08-25');
    expect(screen.queryByText('2026년 8월')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('2026. 08. 20'));
    fireEvent.click(screen.getByRole('button', { name: '지우기' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
    // 배경 클릭으로 닫기
    fireEvent.click(screen.getByText('2026. 08. 20'));
    fireEvent.click(document.querySelector('.datepick-back')!);
    expect(screen.queryByText('2026년 8월')).not.toBeInTheDocument();
  });
});

describe('ColorGrid', () => {
  it('기본색 11 + 변형 5단, 선택 강조, 없음 버튼', () => {
    const onPick = vi.fn();
    const { container } = render(<ColorGrid value="#E5484D" onPick={onPick} noneLabel="기본" />);
    expect(container.querySelectorAll('.cgrid-cell')).toHaveLength(11 * 6);
    expect(container.querySelector('.cgrid-cell.on')).toHaveAttribute('title', '#e5484d');
    fireEvent.click(container.querySelector('.cgrid-cell')!);
    expect(onPick).toHaveBeenCalledWith('#ffffff');
    fireEvent.click(screen.getByText(/기본/));
    expect(onPick).toHaveBeenLastCalledWith('');
    // 변형색은 유효한 hex
    for (const cell of container.querySelectorAll('.cgrid-cell')) {
      expect(cell.getAttribute('title')).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
