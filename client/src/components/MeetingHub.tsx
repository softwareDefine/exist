import { Fragment, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { getSocket, request } from '../lib/socket';
import { usePresence } from '../lib/usePresence';
import { useAuthStore } from '../store';
import MeetingView, { type ChatMessage } from './MeetingView';
import CanvasBoard from './CanvasBoard';
import CodeDocEditor from './CodeDocEditor';
import DocEditor from './DocEditor';
import SheetEditor from './SheetEditor';
import SlideEditor from './SlideEditor';
import Avatar from './Avatar';
import MeetingThumb from './MeetingThumb';
import MeetingSchedule from './MeetingSchedule';
import { togglePin, isPinned, PINS_EVENT } from '../lib/pins';
import {
  PhoneIcon,
  CalendarIcon,
  ChatIcon,
  GridIcon,
  PenIcon,
  CodeIcon,
  DocIcon,
  SheetIcon,
  SlideIcon,
  UsersIcon,
  GearIcon,
  CopyIcon,
  CheckIcon,
  CheckMarkIcon,
  PinIcon,
} from './Icons';

interface Participant {
  username: string;
  avatar: string | null;
  role: 'owner' | 'admin' | 'member' | null;
  position: string | null;
  department: string | null;
  isHost?: boolean;
}

interface MeetingSettings {
  locked: boolean;
  guestEdit: boolean;
  muteOnJoin: boolean;
}

interface MeetingDetail {
  id: number;
  code: string;
  title: string;
  starts_at: string | null;
  ends_at: string | null;
  recur?: string | null;
  recur_until?: string | null;
  recur_except?: string[];
  host: string;
  isHost: boolean;
  orgId: number | null;
  orgName: string | null;
  thumbnail: string | null;
  online: number;
  settings?: MeetingSettings;
  period?: { start: string | null; end: string | null } | null;
  participants: Participant[];
  callPeers: string[];
}

function formatRange(starts: string | null, ends: string | null): string | null {
  if (!starts) return null;
  const s = new Date(starts);
  const fmt = (d: Date) => {
    const ampm = d.getHours() < 12 ? '오전' : '오후';
    const h = d.getHours() % 12 || 12;
    return `${d.getMonth() + 1}/${d.getDate()} ${ampm} ${h}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  if (!ends) return fmt(s);
  const e = new Date(ends);
  return `${fmt(s)} ~ ${fmt(e)}`;
}

/** 참가자를 부서별로 묶기 — 부서 있는 그룹 먼저(가나다), 미지정은 마지막 */
function groupByDept(people: Participant[]): { dept: string | null; people: Participant[] }[] {
  const map = new Map<string | null, Participant[]>();
  for (const p of people) {
    const key = p.department || null;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(p);
  }
  return [...map.entries()]
    .map(([dept, people]) => ({ dept, people }))
    .sort((a, b) => {
      if (a.dept === null) return 1;
      if (b.dept === null) return -1;
      return a.dept.localeCompare(b.dept, 'ko');
    });
}

/** 일정 진행 상태 뱃지 */
function scheduleState(
  starts: string | null,
  ends: string | null,
): { label: string; cls: string } | null {
  if (!starts) return null;
  const now = Date.now();
  const s = new Date(starts).getTime();
  const e = ends ? new Date(ends).getTime() : null;
  if (now < s) {
    const min = Math.round((s - now) / 60_000);
    if (min < 60) return { label: `${min}분 후 시작`, cls: 'soon' };
    const h = Math.round(min / 60);
    if (h < 24) return { label: `${h}시간 후 시작`, cls: '' };
    return { label: `${Math.round(h / 24)}일 후 시작`, cls: '' };
  }
  if (e && now >= e) return { label: '종료됨', cls: 'done' };
  return { label: '진행 중', cls: 'live' };
}

interface MeetingTodo {
  id: number;
  title: string;
  done: number;
  author?: string;
}

function dday(endDate: string): number | null {
  const end = new Date(endDate + 'T00:00:00');
  if (isNaN(end.getTime())) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((end.getTime() - today.getTime()) / 86400000);
}
function formatBytes(n: number): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}
function chatTime(ts: number): string {
  const d = new Date(ts);
  const ampm = d.getHours() < 12 ? '오전' : '오후';
  const h = d.getHours() % 12 || 12;
  return `${ampm} ${h}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function chatDateLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  if (d.toDateString() === now.toDateString()) return '오늘';
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return '어제';
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${days[d.getDay()]})`;
}

type SubTab =
  | 'dash'
  | 'call'
  | 'chat'
  | 'canvas'
  | 'code'
  | 'doc'
  | 'sheet'
  | 'slide'
  | 'schedule'
  | 'settings';

interface Props {
  code: string;
  /** 통화 확대 상태 (오버레이) */
  expanded?: boolean;
  onToggleExpand?: () => void;
  /** 열 때 이동할 세부 탭 (최근회의 버튼 등) */
  gotoTab?: { tab: string; ts: number };
}

/** PiP 한 칸(영상 패널) 기준 크기 — 16:9. 리사이즈는 이 단위로 스냅된다 */
const PIP_TILE_W = 320;
const PIP_TILE_H = 180;

/** 회의 탭 = 대시보드(메인) + 통화/채팅 서브탭 */
export default function MeetingHub({ code, expanded, onToggleExpand, gotoTab }: Props) {
  const user = useAuthStore((s) => s.user);
  const presence = usePresence();
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [subtab, setSubtab] = useState<SubTab>('dash');
  const [inCall, setInCall] = useState(false);
  const [copied, setCopied] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [uploadingFile, setUploadingFile] = useState(false);
  const chatFileRef = useRef<HTMLInputElement>(null);
  const [canvasMounted, setCanvasMounted] = useState(false); // 한 번 열면 유지 (재연결·카메라 초기화 방지)
  const [codeMounted, setCodeMounted] = useState(false); // 코드 편집기도 한 번 열면 유지
  const [docMounted, setDocMounted] = useState(false); // 문서 편집기도 한 번 열면 유지
  const [sheetMounted, setSheetMounted] = useState(false); // 시트 편집기도 한 번 열면 유지
  const [slideMounted, setSlideMounted] = useState(false); // 슬라이드도 한 번 열면 유지
  const [pipPos, setPipPos] = useState<{ x: number; y: number } | null>(null); // 무빙 통화창 위치
  const [pipW, setPipW] = useState<number>(() => {
    const s = Number(localStorage.getItem('exist:pipW'));
    return s >= PIP_TILE_W && s <= PIP_TILE_W * 4 ? s : PIP_TILE_W; // 기본 1칸(320)
  });
  const [pipH, setPipH] = useState<number>(() => {
    const s = Number(localStorage.getItem('exist:pipH'));
    return s >= PIP_TILE_H && s <= PIP_TILE_H * 3 ? s : PIP_TILE_H;
  });
  const pipDragRef = useRef<{ dx: number; dy: number } | null>(null);
  const pipResizeRef = useRef<{ right: number; bottom: number } | null>(null); // 리사이즈 앵커(우하단 고정)
  const pipElRef = useRef<HTMLElement | null>(null); // 드래그/리사이즈 중 직접 조작할 PiP 엘리먼트
  const pipRafRef = useRef<number | null>(null);
  const pipLatest = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const pipSizeLatest = useRef<{ w: number; h: number }>({ w: 320, h: 180 });
  const onlineRef = useRef<number>(1); // 통화 인원 — 리사이즈 캡(다 들어가면 그만)용
  const [todos, setTodos] = useState<MeetingTodo[]>([]);
  const [todoInput, setTodoInput] = useState('');
  const [confirmDelMeeting, setConfirmDelMeeting] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [pinnedNow, setPinnedNow] = useState(false);

  // 사이드바 고정 상태 동기화 (다른 곳에서 토글돼도 반영)
  useEffect(() => {
    if (!detail) return;
    const sync = () => setPinnedNow(isPinned(detail.id));
    sync();
    window.addEventListener(PINS_EVENT, sync);
    return () => window.removeEventListener(PINS_EVENT, sync);
  }, [detail]);

  // 회의 공유 할 일 로드
  useEffect(() => {
    let alive = true;
    void api<MeetingTodo[]>(`/api/todos?meeting=${code}`)
      .then((list) => {
        if (alive) setTodos(list);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [code]);

  async function reloadTodos() {
    try {
      setTodos(await api<MeetingTodo[]>(`/api/todos?meeting=${code}`));
    } catch {
      /* 무시 */
    }
    // nowbar가 이 회의 할 일을 띄우고 있으면 같이 갱신
    window.dispatchEvent(new CustomEvent('exist:todos-changed', { detail: { code } }));
  }
  async function addTodo(e: React.FormEvent) {
    e.preventDefault();
    if (!todoInput.trim()) return;
    await api('/api/todos', { method: 'POST', body: { title: todoInput, meeting: code } });
    setTodoInput('');
    void reloadTodos();
  }
  async function toggleTodo(t: MeetingTodo) {
    await api(`/api/todos/${t.id}`, { method: 'PATCH', body: { done: !t.done } });
    void reloadTodos();
  }
  async function deleteTodo(t: MeetingTodo) {
    await api(`/api/todos/${t.id}`, { method: 'DELETE' });
    void reloadTodos();
  }

  useEffect(() => {
    if (subtab === 'canvas') setCanvasMounted(true);
    if (subtab === 'code') setCodeMounted(true);
    if (subtab === 'doc') setDocMounted(true);
    if (subtab === 'sheet') setSheetMounted(true);
    if (subtab === 'slide') setSlideMounted(true);
  }, [subtab]);

  // 최근회의 버튼 등에서 세부 탭 지정 → 해당 탭으로 이동
  useEffect(() => {
    if (gotoTab?.tab) setSubtab(gotoTab.tab as SubTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gotoTab?.ts]);

  // 강퇴 알림 — 이 회의에서 내보내지면 안내
  useEffect(() => {
    const socket = getSocket();
    const onKicked = (data: { code: string }) => {
      if (data.code?.toUpperCase() === code.toUpperCase()) {
        window.dispatchEvent(
          new CustomEvent('app:error', { detail: '그룹에서 내보내졌어요.' }),
        );
      }
    };
    socket.on('meeting:kicked', onKicked);
    return () => {
      socket.off('meeting:kicked', onKicked);
    };
  }, [code]);

  // 무빙 통화창 드래그·리사이즈 — 리렌더 없이 DOM 직접 조작(+rAF), 상태는 놓을 때 1회만 커밋
  useEffect(() => {
    function onMove(e: MouseEvent) {
      const el = pipElRef.current;
      if (!el) return;

      // 리사이즈 (우하단 앵커 고정) — 한 화면(16:9 패널) 단위로 딱딱 스냅
      const a = pipResizeRef.current;
      if (a) {
        const N = onlineRef.current; // 통화 인원 — 다 들어가면 더 못 키움
        const maxCols = Math.max(1, Math.min(4, Math.floor((a.right - 6) / PIP_TILE_W)));
        const maxRows = Math.max(1, Math.min(4, Math.floor((a.bottom - 6) / PIP_TILE_H)));
        let cols = Math.max(1, Math.min(maxCols, Math.round((a.right - e.clientX) / PIP_TILE_W)));
        let rows = Math.max(1, Math.min(maxRows, Math.round((a.bottom - e.clientY) / PIP_TILE_H)));
        // 빈 열·행이 생기지 않게 — 모든 참가자가 들어갈 최소 격자까지만 허용
        cols = Math.min(cols, Math.ceil(N / rows));
        rows = Math.min(rows, Math.ceil(N / cols));
        cols = Math.min(cols, Math.ceil(N / rows));
        const w = cols * PIP_TILE_W;
        const h = rows * PIP_TILE_H;
        const left = a.right - w;
        const top = a.bottom - h;
        pipSizeLatest.current = { w, h };
        pipLatest.current = { x: left, y: top };
        if (pipRafRef.current == null) {
          pipRafRef.current = requestAnimationFrame(() => {
            pipRafRef.current = null;
            el.style.width = `${w}px`;
            el.style.height = `${h}px`;
            el.style.left = `${left}px`;
            el.style.top = `${top}px`;
            el.style.right = 'auto';
            el.style.bottom = 'auto';
            el.style.setProperty('--pip-cols', String(cols));
          });
        }
        return;
      }

      // 위치 이동
      const d = pipDragRef.current;
      if (!d) return;
      const w = el.offsetWidth || 90;
      const h = el.offsetHeight || 60;
      const x = Math.max(6, Math.min(window.innerWidth - w - 6, e.clientX - d.dx));
      const y = Math.max(6, Math.min(window.innerHeight - h - 6, e.clientY - d.dy));
      pipLatest.current = { x, y };
      if (pipRafRef.current == null) {
        pipRafRef.current = requestAnimationFrame(() => {
          pipRafRef.current = null;
          const p = pipLatest.current;
          el.style.left = `${p.x}px`;
          el.style.top = `${p.y}px`;
        });
      }
    }
    function onUp() {
      if (pipRafRef.current != null) {
        cancelAnimationFrame(pipRafRef.current);
        pipRafRef.current = null;
      }
      if (pipResizeRef.current) {
        pipResizeRef.current = null;
        document.body.style.userSelect = '';
        const { w, h } = pipSizeLatest.current;
        setPipW(w);
        setPipH(h);
        setPipPos({ ...pipLatest.current });
        localStorage.setItem('exist:pipW', String(w));
        localStorage.setItem('exist:pipH', String(h));
        return;
      }
      if (pipDragRef.current) {
        pipDragRef.current = null;
        document.body.style.userSelect = '';
        setPipPos({ ...pipLatest.current }); // 최종 위치만 상태로 커밋
      }
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (pipRafRef.current != null) cancelAnimationFrame(pipRafRef.current);
    };
  }, []);

  // 통화 인원을 ref로 추적 (리사이즈 핸들러가 최신 값을 보도록)
  useEffect(() => {
    onlineRef.current = Math.max(1, detail?.online ?? 1);
  }, [detail?.online]);

  function startPipDrag(e: React.MouseEvent) {
    const t = e.target as HTMLElement;
    // 컨트롤·버튼·리사이즈 핸들 위에선 이동 드래그 시작 안 함
    if (t.closest('button') || t.closest('.meeting-controls') || t.closest('.hub-pip-resize')) return;
    const el = (e.currentTarget as HTMLElement).closest('.hub-call') as HTMLElement | null;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    pipElRef.current = el;
    pipDragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    pipLatest.current = { x: rect.left, y: rect.top };
    // 좌표 기준으로 즉시 고정 (right/bottom 해제) — 이후 이동은 직접 조작
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.top}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  }

  function startPipResize(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const el = (e.currentTarget as HTMLElement).closest('.hub-call') as HTMLElement | null;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    pipElRef.current = el;
    pipResizeRef.current = { right: rect.right, bottom: rect.bottom }; // 우하단 고정점
    pipSizeLatest.current = { w: rect.width, h: rect.height };
    pipLatest.current = { x: rect.left, y: rect.top };
    document.body.style.userSelect = 'none';
  }

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, subtab]);

  // 상세 + 현재 통화 인원 (10초 폴링)
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const d = await api<MeetingDetail>(`/api/meetings/${code}`);
        if (alive) {
          setDetail(d);
          // 회의 탭 제목 옆 조직 배지 + 조직별 탭 필터용 (WorkspacePanel 수신)
          window.dispatchEvent(
            new CustomEvent('meeting:org', {
              detail: { code: code.toUpperCase(), orgId: d.orgId, orgName: d.orgName },
            }),
          );
        }
      } catch {
        /* 전역 토스트 */
      }
    }
    void load();
    const t = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [code]);

  // 회의 채팅 — 통화 여부 무관 구독 (inCall 변동 시 소켓 재생성 대응 위해 재구독)
  useEffect(() => {
    let alive = true;
    const socket = getSocket();

    function join() {
      // 재연결 시 놓친 메시지까지 복구 (히스토리 재로드 + 룸 재가입)
      void api<ChatMessage[]>(`/api/meetings/${code}/messages`).then((history) => {
        if (alive) setMessages(history);
      });
      void request(socket, 'chat:join', { code }).catch(() => {});
    }
    join();
    // 서버 재시작/네트워크 단절 후 socket.io가 자동 재연결되면 룸 멤버십이
    // 사라지므로 다시 join해야 메시지를 계속 받는다
    socket.on('connect', join);

    function onMessage(msg: ChatMessage) {
      if (msg.code && msg.code !== code.toUpperCase()) return;
      setMessages((prev) => [...prev, msg]);
      // 회의 탭 안읽음 배지용 (WorkspacePanel이 수신)
      window.dispatchEvent(new CustomEvent('meeting:message', { detail: { code: code.toUpperCase() } }));
    }
    socket.on('chat:message', onMessage);
    return () => {
      alive = false;
      socket.off('connect', join);
      socket.off('chat:message', onMessage);
    };
  }, [code, inCall]);

  function sendChat(e: React.FormEvent) {
    e.preventDefault();
    if (!chatInput.trim()) return;
    getSocket().emit('chat:send', { code, text: chatInput });
    setChatInput('');
  }

  async function reloadDetail() {
    try {
      const d = await api<MeetingDetail>(`/api/meetings/${code}`);
      setDetail(d);
    } catch {
      /* 무시 */
    }
  }
  async function kickParticipant(username: string) {
    if (!confirm(`${username} 님을 그룹에서 내보낼까요?`)) return;
    try {
      await api(`/api/meetings/${code}/participants/${encodeURIComponent(username)}`, {
        method: 'DELETE',
      });
      void reloadDetail();
    } catch {
      /* 전역 토스트 */
    }
  }
  async function transferHost(username: string) {
    if (!confirm(`${username} 님에게 호스트를 위임할까요?`)) return;
    try {
      await api(`/api/meetings/${code}/host`, { method: 'PATCH', body: { username } });
      void reloadDetail();
    } catch {
      /* 전역 토스트 */
    }
  }
  async function deleteMeeting() {
    if (!confirmDelMeeting) {
      setConfirmDelMeeting(true);
      return;
    }
    try {
      await api(`/api/meetings/${code}`, { method: 'DELETE' });
      // 대시보드·nowbar 갱신 + 열린 탭 닫기 (WorkspacePanel이 수신)
      window.dispatchEvent(new CustomEvent('exist:schedule-changed'));
      window.dispatchEvent(new CustomEvent('exist:meeting-deleted', { detail: { code } }));
    } catch {
      setConfirmDelMeeting(false);
    }
  }
  async function updateSettings(patch: Partial<MeetingSettings>) {
    const cur = detail?.settings ?? { locked: false, guestEdit: true, muteOnJoin: false };
    try {
      await api(`/api/meetings/${code}/settings`, { method: 'PATCH', body: { ...cur, ...patch } });
      void reloadDetail();
    } catch {
      /* 전역 토스트 */
    }
  }
  async function sendChatFile(file: File) {
    if (!file || uploadingFile) return;
    setUploadingFile(true);
    try {
      const token = useAuthStore.getState().token;
      const res = await fetch(`/api/workspaces/uploads?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: file,
      });
      const { url } = (await res.json()) as { url: string };
      getSocket().emit('chat:send', {
        code,
        text: '',
        file: { name: file.name, url, size: file.size },
      });
    } catch {
      window.dispatchEvent(new CustomEvent('app:error', { detail: '파일 업로드 실패' }));
    } finally {
      setUploadingFile(false);
    }
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* 수동 복사 */
    }
  }

  function joinCall() {
    // 통화 탭으로 이동 → MeetingView가 프리뷰(디바이스 확인)부터 띄움.
    // 실제 통화 시작(inCall)은 프리뷰의 '입장하기' → onJoined에서 처리.
    setSubtab('call');
  }

  const range = detail ? formatRange(detail.starts_at, detail.ends_at) : null;

  return (
    <div className="meeting-hub">
      {/* 서브탭 — 대시보드가 메인 */}
      <div className="hub-tabs">
        <button
          className={`hub-tab${subtab === 'dash' ? ' active' : ''}`}
          onClick={() => setSubtab('dash')}
        >
          <GridIcon size={14} /> 대시보드
        </button>
        <button
          className={`hub-tab${subtab === 'schedule' ? ' active' : ''}`}
          onClick={() => setSubtab('schedule')}
        >
          <CalendarIcon size={13} /> 일정
        </button>
        <button
          className={`hub-tab${subtab === 'call' ? ' active' : ''}`}
          onClick={() => setSubtab('call')}
        >
          <PhoneIcon size={13} /> 통화
          {inCall && <i className="live-dot" />}
          {(detail?.online ?? 0) > 0 && <span className="hub-tab-count">{detail!.online}</span>}
        </button>
        <button
          className={`hub-tab${subtab === 'chat' ? ' active' : ''}`}
          onClick={() => setSubtab('chat')}
        >
          <ChatIcon size={13} /> 채팅
        </button>
        <button
          className={`hub-tab${subtab === 'canvas' ? ' active' : ''}`}
          onClick={() => setSubtab('canvas')}
        >
          <PenIcon size={13} /> 캔버스
        </button>
        <button
          className={`hub-tab${subtab === 'code' ? ' active' : ''}`}
          onClick={() => setSubtab('code')}
        >
          <CodeIcon size={14} /> 코드
        </button>
        <button
          className={`hub-tab${subtab === 'doc' ? ' active' : ''}`}
          onClick={() => setSubtab('doc')}
        >
          <DocIcon size={14} /> 문서
        </button>
        <button
          className={`hub-tab${subtab === 'sheet' ? ' active' : ''}`}
          onClick={() => setSubtab('sheet')}
        >
          <SheetIcon size={14} /> 시트
        </button>
        <button
          className={`hub-tab${subtab === 'slide' ? ' active' : ''}`}
          onClick={() => setSubtab('slide')}
        >
          <SlideIcon size={14} /> 발표
        </button>
        <button
          className={`hub-tab${subtab === 'settings' ? ' active' : ''}`}
          onClick={() => setSubtab('settings')}
        >
          <GearIcon size={14} /> 설정
        </button>
      </div>

      <div className="hub-body">
        {/* 대시보드 (메인) */}
        {subtab === 'dash' && (
          <div className="hub-dash">
            {!detail ? (
              <div className="hub-loading">그룹 정보를 불러오는 중…</div>
            ) : (
              <>
                {/* HERO — 회의 정보 + 통화 CTA 통합 */}
                <section className="hub-hero">
                  <MeetingThumb
                    id={detail.id}
                    title={detail.title}
                    thumbnail={detail.thumbnail}
                    className="hub-hero-thumb"
                  />
                  <div className="hub-hero-main">
                    <h2 className="hub-hero-title">{detail.title}</h2>
                    <div className="hub-hero-sub">
                      호스트 <b>{detail.host}</b>
                      {detail.isHost && ' (나)'}
                      {detail.orgName && <span className="hub-sub-org"> · {detail.orgName}</span>}
                    </div>
                    <div className="hub-hero-chips">
                      <button className="hub-hero-code" onClick={copyCode} title="클릭해서 복사">
                        {detail.code}{' '}
                        {copied ? <CheckMarkIcon size={13} /> : <CopyIcon size={13} />}
                      </button>
                      {range && (
                        <span className="hub-hero-when">
                          <CalendarIcon size={13} /> {range}
                        </span>
                      )}
                      {detail.period && (
                        <span className="hub-hero-when">
                          <CalendarIcon size={13} /> 기간 {detail.period.start ?? '?'} ~{' '}
                          {detail.period.end ?? '?'}
                          {detail.period.end &&
                            (() => {
                              const d = dday(detail.period.end);
                              return d != null ? (
                                <b className="hub-hero-dday">
                                  {d > 0 ? `D-${d}` : d === 0 ? 'D-DAY' : `D+${-d}`}
                                </b>
                              ) : null;
                            })()}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="hub-hero-cta">
                    {detail.online > 0 ? (
                      <span className="hub-live">
                        <i className="live-dot" /> {detail.online}명 통화 중
                      </span>
                    ) : (
                      <span className="hub-hero-idle">대기 중</span>
                    )}
                    <button className="hub-join lg" onClick={joinCall}>
                      <PhoneIcon size={18} /> {inCall ? '통화로 돌아가기' : '통화 참여'}
                    </button>
                  </div>
                </section>

                {/* 본문: 메인 + 사이드 (Teams식 2단) */}
                <div className="hub-dash-cols">
                  <div className="hub-dash-main">
                    {/* 협업 공간 앱 런처 */}
                    <section className="hub-section hub-apps-card">
                      <div className="hub-section-title">
                        <GridIcon size={15} /> 협업 공간
                      </div>
                      <div className="hub-apps">
                        <button className="hub-app" onClick={() => setSubtab('canvas')}>
                          <span className="hub-app-ic canvas">
                            <PenIcon size={20} />
                          </span>
                          캔버스
                        </button>
                        <button className="hub-app" onClick={() => setSubtab('code')}>
                          <span className="hub-app-ic code">
                            <CodeIcon size={20} />
                          </span>
                          코드
                        </button>
                        <button className="hub-app" onClick={() => setSubtab('doc')}>
                          <span className="hub-app-ic doc">
                            <DocIcon size={20} />
                          </span>
                          문서
                        </button>
                        <button className="hub-app" onClick={() => setSubtab('sheet')}>
                          <span className="hub-app-ic sheet">
                            <SheetIcon size={20} />
                          </span>
                          시트
                        </button>
                        <button className="hub-app" onClick={() => setSubtab('slide')}>
                          <span className="hub-app-ic slide">
                            <SlideIcon size={20} />
                          </span>
                          발표
                        </button>
                      </div>
                    </section>

                {/* 일정 (메인으로 이동) */}
                <section className="hub-section">
                  <div className="hub-section-title">
                    <CalendarIcon size={15} /> 일정
                  </div>
                  {range ? (
                    <>
                      <div className="hub-sched-time">{range}</div>
                      {(() => {
                        const st = scheduleState(detail.starts_at, detail.ends_at);
                        return st ? (
                          <span className={`hub-sched-badge ${st.cls}`}>{st.label}</span>
                        ) : null;
                      })()}
                    </>
                  ) : (
                    <div className="hub-section-empty">아직 일정이 정해지지 않았어요</div>
                  )}
                </section>

                {/* 6. 최근 채팅 */}
                <section className="hub-section">
                  <div className="hub-section-title">
                    <ChatIcon size={15} /> 최근 채팅
                    {messages.length > 0 && (
                      <button className="hub-preview-more" onClick={() => setSubtab('chat')}>
                        더 보기 ›
                      </button>
                    )}
                  </div>
                  {messages.length > 0 ? (
                    <div className="hub-preview">
                      {messages.slice(-3).map((m, i) => (
                        <div key={i} className="hub-preview-msg">
                          <b>{m.from}</b> {m.text}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="hub-section-empty">아직 대화가 없어요</div>
                  )}
                </section>

                  </div>

                  <aside className="hub-dash-side">
                    {/* 할 일 (사이드로 이동) */}
                    <section className="hub-section">
                      <div className="hub-section-title">
                        <CheckIcon size={15} /> 할 일
                        {todos.length > 0 && (
                          <span className="hub-todo-count">
                            {todos.filter((t) => t.done).length}/{todos.length}
                          </span>
                        )}
                      </div>
                      {todos.length > 0 &&
                        (() => {
                          const done = todos.filter((t) => t.done).length;
                          const pct = Math.round((done / todos.length) * 100);
                          return (
                            <div className="hub-todo-progress">
                              <div className="hub-todo-bar">
                                <div className="hub-todo-bar-fill" style={{ width: `${pct}%` }} />
                              </div>
                              <span className="hub-todo-pct">{pct}%</span>
                            </div>
                          );
                        })()}
                      <div className="hub-todos">
                        {[...todos]
                          .sort((a, b) => a.done - b.done)
                          .map((t) => (
                            <div key={t.id} className={`hub-todo${t.done ? ' done' : ''}`}>
                              <label className="hub-todo-label">
                                <input
                                  type="checkbox"
                                  checked={!!t.done}
                                  onChange={() => void toggleTodo(t)}
                                />
                                <span className="hub-todo-check" aria-hidden>
                                  <CheckMarkIcon size={16} />
                                </span>
                                <span className="hub-todo-text">{t.title}</span>
                              </label>
                              {t.author && <span className="hub-todo-author">{t.author}</span>}
                              <button
                                className="hub-todo-del"
                                onClick={() => void deleteTodo(t)}
                                title="삭제"
                              >
                                ×
                              </button>
                            </div>
                          ))}
                        {todos.length === 0 && (
                          <div className="hub-section-empty">함께 할 일을 추가해보세요</div>
                        )}
                      </div>
                      <form className="hub-todo-add" onSubmit={addTodo}>
                        <input
                          value={todoInput}
                          onChange={(e) => setTodoInput(e.target.value)}
                          placeholder="할 일 추가"
                        />
                        <button type="submit">추가</button>
                      </form>
                    </section>

                    {/* 참가자 — 조직 회의면 부서별 명함 */}
                    <section className="hub-section">
                      <div className="hub-section-title">
                        <UsersIcon size={15} /> 참가자 <b>{detail.participants.length}</b>
                        {detail.orgName && <span className="hub-roster-org">· {detail.orgName}</span>}
                      </div>
                      <div className="hub-roster">
                        {groupByDept(detail.participants).map((group) => (
                          <div key={group.dept ?? '__none'} className="hub-dept">
                            {group.dept && <div className="hub-dept-name">{group.dept}</div>}
                            <div className="hub-cards">
                              {group.people.map((p) => (
                                <div
                                  key={p.username}
                                  className={`hub-pcard${presence.has(p.username) ? ' online' : ''}`}
                                >
                                  <Avatar value={p.avatar} className="hub-pcard-avatar" />
                                  <span className="hub-pcard-info">
                                    <span className="hub-pcard-name">
                                      {p.username}
                                      {p.role === 'owner' && (
                                        <span className="hub-pcard-badge">소유자</span>
                                      )}
                                      {p.role === 'admin' && (
                                        <span className="hub-pcard-badge admin">관리자</span>
                                      )}
                                    </span>
                                    <span className="hub-pcard-sub">
                                      {p.position && <b className="hub-pcard-pos">{p.position}</b>}
                                      {p.position && (p.department || detail.orgName) && ' · '}
                                      {p.department || (detail.orgName ? '부서 미지정' : '')}
                                      {p.username === detail.host && (
                                        <span className="hub-pcard-host"> · 호스트</span>
                                      )}
                                    </span>
                                  </span>
                                  <i
                                    className="presence-dot"
                                    title={presence.has(p.username) ? '접속 중' : '오프라인'}
                                  />
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  </aside>
                </div>
              </>
            )}
          </div>
        )}

        {/* 일정 서브탭 — 달력으로 회의 일정 관리 */}
        {subtab === 'schedule' && detail && (
          <div className="hub-schedule">
            <MeetingSchedule
              code={code}
              isHost={detail.isHost}
              startsAt={detail.starts_at}
              endsAt={detail.ends_at}
              recur={detail.recur ?? 'none'}
              recurUntil={detail.recur_until ?? null}
              recurExcept={detail.recur_except ?? []}
              onOccurrenceChanged={() => void reloadDetail()}
            />
          </div>
        )}

        {/* 설정 — 참가자 관리 + 권한 */}
        {subtab === 'settings' && detail && (
          <div className="hub-settings">
            <section className="hub-set-card">
              <div className="hub-section-title">
                <UsersIcon size={15} /> 참가자 <b>{detail.participants.length}</b>
              </div>
              <div className="hub-set-people">
                {detail.participants.map((p) => (
                  <div key={p.username} className="hub-set-person">
                    <Avatar value={p.avatar} className="hub-set-avatar" />
                    <span className="hub-set-info">
                      <span className="hub-set-name">
                        {p.username}
                        {p.isHost && <span className="hub-set-badge host">호스트</span>}
                        {p.role === 'owner' && <span className="hub-set-badge">소유자</span>}
                        {p.role === 'admin' && <span className="hub-set-badge admin">관리자</span>}
                        {presence.has(p.username) && <i className="hub-set-online" title="접속 중" />}
                      </span>
                      <span className="hub-set-sub">
                        {p.position && <b>{p.position}</b>}
                        {p.position && p.department && ' · '}
                        {p.department}
                      </span>
                    </span>
                    {detail.isHost && !p.isHost && (
                      <span className="hub-set-actions">
                        <button className="hub-set-btn" onClick={() => void transferHost(p.username)}>
                          호스트 위임
                        </button>
                        <button className="hub-set-btn danger" onClick={() => void kickParticipant(p.username)}>
                          내보내기
                        </button>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </section>

            <section className="hub-set-card">
              <div className="hub-section-title">
                <CalendarIcon size={15} /> 프로젝트 기간
                <span className="hub-set-hostonly">그룹 시작·종료에서 자동</span>
              </div>
              {(() => {
                // 프로젝트 기간 = 회의 시작일 ~ 종료일(반복이면 반복 끝나는 날)
                const pStart = detail.starts_at ? detail.starts_at.slice(0, 10) : null;
                const pEnd =
                  detail.recur && detail.recur !== 'none'
                    ? detail.recur_until ?? null
                    : detail.ends_at
                      ? detail.ends_at.slice(0, 10)
                      : null;
                const fmt = (d: string) => d.replace(/-/g, '. ');
                if (!pStart && !pEnd) {
                  return (
                    <div className="hub-section-empty">
                      그룹을 만들 때 시작·종료를 정하면 여기 기간이 표시돼요
                    </div>
                  );
                }
                return (
                  <div className="hub-period-view">
                    {pStart ? fmt(pStart) : '?'} ~ {pEnd ? fmt(pEnd) : '계속 반복'}
                    {pEnd &&
                      (() => {
                        const d = dday(pEnd);
                        return d != null ? (
                          <span className={`hub-dday${d < 0 ? ' over' : ''}`}>
                            {d > 0 ? `D-${d}` : d === 0 ? 'D-DAY' : `D+${-d}`}
                          </span>
                        ) : null;
                      })()}
                  </div>
                );
              })()}
            </section>

            <section className="hub-set-card">
              <div className="hub-section-title">
                <GearIcon size={15} /> 권한
                {!detail.isHost && <span className="hub-set-hostonly">호스트만 변경 가능</span>}
              </div>
              {(() => {
                const s = detail.settings ?? { locked: false, guestEdit: true, muteOnJoin: false };
                const Toggle = ({
                  on,
                  label,
                  desc,
                  onToggle,
                }: {
                  on: boolean;
                  label: string;
                  desc: string;
                  onToggle: () => void;
                }) => (
                  <div className="hub-perm">
                    <span className="hub-perm-text">
                      <span className="hub-perm-label">{label}</span>
                      <span className="hub-perm-desc">{desc}</span>
                    </span>
                    <button
                      className={`hub-switch${on ? ' on' : ''}`}
                      disabled={!detail.isHost}
                      onClick={onToggle}
                      aria-label={label}
                    >
                      <i />
                    </button>
                  </div>
                );
                return (
                  <>
                    <Toggle
                      on={s.locked}
                      label="입장 잠금"
                      desc="새로운 사람의 그룹 참여를 막아요"
                      onToggle={() => void updateSettings({ locked: !s.locked })}
                    />
                    <Toggle
                      on={s.guestEdit}
                      label="참가자 편집 허용"
                      desc="참가자도 문서·시트·캔버스를 편집할 수 있어요"
                      onToggle={() => void updateSettings({ guestEdit: !s.guestEdit })}
                    />
                    <Toggle
                      on={s.muteOnJoin}
                      label="입장 시 음소거"
                      desc="통화 입장할 때 마이크를 끈 상태로 시작해요"
                      onToggle={() => void updateSettings({ muteOnJoin: !s.muteOnJoin })}
                    />
                  </>
                );
              })()}
            </section>

            <section className="hub-set-card">
              <div className="hub-section-title">
                <PinIcon size={15} /> 내 사이드바
              </div>
              <div className="hub-perm">
                <span className="hub-perm-text">
                  <span className="hub-perm-label">맨 위 고정</span>
                  <span className="hub-perm-desc">최근 그룹 목록 맨 위에 고정해요 (나에게만 적용)</span>
                </span>
                <button
                  className={`hub-switch${pinnedNow ? ' on' : ''}`}
                  onClick={() => {
                    togglePin(detail.id);
                    setPinnedNow((p) => !p);
                  }}
                  aria-label="맨 위 고정"
                >
                  <i />
                </button>
              </div>
            </section>

            {detail.isHost && (
              <section className="hub-set-card danger-zone">
                <div className="hub-section-title">
                  <GearIcon size={15} /> 그룹 삭제
                </div>
                <p className="hub-danger-desc">
                  회의와 모든 채팅·일정 기록이 영구적으로 사라져요. 되돌릴 수 없어요.
                </p>
                <button
                  className={`hub-danger-btn${confirmDelMeeting ? ' confirm' : ''}`}
                  onClick={() => void deleteMeeting()}
                  onMouseLeave={() => setConfirmDelMeeting(false)}
                >
                  {confirmDelMeeting ? '정말 삭제할까요? 한 번 더 클릭' : '이 회의 삭제하기'}
                </button>
              </section>
            )}
          </div>
        )}

        {/* 통화 — 입장하면 서브탭 옮겨도 마운트 유지. 다른 서브탭에선 우하단 미니 PiP */}
        {(inCall || subtab === 'call') && (
          <div
            className={`hub-call${subtab === 'call' ? '' : ' mini'}`}
            style={
              subtab !== 'call'
                ? ({
                    width: pipW,
                    height: pipH,
                    '--pip-cols': Math.max(1, Math.round(pipW / PIP_TILE_W)),
                    ...(pipPos ? { left: pipPos.x, top: pipPos.y, right: 'auto', bottom: 'auto' } : {}),
                  } as React.CSSProperties)
                : undefined
            }
            onMouseDown={subtab !== 'call' ? startPipDrag : undefined}
          >
            {subtab !== 'call' && (
              <div
                className="hub-pip-resize"
                onMouseDown={startPipResize}
                title="모서리를 끌어 크기 조절"
              />
            )}
            {subtab !== 'call' && (
              <div className="hub-pip-bar">
                <span className="hub-pip-grip" title="드래그해서 옮기기">
                  ⠿ 통화 · 드래그하여 이동
                </span>
                <button
                  className="hub-pip-expand"
                  onClick={() => setSubtab('call')}
                  title="통화 화면 크게 보기"
                >
                  ⤢
                </button>
              </div>
            )}
            <MeetingView
              code={code}
              embedded
              expanded={expanded}
              onToggleExpand={onToggleExpand}
              onJoined={() => setInCall(true)}
              onlinePeers={detail?.callPeers ?? []}
              onLeave={(message) => {
                setInCall(false);
                setSubtab('dash');
                if (expanded) onToggleExpand?.();
                if (message)
                  window.dispatchEvent(new CustomEvent('app:error', { detail: message }));
              }}
            />
          </div>
        )}

        {/* 캔버스 — 회의마다 자동으로 생기는 공동편집 보드 (한 번 열면 마운트 유지) */}
        {canvasMounted && (
          <div
            className="hub-canvas"
            style={{ display: subtab === 'canvas' ? 'block' : 'none' }}
          >
            <CanvasBoard roomId={`mt-${code.toUpperCase()}`} />
          </div>
        )}

        {/* 코드 공동편집 — Yjs 실시간 (한 번 열면 마운트 유지) */}
        {codeMounted && (
          <div
            className="hub-editor-pane"
            style={{ display: subtab === 'code' ? 'block' : 'none' }}
          >
            <CodeDocEditor roomId={`code-${code.toUpperCase()}`} />
          </div>
        )}

        {/* 문서 공동편집 — 리치텍스트(Word형), Yjs 실시간 */}
        {docMounted && (
          <div
            className="hub-editor-pane"
            style={{ display: subtab === 'doc' ? 'block' : 'none' }}
          >
            <DocEditor roomId={`doc-${code.toUpperCase()}`} />
          </div>
        )}

        {/* 시트 공동편집 — 협업 스프레드시트, Yjs 실시간 */}
        {sheetMounted && (
          <div
            className="hub-editor-pane"
            style={{ display: subtab === 'sheet' ? 'block' : 'none' }}
          >
            <SheetEditor roomId={`sheet-${code.toUpperCase()}`} />
          </div>
        )}

        {/* 발표(슬라이드) 공동편집 — Yjs 실시간 */}
        {slideMounted && (
          <div
            className="hub-editor-pane"
            style={{ display: subtab === 'slide' ? 'block' : 'none' }}
          >
            <SlideEditor roomId={`slide-${code.toUpperCase()}`} />
          </div>
        )}

        {/* 채팅 */}
        {subtab === 'chat' && (
          <div className="hub-chat">
            <div className="hub-chat-messages">
              {messages.length === 0 && (
                <div className="chat-empty">
                  <ChatIcon size={40} />
                  <p>아직 대화가 없어요</p>
                  <span>첫 메시지를 남겨보세요</span>
                </div>
              )}
              {messages.map((m, i) => {
                const prev = messages[i - 1];
                const mine = m.from === user?.username;
                const showDate = !prev || !sameDay(prev.ts, m.ts);
                const grouped =
                  !!prev && prev.from === m.from && !showDate && m.ts - prev.ts < 5 * 60_000;
                return (
                  <Fragment key={i}>
                    {showDate && (
                      <div className="chat-date">
                        <span>{chatDateLabel(m.ts)}</span>
                      </div>
                    )}
                    <div className={`chat-row${mine ? ' mine' : ''}${grouped ? ' grouped' : ''}`}>
                      {!mine &&
                        (grouped ? (
                          <span className="chat-avatar-gap" />
                        ) : (
                          <Avatar value={m.avatar} className="chat-avatar" />
                        ))}
                      <div className="chat-content">
                        {!mine && !grouped && <span className="chat-name">{m.from}</span>}
                        <div className="chat-line">
                          {mine && <span className="chat-time">{chatTime(m.ts)}</span>}
                          <div className={`chat-bubble${m.file ? ' has-file' : ''}`}>
                            {m.file ? (
                              <a
                                className="chat-file"
                                href={m.file.url}
                                target="_blank"
                                rel="noreferrer"
                                download={m.file.name}
                              >
                                {/\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(m.file.name) ? (
                                  <img className="chat-file-img" src={m.file.url} alt={m.file.name} />
                                ) : (
                                  <span className="chat-file-card">
                                    <span className="chat-file-ic">📎</span>
                                    <span className="chat-file-meta">
                                      <span className="chat-file-name">{m.file.name}</span>
                                      <span className="chat-file-size">{formatBytes(m.file.size)}</span>
                                    </span>
                                    <span className="chat-file-dl">⬇</span>
                                  </span>
                                )}
                                {m.text && <span className="chat-file-text">{m.text}</span>}
                              </a>
                            ) : (
                              m.text
                            )}
                          </div>
                          {!mine && <span className="chat-time">{chatTime(m.ts)}</span>}
                        </div>
                      </div>
                    </div>
                  </Fragment>
                );
              })}
              <div ref={chatEndRef} />
            </div>
            <form className="hub-chat-input" onSubmit={sendChat}>
              <input
                ref={chatFileRef}
                type="file"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void sendChatFile(f);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                className="hub-chat-attach"
                title="파일 첨부"
                disabled={uploadingFile}
                onClick={() => chatFileRef.current?.click()}
              >
                {uploadingFile ? '…' : '📎'}
              </button>
              <input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="메시지 입력"
              />
              <button type="submit">전송</button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
