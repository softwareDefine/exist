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
  username: string;
  transports: Map<string, WebRtcTransport>;
  producers: Map<string, Producer>;
  consumers: Map<string, Consumer>;
}

interface Room {
  code: string;
  router: Router;
  peers: Map<string, Peer>;
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
    room = { code, router, peers: new Map() };
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
        peer = {
          socketId: socket.id,
          username: socket.data.username as string,
          transports: new Map(),
          producers: new Map(),
          consumers: new Map(),
        };
        room.peers.set(socket.id, peer);
        await socket.join(`room:${code}`);

        // 기존 참가자의 producer 목록 (신규 입장자가 consume)
        const producers: { producerId: string; peerId: string; username: string; kind: MediaKind }[] = [];
        for (const p of room.peers.values()) {
          if (p.socketId === socket.id) continue;
          for (const producer of p.producers.values()) {
            producers.push({
              producerId: producer.id,
              peerId: p.socketId,
              username: p.username,
              kind: producer.kind,
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
        }: { transportId: string; kind: MediaKind; rtpParameters: RtpParameters },
        ack,
      ) => {
        if (!room || !peer) return ack({ error: '방에 입장하지 않았습니다' });
        const transport = peer.transports.get(transportId);
        if (!transport) return ack({ error: 'transport 없음' });
        const producer = await transport.produce({ kind, rtpParameters });
        peer.producers.set(producer.id, producer);
        socket.to(`room:${room.code}`).emit('producer:new', {
          producerId: producer.id,
          peerId: socket.id,
          username: peer.username,
          kind,
        });
        ack({ id: producer.id });
      },
    );

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
