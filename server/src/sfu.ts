import * as mediasoup from 'mediasoup';
import type { Server, Socket } from 'socket.io';
import type {
  Worker,
  Router,
  WebRtcTransport,
  Producer,
  Consumer,
  RtpCodecCapability,
  DtlsParameters,
  RtpParameters,
  MediaKind,
  RtpCapabilities,
} from 'mediasoup/types';
import db from './db.js';

/*
 * exist SFU — mediasoup 기반 직접 구현.
 * Room(회의 코드) 단위로 Router를 만들고, Peer(소켓)별 transport/producer/consumer를 관리한다.
 *
 * 시그널링 프로토콜 (Socket.IO ack 기반):
 *   room:join      {code}                                → {rtpCapabilities, producers[], peers[]}
 *   transport:create {direction}                         → WebRtcTransport 파라미터
 *   transport:connect {transportId, dtlsParameters}      → {ok}
 *   produce        {transportId, kind, rtpParameters}    → {id}
 *   consume        {transportId, producerId, rtpCapabilities} → consumer 파라미터
 *   consumer:resume {consumerId}                         → {ok}
 *   브로드캐스트: peer:joined / peer:left / producer:new / producer:closed
 */

const mediaCodecs: RtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    preferredPayloadType: 111,
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    preferredPayloadType: 96,
    clockRate: 90000,
    parameters: { 'x-google-start-bitrate': 1000 },
  },
];

interface Peer {
  socketId: string;
  userId: number;
  username: string;
  transports: Map<string, WebRtcTransport>;
  producers: Map<string, Producer>;
  consumers: Map<string, Consumer>;
}

interface Room {
  code: string;
  router: Router;
  peers: Map<string, Peer>;
  hostUserId: number | null;
  locked: boolean;
}

let worker: Worker;
const rooms = new Map<string, Room>();

export async function startMediasoup() {
  worker = await mediasoup.createWorker({
    rtcMinPort: Number(process.env.RTC_MIN_PORT ?? 40000),
    rtcMaxPort: Number(process.env.RTC_MAX_PORT ?? 40100),
  });
  worker.on('died', () => {
    console.error('[sfu] mediasoup worker died — exiting');
    process.exit(1);
  });
  console.log('[sfu] mediasoup worker started');
}

async function getOrCreateRoom(code: string): Promise<Room> {
  let room = rooms.get(code);
  if (!room) {
    const router = await worker.createRouter({ mediaCodecs });
    const meeting = db.prepare('SELECT host_id FROM meetings WHERE code = ?').get(code) as
      | { host_id: number }
      | undefined;
    room = {
      code,
      router,
      peers: new Map(),
      hostUserId: meeting?.host_id ?? null,
      locked: false,
    };
    rooms.set(code, room);
    console.log(`[sfu] room created: ${code}`);
  }
  return room;
}

function closeRoomIfEmpty(room: Room) {
  if (room.peers.size === 0) {
    room.router.close();
    rooms.delete(room.code);
    console.log(`[sfu] room closed: ${room.code}`);
  }
}

async function createWebRtcTransport(router: Router): Promise<WebRtcTransport> {
  return router.createWebRtcTransport({
    // 개발: 로컬호스트. 배포 시 ANNOUNCED_IP에 공인 IP 설정
    listenInfos: [
      {
        protocol: 'udp',
        ip: '0.0.0.0',
        announcedAddress: process.env.ANNOUNCED_IP ?? '127.0.0.1',
      },
      {
        protocol: 'tcp',
        ip: '0.0.0.0',
        announcedAddress: process.env.ANNOUNCED_IP ?? '127.0.0.1',
      },
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1_000_000,
  });
}

export function attachSfu(io: Server) {
  io.on('connection', (socket: Socket) => {
    let room: Room | null = null;
    let peer: Peer | null = null;

    socket.on('room:join', async ({ code }: { code: string }, ack) => {
      try {
        room = await getOrCreateRoom(code);
        const userId = socket.data.userId as number;
        if (room.locked && userId !== room.hostUserId) {
          room = null;
          return ack({ error: '호스트가 회의를 잠갔습니다' });
        }
        peer = {
          socketId: socket.id,
          userId,
          username: socket.data.username as string,
          transports: new Map(),
          producers: new Map(),
          consumers: new Map(),
        };
        room.peers.set(socket.id, peer);
        await socket.join(`room:${code}`);

        // 기존 참가자의 producer 목록 (신규 입장자가 consume)
        const producers: {
          producerId: string;
          peerId: string;
          username: string;
          kind: MediaKind;
          source: string;
        }[] = [];
        for (const p of room.peers.values()) {
          if (p.socketId === socket.id) continue;
          for (const producer of p.producers.values()) {
            producers.push({
              producerId: producer.id,
              peerId: p.socketId,
              username: p.username,
              kind: producer.kind,
              source: (producer.appData as { source?: string })?.source ?? 'camera',
            });
          }
        }
        socket.to(`room:${code}`).emit('peer:joined', {
          peerId: socket.id,
          username: peer.username,
        });
        ack({
          rtpCapabilities: room.router.rtpCapabilities,
          producers,
          peers: [...room.peers.values()].map((p) => ({ peerId: p.socketId, username: p.username })),
          isHost: userId === room.hostUserId,
          locked: room.locked,
        });
      } catch (err) {
        console.error('[sfu] room:join error', err);
        ack({ error: '회의 입장 실패' });
      }
    });

    socket.on('transport:create', async (_data, ack) => {
      if (!room || !peer) return ack({ error: '방에 입장하지 않았습니다' });
      try {
        const transport = await createWebRtcTransport(room.router);
        peer.transports.set(transport.id, transport);
        ack({
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        });
      } catch (err) {
        console.error('[sfu] transport:create error', err);
        ack({ error: 'transport 생성 실패' });
      }
    });

    socket.on(
      'transport:connect',
      async (
        { transportId, dtlsParameters }: { transportId: string; dtlsParameters: DtlsParameters },
        ack,
      ) => {
        const transport = peer?.transports.get(transportId);
        if (!transport) return ack({ error: 'transport 없음' });
        await transport.connect({ dtlsParameters });
        ack({ ok: true });
      },
    );

    socket.on(
      'produce',
      async (
        {
          transportId,
          kind,
          rtpParameters,
          appData,
        }: {
          transportId: string;
          kind: MediaKind;
          rtpParameters: RtpParameters;
          appData?: { source?: string };
        },
        ack,
      ) => {
        if (!room || !peer) return ack({ error: '방에 입장하지 않았습니다' });
        const transport = peer.transports.get(transportId);
        if (!transport) return ack({ error: 'transport 없음' });
        const producer = await transport.produce({ kind, rtpParameters, appData });
        peer.producers.set(producer.id, producer);
        socket.to(`room:${room.code}`).emit('producer:new', {
          producerId: producer.id,
          peerId: socket.id,
          username: peer.username,
          kind,
          source: appData?.source ?? 'camera',
        });
        ack({ id: producer.id });
      },
    );

    /** producer 종료 (화면공유 중단 등) — consumer들에게 producer:closed 전파 */
    socket.on('producer:close', ({ producerId }: { producerId: string }, ack) => {
      const producer = peer?.producers.get(producerId);
      if (!producer) return ack?.({ error: 'producer 없음' });
      producer.close(); // consumer.on('producerclose')가 각 수신자에게 전파
      peer!.producers.delete(producerId);
      ack?.({ ok: true });
    });

    /** 호스트: 회의 잠금/해제 */
    socket.on('room:lock', ({ locked }: { locked: boolean }, ack) => {
      if (!room || !peer) return ack?.({ error: '방에 입장하지 않았습니다' });
      if (peer.userId !== room.hostUserId) return ack?.({ error: '호스트만 가능합니다' });
      room.locked = !!locked;
      io.to(`room:${room.code}`).emit('room:locked', { locked: room.locked });
      ack?.({ ok: true });
    });

    /** 호스트: 참가자 강퇴 */
    socket.on('room:kick', ({ peerId }: { peerId: string }, ack) => {
      if (!room || !peer) return ack?.({ error: '방에 입장하지 않았습니다' });
      if (peer.userId !== room.hostUserId) return ack?.({ error: '호스트만 가능합니다' });
      const target = io.sockets.sockets.get(peerId);
      if (!target || !room.peers.has(peerId)) return ack?.({ error: '대상이 없습니다' });
      target.emit('room:kicked');
      // 알림 패킷 플러시 후 끊기 — disconnect 핸들러가 transport 정리 + peer:left 전파
      setTimeout(() => target.disconnect(true), 200);
      ack?.({ ok: true });
    });

    /** 회의 내 채팅 — 같은 방 전체에 브로드캐스트 */
    socket.on('chat:send', ({ text }: { text: string }) => {
      if (!room || !peer || !text?.trim()) return;
      io.to(`room:${room.code}`).emit('chat:message', {
        from: peer.username,
        text: text.slice(0, 2000),
        ts: Date.now(),
      });
    });

    socket.on(
      'consume',
      async (
        {
          transportId,
          producerId,
          rtpCapabilities,
        }: { transportId: string; producerId: string; rtpCapabilities: RtpCapabilities },
        ack,
      ) => {
        if (!room || !peer) return ack({ error: '방에 입장하지 않았습니다' });
        if (!room.router.canConsume({ producerId, rtpCapabilities })) {
          return ack({ error: 'consume 불가 (코덱 불일치)' });
        }
        const transport = peer.transports.get(transportId);
        if (!transport) return ack({ error: 'transport 없음' });
        const consumer = await transport.consume({
          producerId,
          rtpCapabilities,
          paused: true, // 클라이언트 준비 후 resume
        });
        peer.consumers.set(consumer.id, consumer);
        consumer.on('producerclose', () => {
          peer?.consumers.delete(consumer.id);
          socket.emit('producer:closed', { producerId, consumerId: consumer.id });
        });
        ack({
          id: consumer.id,
          producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        });
      },
    );

    socket.on('consumer:resume', async ({ consumerId }: { consumerId: string }, ack) => {
      const consumer = peer?.consumers.get(consumerId);
      if (!consumer) return ack({ error: 'consumer 없음' });
      await consumer.resume();
      ack({ ok: true });
    });

    socket.on('disconnect', () => {
      if (!room || !peer) return;
      for (const t of peer.transports.values()) t.close();
      room.peers.delete(socket.id);
      socket.to(`room:${room.code}`).emit('peer:left', { peerId: socket.id });
      closeRoomIfEmpty(room);
    });
  });
}
