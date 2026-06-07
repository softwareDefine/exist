import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Device } from 'mediasoup-client';
import type { Transport } from 'mediasoup-client/types';
import { getSocket, request } from '../lib/socket';
import { useAuthStore } from '../store';

interface RemotePeer {
  peerId: string;
  username: string;
  videoTrack?: MediaStreamTrack;
  audioTrack?: MediaStreamTrack;
}

interface ProducerInfo {
  producerId: string;
  peerId: string;
  username: string;
  kind: 'audio' | 'video';
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
}: {
  track?: MediaStreamTrack;
  username: string;
  muted?: boolean;
  isLocal?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && track) {
      ref.current.srcObject = new MediaStream([track]);
    }
  }, [track]);
  return (
    <div className="video-tile">
      {track ? (
        <video ref={ref} autoPlay playsInline muted={muted} />
      ) : (
        <div className="video-placeholder">🎤</div>
      )}
      <span className="video-name">
        {username}
        {isLocal && ' (나)'}
      </span>
    </div>
  );
}

export default function MeetingRoomPage() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);

  const [status, setStatus] = useState('연결 중…');
  const [localTrack, setLocalTrack] = useState<MediaStreamTrack>();
  const [remotePeers, setRemotePeers] = useState<Map<string, RemotePeer>>(new Map());
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);

  const producersRef = useRef<{ audio?: { pause(): void; resume(): void }; video?: { pause(): void; resume(): void } }>({});

  useEffect(() => {
    if (!code) return;
    const socket = getSocket();
    let sendTransport: Transport | null = null;
    let recvTransport: Transport | null = null;
    let localStream: MediaStream | null = null;
    let closed = false;

    function upsertPeer(peerId: string, username: string, kind?: string, track?: MediaStreamTrack) {
      setRemotePeers((prev) => {
        const next = new Map(prev);
        const p = next.get(peerId) ?? { peerId, username };
        if (kind === 'video') p.videoTrack = track;
        if (kind === 'audio') p.audioTrack = track;
        next.set(peerId, { ...p, username });
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
      upsertPeer(info.peerId, info.username, info.kind, consumer.track);
    }

    async function run() {
      // 1. 방 입장
      const joined = await request<{
        rtpCapabilities: import('mediasoup-client/types').RtpCapabilities;
        producers: ProducerInfo[];
        peers: { peerId: string; username: string }[];
      }>(socket, 'room:join', { code });

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
      sendTransport = device.createSendTransport(sendParams);
      sendTransport.on('connect', ({ dtlsParameters }, cb, eb) => {
        request(socket, 'transport:connect', { transportId: sendTransport!.id, dtlsParameters })
          .then(() => cb())
          .catch(eb);
      });
      sendTransport.on('produce', ({ kind, rtpParameters }, cb, eb) => {
        request<{ id: string }>(socket, 'produce', {
          transportId: sendTransport!.id,
          kind,
          rtpParameters,
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
        producersRef.current.video = await sendTransport.produce({ track: videoTrack });
      }
      if (audioTrack) {
        producersRef.current.audio = await sendTransport.produce({ track: audioTrack });
      }

      // 6. 기존 참가자 표시 + producer consume
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

      setStatus('');
    }

    run().catch((err) => setStatus(`연결 실패: ${err.message}`));

    return () => {
      closed = true;
      socket.off('peer:joined');
      socket.off('peer:left');
      socket.off('producer:new');
      sendTransport?.close();
      recvTransport?.close();
      localStream?.getTracks().forEach((t) => t.stop());
      socket.disconnect();
    };
  }, [code, user?.username]);

  function toggleMic() {
    const p = producersRef.current.audio;
    if (!p) return;
    micOn ? p.pause() : p.resume();
    setMicOn(!micOn);
  }

  function toggleCam() {
    const p = producersRef.current.video;
    if (!p) return;
    camOn ? p.pause() : p.resume();
    setCamOn(!camOn);
  }

  const peers = [...remotePeers.values()];

  return (
    <div className="meeting-room">
      <header className="meeting-header">
        <span className="logo">exist</span>
        <span className="meeting-code">
          회의 코드: <b>{code}</b>
        </span>
        {status && <span className="meeting-status">{status}</span>}
      </header>

      <div className={`video-grid count-${peers.length + 1}`}>
        <VideoTile track={localTrack} username={user?.username ?? '나'} muted isLocal />
        {peers.map((p) => (
          <div key={p.peerId}>
            <VideoTile track={p.videoTrack} username={p.username} />
            {p.audioTrack && <AudioSink track={p.audioTrack} />}
          </div>
        ))}
      </div>

      <footer className="meeting-controls">
        <button className={micOn ? '' : 'off'} onClick={toggleMic} title="마이크">
          {micOn ? '🎙️' : '🔇'}
        </button>
        <button className={camOn ? '' : 'off'} onClick={toggleCam} title="카메라">
          {camOn ? '📷' : '🚫'}
        </button>
        <button className="leave" onClick={() => navigate('/')} title="나가기">
          나가기
        </button>
      </footer>
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
