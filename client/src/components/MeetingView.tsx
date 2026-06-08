import { useCallback, useEffect, useRef, useState } from 'react';
import { Device } from 'mediasoup-client';
import type { Transport, Producer } from 'mediasoup-client/types';
import { getSocket, request } from '../lib/socket';
import { api } from '../api';
import { useAuthStore } from '../store';
import Logo from './Logo';
import { MicIcon, CamIcon, ScreenIcon, ChatIcon, SlashIcon, ExpandIcon, ShrinkIcon } from './Icons';

interface RemotePeer {
  peerId: string;
  username: string;
  videoTrack?: MediaStreamTrack;
  audioTrack?: MediaStreamTrack;
  screenTrack?: MediaStreamTrack;
  videoPaused?: boolean;
}

interface ProducerInfo {
  producerId: string;
  peerId: string;
  username: string;
  kind: 'audio' | 'video';
  source?: string;
}

export interface ChatMessage {
  code?: string;
  from: string;
  avatar?: string | null;
  text: string;
  ts: number;
}

/** 카메라가 없을 때 쓰는 캔버스 기반 가짜 비디오 (개발·데모용) */
function makeFallbackStream(label: string): MediaStream {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext('2d')!;
  setInterval(() => {
    ctx.fillStyle = '#1c1f26';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#2db400';
    ctx.font = 'bold 48px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, canvas.width / 2, canvas.height / 2 - 10);
    ctx.fillStyle = '#888';
    ctx.font = '20px sans-serif';
    ctx.fillText(new Date().toLocaleTimeString('ko-KR'), canvas.width / 2, canvas.height / 2 + 40);
  }, 500);
  return canvas.captureStream(2);
}

function VideoTile({
  track,
  username,
  muted,
  isLocal,
  isScreen,
  paused,
  onKick,
}: {
  track?: MediaStreamTrack;
  username: string;
  muted?: boolean;
  isLocal?: boolean;
  isScreen?: boolean;
  paused?: boolean;
  onKick?: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const showVideo = !!track && !paused;
  useEffect(() => {
    if (ref.current && track && showVideo) {
      ref.current.srcObject = new MediaStream([track]);
    }
  }, [track, showVideo]);
  return (
    <div className={`video-tile${isScreen ? ' screen' : ''}`}>
      {showVideo ? (
        <video ref={ref} autoPlay playsInline muted={muted} />
      ) : (
        <div className="video-placeholder">
          <div className="avatar-circle">{username.slice(0, 1).toUpperCase()}</div>
          <span className="cam-off-label">카메라 꺼짐</span>
        </div>
      )}
      <span className="video-name">
        {isScreen && '🖥️ '}
        {username}
        {isLocal && ' (나)'}
      </span>
      {onKick && (
        <button className="kick-btn" title="강퇴" onClick={onKick}>
          내보내기
        </button>
      )}
    </div>
  );
}

function AudioSink({ track }: { track: MediaStreamTrack }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = new MediaStream([track]);
  }, [track]);
  return <audio ref={ref} autoPlay />;
}

interface MeetingViewProps {
  code: string;
  /** 대시보드 탭 안에 임베드된 모드 (확대/축소 버튼 표시, 로고 숨김) */
  embedded?: boolean;
  /** 오버레이 전체화면 상태 (연결 유지한 채 확대) */
  expanded?: boolean;
  onToggleExpand?: () => void;
  /** 나가기/강퇴 시 호출 — embedded면 탭 닫기, 전체화면이면 대시보드 이동 */
  onLeave: (message?: string) => void;
}

export default function MeetingView({
  code,
  embedded = false,
  expanded = false,
  onToggleExpand,
  onLeave,
}: MeetingViewProps) {
  const user = useAuthStore((s) => s.user);

  const [status, setStatus] = useState('연결 중…');
  const [title, setTitle] = useState('');
  const [localTrack, setLocalTrack] = useState<MediaStreamTrack>();
  const [localScreen, setLocalScreen] = useState<MediaStreamTrack>();
  const [remotePeers, setRemotePeers] = useState<Map<string, RemotePeer>>(new Map());
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [chatOpen, setChatOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [unread, setUnread] = useState(0);
  const [isHost, setIsHost] = useState(false);
  const [locked, setLocked] = useState(false);

  const producersRef = useRef<{
    audio?: Producer;
    video?: Producer;
    screen?: Producer;
  }>({});
  const sendTransportRef = useRef<Transport | null>(null);
  const consumerMapRef = useRef<Map<string, { peerId: string; kind: string; source: string }>>(
    new Map(),
  );
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatOpenRef = useRef(chatOpen);
  chatOpenRef.current = chatOpen;
  const onLeaveRef = useRef(onLeave);
  onLeaveRef.current = onLeave;

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, chatOpen]);

  useEffect(() => {
    if (!code) return;
    const socket = getSocket();
    let recvTransport: Transport | null = null;
    let localStream: MediaStream | null = null;
    let closed = false;

    function upsertPeer(
      peerId: string,
      username: string,
      patch?: Partial<Pick<RemotePeer, 'videoTrack' | 'audioTrack' | 'screenTrack' | 'videoPaused'>>,
    ) {
      setRemotePeers((prev) => {
        const next = new Map(prev);
        const p = next.get(peerId) ?? { peerId, username };
        next.set(peerId, { ...p, username, ...patch });
        return next;
      });
    }

    async function consume(device: Device, info: ProducerInfo) {
      if (!recvTransport) return;
      const params = await request<{
        id: string;
        producerId: string;
        kind: 'audio' | 'video';
        rtpParameters: import('mediasoup-client/types').RtpParameters;
      }>(socket, 'consume', {
        transportId: recvTransport.id,
        producerId: info.producerId,
        rtpCapabilities: device.rtpCapabilities,
      });
      const consumer = await recvTransport.consume(params);
      await request(socket, 'consumer:resume', { consumerId: consumer.id });
      const source = info.source ?? 'camera';
      consumerMapRef.current.set(info.producerId, {
        peerId: info.peerId,
        kind: info.kind,
        source,
      });
      if (info.kind === 'audio') {
        upsertPeer(info.peerId, info.username, { audioTrack: consumer.track });
      } else if (source === 'screen') {
        upsertPeer(info.peerId, info.username, { screenTrack: consumer.track });
      } else {
        upsertPeer(info.peerId, info.username, { videoTrack: consumer.track });
      }
    }

    async function run() {
      // 0. 회의 참여 등록 (코드 = 입장 권한) + 제목 표시
      const meeting = await api<{ title: string }>('/api/meetings/join', {
        method: 'POST',
        body: { code },
      });
      setTitle(meeting.title);

      // 채팅: 히스토리 로드 + 채팅 룸 구독 (허브와 공용 스트림)
      void api<ChatMessage[]>(`/api/meetings/${code}/messages`).then((history) => {
        if (!closed) setMessages(history);
      });
      void request(socket, 'chat:join', { code }).catch(() => {});

      // 1. SFU 방 입장
      const joined = await request<{
        rtpCapabilities: import('mediasoup-client/types').RtpCapabilities;
        producers: ProducerInfo[];
        peers: { peerId: string; username: string }[];
        isHost: boolean;
        locked: boolean;
      }>(socket, 'room:join', { code });
      setIsHost(joined.isHost);
      setLocked(joined.locked);

      // 2. Device 로드
      const device = new Device();
      await device.load({ routerRtpCapabilities: joined.rtpCapabilities });

      // 3. 송신 transport
      const sendParams = await request<{
        id: string;
        iceParameters: import('mediasoup-client/types').IceParameters;
        iceCandidates: import('mediasoup-client/types').IceCandidate[];
        dtlsParameters: import('mediasoup-client/types').DtlsParameters;
      }>(socket, 'transport:create', {});
      const sendTransport = device.createSendTransport(sendParams);
      sendTransportRef.current = sendTransport;
      sendTransport.on('connect', ({ dtlsParameters }, cb, eb) => {
        request(socket, 'transport:connect', { transportId: sendTransport.id, dtlsParameters })
          .then(() => cb())
          .catch(eb);
      });
      sendTransport.on('produce', ({ kind, rtpParameters, appData }, cb, eb) => {
        request<{ id: string }>(socket, 'produce', {
          transportId: sendTransport.id,
          kind,
          rtpParameters,
          appData,
        })
          .then(({ id }) => cb({ id }))
          .catch(eb);
      });

      // 4. 수신 transport
      const recvParams = await request<typeof sendParams>(socket, 'transport:create', {});
      recvTransport = device.createRecvTransport(recvParams);
      recvTransport.on('connect', ({ dtlsParameters }, cb, eb) => {
        request(socket, 'transport:connect', { transportId: recvTransport!.id, dtlsParameters })
          .then(() => cb())
          .catch(eb);
      });

      // 5. 로컬 미디어 (거부/부재/5초 무응답 시 캔버스 폴백)
      try {
        localStream = await Promise.race([
          navigator.mediaDevices.getUserMedia({ video: true, audio: true }),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error('getUserMedia timeout')), 5000),
          ),
        ]);
      } catch {
        localStream = makeFallbackStream(user?.username ?? 'me');
        setStatus('카메라 없음 — 데모 화면 송출 중');
      }
      if (closed) return;

      const videoTrack = localStream.getVideoTracks()[0];
      const audioTrack = localStream.getAudioTracks()[0];
      if (videoTrack) {
        setLocalTrack(videoTrack);
        producersRef.current.video = await sendTransport.produce({
          track: videoTrack,
          appData: { source: 'camera' },
        });
      }
      if (audioTrack) {
        producersRef.current.audio = await sendTransport.produce({
          track: audioTrack,
          appData: { source: 'camera' },
        });
      }

      // 6. 기존 참가자 + producer consume
      for (const p of joined.peers) {
        if (p.peerId !== socket.id) upsertPeer(p.peerId, p.username);
      }
      for (const info of joined.producers) await consume(device, info);

      // 7. 실시간 이벤트
      socket.on('peer:joined', ({ peerId, username }) => upsertPeer(peerId, username));
      socket.on('peer:left', ({ peerId }) => {
        setRemotePeers((prev) => {
          const next = new Map(prev);
          next.delete(peerId);
          return next;
        });
      });
      socket.on('producer:new', (info: ProducerInfo) => void consume(device, info));
      socket.on('producer:closed', ({ producerId }: { producerId: string }) => {
        const meta = consumerMapRef.current.get(producerId);
        if (!meta) return;
        consumerMapRef.current.delete(producerId);
        setRemotePeers((prev) => {
          const next = new Map(prev);
          const p = next.get(meta.peerId);
          if (!p) return prev;
          if (meta.kind === 'audio') next.set(meta.peerId, { ...p, audioTrack: undefined });
          else if (meta.source === 'screen')
            next.set(meta.peerId, { ...p, screenTrack: undefined });
          else next.set(meta.peerId, { ...p, videoTrack: undefined });
          return next;
        });
      });
      socket.on('producer:paused', ({ producerId }: { producerId: string }) => {
        const meta = consumerMapRef.current.get(producerId);
        if (meta?.kind === 'video' && meta.source === 'camera') {
          setRemotePeers((prev) => {
            const next = new Map(prev);
            const p = next.get(meta.peerId);
            if (p) next.set(meta.peerId, { ...p, videoPaused: true });
            return next;
          });
        }
      });
      socket.on('producer:resumed', ({ producerId }: { producerId: string }) => {
        const meta = consumerMapRef.current.get(producerId);
        if (meta?.kind === 'video' && meta.source === 'camera') {
          setRemotePeers((prev) => {
            const next = new Map(prev);
            const p = next.get(meta.peerId);
            if (p) next.set(meta.peerId, { ...p, videoPaused: false });
            return next;
          });
        }
      });
      socket.on('chat:message', (msg: ChatMessage) => {
        if (msg.code && msg.code !== code.toUpperCase()) return; // 다른 회의 채팅 무시
        setMessages((prev) => [...prev, msg]);
        if (!chatOpenRef.current) setUnread((n) => n + 1);
      });
      socket.on('room:locked', ({ locked }: { locked: boolean }) => setLocked(locked));
      socket.on('room:kicked', () => {
        onLeaveRef.current('호스트가 회의에서 내보냈습니다');
      });

      setStatus('');
    }

    run().catch((err) => setStatus(`연결 실패: ${err.message}`));

    return () => {
      closed = true;
      socket.off('peer:joined');
      socket.off('peer:left');
      socket.off('producer:new');
      socket.off('producer:closed');
      socket.off('producer:paused');
      socket.off('producer:resumed');
      socket.off('chat:message');
      socket.off('room:locked');
      socket.off('room:kicked');
      sendTransportRef.current?.close();
      recvTransport?.close();
      localStream?.getTracks().forEach((t) => t.stop());
      socket.disconnect();
    };
  }, [code, user?.username]);

  function toggleMic() {
    const p = producersRef.current.audio;
    if (!p) return;
    const socket = getSocket();
    if (micOn) {
      p.pause();
      void request(socket, 'producer:pause', { producerId: p.id }).catch(() => {});
    } else {
      p.resume();
      void request(socket, 'producer:resume', { producerId: p.id }).catch(() => {});
    }
    setMicOn(!micOn);
  }

  function toggleCam() {
    const p = producersRef.current.video;
    if (!p) return;
    const socket = getSocket();
    if (camOn) {
      p.pause();
      void request(socket, 'producer:pause', { producerId: p.id }).catch(() => {});
    } else {
      p.resume();
      void request(socket, 'producer:resume', { producerId: p.id }).catch(() => {});
    }
    setCamOn(!camOn);
  }

  const stopScreenShare = useCallback(() => {
    const p = producersRef.current.screen;
    if (!p) return;
    const socket = getSocket();
    void request(socket, 'producer:close', { producerId: p.id }).catch(() => {});
    p.close();
    producersRef.current.screen = undefined;
    setLocalScreen(undefined);
  }, []);

  async function toggleScreenShare() {
    if (producersRef.current.screen) {
      stopScreenShare();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = stream.getVideoTracks()[0];
      const producer = await sendTransportRef.current!.produce({
        track,
        appData: { source: 'screen' },
      });
      producersRef.current.screen = producer;
      setLocalScreen(track);
      // 브라우저 UI의 "공유 중지"로 끝났을 때도 정리
      track.addEventListener('ended', stopScreenShare);
    } catch {
      /* 사용자가 화면 선택 취소 — 무시 */
    }
  }

  function sendChat(e: React.FormEvent) {
    e.preventDefault();
    if (!chatInput.trim()) return;
    getSocket().emit('chat:send', { code, text: chatInput });
    setChatInput('');
  }

  const peers = [...remotePeers.values()];

  // 공유 중인 화면 전부 (로컬 + 원격 여러 명 동시 지원)
  const screens: { key: string; track: MediaStreamTrack; username: string; isLocal?: boolean }[] =
    [
      ...(localScreen
        ? [{ key: 'local', track: localScreen, username: user?.username ?? '나', isLocal: true }]
        : []),
      ...peers
        .filter((p) => p.screenTrack)
        .map((p) => ({ key: p.peerId, track: p.screenTrack!, username: p.username })),
    ];
  const hasScreen = screens.length > 0;

  return (
    <div className={`meeting-room${embedded ? ' embedded' : ''}`}>
      <header className="meeting-header">
        {!embedded && <Logo light />}
        <div className="meeting-info">
          <span className="meeting-title">{title || '회의'}</span>
          <span className="meeting-code">
            코드 <b>{code}</b> · 참가자 {peers.length + 1}명
            {locked && ' · 🔒 잠김'}
          </span>
        </div>
        {isHost && (
          <button
            className="lock-btn"
            title={locked ? '회의 잠금 해제' : '회의 잠금 (새 참가자 차단)'}
            onClick={() => {
              void request(getSocket(), 'room:lock', { locked: !locked });
            }}
          >
            {locked ? '🔒 잠김' : '🔓 열림'}
          </button>
        )}
        {status && <span className="meeting-status">{status}</span>}
        {embedded && onToggleExpand && (
          <button
            className="expand-btn"
            title={expanded ? '탭으로 축소' : '전체화면으로 확대'}
            onClick={onToggleExpand}
          >
            {expanded ? <ShrinkIcon size={17} /> : <ExpandIcon size={17} />}
          </button>
        )}
      </header>

      <div className="meeting-body">
        <div className={`video-area${hasScreen ? ' with-screen' : ''}`}>
          {hasScreen && (
            <div className={`screen-stage screens-${screens.length}`}>
              {screens.map((s) => (
                <VideoTile
                  key={s.key}
                  track={s.track}
                  username={s.username}
                  muted={s.isLocal}
                  isLocal={s.isLocal}
                  isScreen
                />
              ))}
            </div>
          )}
          <div
            className={`video-grid${hasScreen ? ' filmstrip' : ''} count-${peers.length + 1}`}
          >
            <VideoTile
              track={localTrack}
              username={user?.username ?? '나'}
              muted
              isLocal
              paused={!camOn}
            />
            {peers.map((p) => (
              <div key={p.peerId} className="peer-cell">
                <VideoTile
                  track={p.videoTrack}
                  username={p.username}
                  paused={p.videoPaused}
                  onKick={
                    isHost
                      ? () => void request(getSocket(), 'room:kick', { peerId: p.peerId })
                      : undefined
                  }
                />
                {p.audioTrack && <AudioSink track={p.audioTrack} />}
              </div>
            ))}
          </div>
        </div>

        {chatOpen && (
          <aside className="chat-panel">
            <div className="chat-head">
              <span className="chat-head-title">
                <ChatIcon size={16} /> 채팅
              </span>
              <button onClick={() => setChatOpen(false)}>×</button>
            </div>
            <div className="chat-messages">
              {messages.length === 0 && <div className="chat-empty">아직 메시지가 없어요</div>}
              {messages.map((m, i) => (
                <div key={i} className={`chat-msg${m.from === user?.username ? ' mine' : ''}`}>
                  <span className="chat-from">{m.from}</span>
                  <div className="chat-bubble">{m.text}</div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
            <form className="chat-input" onSubmit={sendChat}>
              <input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="메시지 입력"
              />
              <button type="submit">전송</button>
            </form>
          </aside>
        )}
      </div>

      <footer className="meeting-controls">
        <button className={micOn ? '' : 'off'} onClick={toggleMic} title="마이크">
          <MicIcon size={21} />
          {!micOn && (
            <span className="slash">
              <SlashIcon size={21} />
            </span>
          )}
        </button>
        <button className={camOn ? '' : 'off'} onClick={toggleCam} title="카메라">
          <CamIcon size={21} />
          {!camOn && (
            <span className="slash">
              <SlashIcon size={21} />
            </span>
          )}
        </button>
        <button
          className={localScreen ? 'active' : ''}
          onClick={toggleScreenShare}
          title="화면 공유"
        >
          <ScreenIcon size={21} />
        </button>
        <button
          className={chatOpen ? 'active' : ''}
          onClick={() => {
            setChatOpen((v) => !v);
            setUnread(0);
          }}
          title="채팅"
        >
          <ChatIcon size={20} />
          {unread > 0 && <span className="badge">{unread}</span>}
        </button>
        <button className="leave" onClick={() => onLeave()} title="나가기">
          나가기
        </button>
      </footer>
    </div>
  );
}
