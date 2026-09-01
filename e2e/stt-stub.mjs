// Local stand-in for OpenAI during E2E.
//  - ws://…/realtime : mimics the Realtime transcription session (shapes from
//    server/src/__tests__/stt-live-stream.test.ts) → the app renders source:'live' captions.
//  - http://…/v1/*   : answers 500 immediately so the openai SDK gives up after its retries and
//    the server falls back to rule-based answers/recaps. /health is the readiness probe.
import http from 'node:http';
import { WebSocketServer } from 'ws';

const port = Number(process.env.STT_STUB_PORT ?? 4598);
const TRANSCRIPT = '검사 설비 온도 세팅은 오늘 중으로 조정하겠습니다';

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"ok":true}');
  }
  // Drain then fail — keeps the SDK from hanging on an unread body.
  req.on('data', () => {});
  req.on('end', () => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'e2e stub: no LLM', type: 'server_error' } }));
  });
});

const wss = new WebSocketServer({ server, path: '/realtime' });
wss.on('connection', (sock) => {
  let appends = 0;
  let open = false;
  sock.send(JSON.stringify({ type: 'session.created', session: {} }));
  sock.on('message', (raw) => {
    let e;
    try {
      e = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (e.type === 'session.update') {
      // Per-meeting kill switch: a meeting whose glossary contains this marker gets its live
      // session refused (→ the client falls back to chunk uploads). Parallel-safe, no global state.
      if (JSON.stringify(e.session ?? {}).includes('E2E_REFUSE_LIVE')) {
        sock.send(JSON.stringify({ type: 'error', error: { message: 'e2e: live transcription refused', type: 'invalid_request_error' } }));
        sock.close();
        return;
      }
      sock.send(JSON.stringify({ type: 'session.updated', session: e.session }));
      return;
    }
    if (e.type === 'input_audio_buffer.append') {
      appends++;
      // Stream a partial after a little audio, finalize a bit later — mirrors a real session.
      if (appends === 3) {
        open = true;
        sock.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', delta: '검사 설비 온도' }));
      } else if (appends === 6) {
        sock.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', delta: ' 세팅은' }));
      } else if (appends >= 12 && open) {
        open = false;
        appends = 0;
        sock.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: TRANSCRIPT }));
      }
      return;
    }
    if (e.type === 'input_audio_buffer.commit' && open) {
      open = false;
      appends = 0;
      sock.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: TRANSCRIPT }));
    }
  });
});

server.listen(port, '127.0.0.1', () => console.log(`[e2e-stub] listening on ${port}`));
