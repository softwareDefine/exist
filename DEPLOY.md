# exist 배포 가이드

## 요구사항

- Node.js 22+
- 공인 IP가 있는 리눅스 서버 (또는 Windows)
- 도메인 + HTTPS — **필수**: 브라우저 getUserMedia(카메라/마이크)는
  localhost 외에는 HTTPS에서만 동작한다.

## 빌드

```bash
cd client && npm ci && npm run build   # → client/dist
cd ../server && npm ci && npm run build  # → server/dist
```

루트에서 한 번에: `npm run build`

## 환경변수 (server/.env)

| 변수 | 설명 | 예시 |
|---|---|---|
| `NODE_ENV` | `production`이면 client/dist 정적 서빙 + CORS 비활성(동일 오리진) | `production` |
| `PORT` | HTTP 포트 | `4000` |
| `ANNOUNCED_IP` | **필수(배포 시)** — mediasoup이 클라이언트에 알려줄 서버 공인 IP | `203.0.113.10` |
| `RTC_MIN_PORT` / `RTC_MAX_PORT` | WebRTC UDP/TCP 포트 범위 | `40000` / `40100` |
| `OPENAI_API_KEY` | AI(브리핑·recap·총무·인사이트)용 OpenAI 키 (없으면 규칙 기반 폴백) | `sk-...` |
| `OPENAI_MODEL` | AI 모델 (기본 `gpt-4o-mini`) | `gpt-4o-mini` |
| `LOCAL_IP` | 같은 LAN 통화용 사설 IP (헤어핀 NAT 회피) | `192.168.0.82` |
| `MEDIA_PREFER_TCP` | `1`이면 ICE 우선순위를 TCP로 (Docker/Colima 등 UDP 차단 환경) | `1` |
| `DATA_DIR` | DB·ydocs·uploads 저장 루트 (미설정 시 `server/`) | `/data` |
| `RUNNER_URL` / `CODE_EXEC_ENABLED` | 격리 코드실행 컨테이너 주소 / git push 게이트 | `http://runner:5000` / `0` |
| `CLIENT_ORIGIN` | 개발 모드 CORS 오리진 (프로덕션 동일 오리진이면 불필요) | — |

## 방화벽

- TCP 443 (HTTPS, 리버스 프록시)
- **UDP 40000–40100** (mediasoup RTC — 이거 안 열면 영상이 안 감)
- TCP 40000–40100 (UDP 차단 환경 폴백)

## 실행

```bash
NODE_ENV=production node server/dist/index.js
# 또는 루트에서: npm run start (Windows) / npm run start:unix
```

프로세스 매니저 권장: `pm2 start server/dist/index.js --name exist`

## HTTPS 리버스 프록시 (Caddy 예시 — 자동 인증서)

```
exist.example.com {
    reverse_proxy localhost:4000
}
```

Caddy는 WebSocket(/socket.io, /sync)을 자동 프록시한다.
nginx 사용 시 `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";` 필요.

## 데이터 (백업 대상)

`DATA_DIR`(도커는 `/data` 볼륨, 기본은 `server/`) 아래 전부:

- `exist.sqlite` — 사용자/회의/투두/작업공간 메타
- `ydocs/` — Yjs 문서 상태 (문서/코드/시트/슬라이드/캔버스)
- `uploads/` — 업로드 에셋

## 알려진 제약

- SQLite 단일 파일 DB — 동시 사용자 수백 명 규모까지는 충분, 그 이상은 Postgres 전환
- mediasoup 워커 1개 — CPU 코어당 1워커로 확장 가능 (sfu.ts)
