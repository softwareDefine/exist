# exist

재택근무 플랫폼 — **완전한 대면근무의 대체**.

AI agent가 일정·알림·작업 진척도·to-do를 **nowbar**(상단 고정 상태바)로 보여주고,
실시간 공동작업과 화상회의가 가능한 플랫폼.

## 핵심 개념

- **nowbar** — 갤럭시 One UI Now Bar에서 영감받은 상단 고정 바.
  3가지 모드 카드(일정 / 투두 / 타임라인)를 스크롤·점 클릭으로 전환하고,
  hover하면 카드가 그대로 확장되어 월 캘린더·할 일 관리·진행 타임라인 + AI 브리핑을 보여준다.
  일정을 클릭하면 곧바로 해당 회의 공간이 열린다.
- **회의 = 작업공간** — 회의를 클릭하면 우측 패널에 회의 탭이 열린다.
  탭 안은 서브탭 구조: **대시보드(메인)** · 통화 · 채팅 · 캔버스.
  - 대시보드: 코드 복사, 일정, 라이브 통화 인원, 참가자 접속 상태, 최근 채팅 미리보기
  - 통화: mediasoup SFU 화상회의. 다른 서브탭으로 가도 끊기지 않고 우하단 미니 PiP로 유지,
    전체화면 확대/축소도 재연결 없이 동작
  - 채팅: DB 영속, 통화 채팅과 같은 스트림, 비활성 탭엔 안읽음 배지
  - 캔버스: 회의마다 자동으로 생기는 Excalidraw 실시간 공동편집 보드
- **다이렉트 메시지(DM)** — 대시보드 홈 화면의 1:1 메시지.
  조직 컨텍스트면 멤버 목록에서 바로, 개인이면 이름 검색으로 새 대화를 시작한다.
  실시간 송수신(Socket.IO `dm:message`)·안읽음 배지·읽음 처리, 우하단 플로팅 대화창.
  대화방은 조직별로 분리되며(개인 DM은 조직 무관), 회의 탭을 열면 홈과 함께 가려진다.
- **AI agent** — 일정·투두·라이브 통화 상황을 분석해 nowbar에 한 줄 브리핑,
  회의 30/10분 전 푸시 리마인더.

## 구조

```
client/   React + Vite + TypeScript
server/   Node + Express + TypeScript
docs/     기획 PDF, 디자인 렌더링 (git 제외)
```

## 핵심 스택

| 영역 | 기술 |
|---|---|
| 프론트 | React, Vite, TypeScript, zustand, react-router |
| 백엔드 | Express 5, Socket.IO, better-sqlite3 (→ Postgres 예정) |
| 화상회의 | mediasoup (SFU 직접 구현) — 카메라/다중 화면공유/호스트 잠금·강퇴 |
| 동시편집 | Yjs + 커스텀 y-websocket 서버 (`/yjs/<room>`) — TipTap 문서·CodeMirror 코드·시트·슬라이드·Excalidraw 캔버스 |
| AI agent | OpenAI API (`gpt-4o-mini` 기본, `OPENAI_MODEL`로 교체) + 규칙 기반 폴백 |
| 인증 | scrypt 해시, Bearer 세션(30일), 복구 코드 방식 비밀번호 재설정 |

## 개발

```bash
# 서버
cd server && npm run dev   # http://localhost:4000

# 클라이언트
cd client && npm run dev   # http://localhost:5173 (API·WS는 4000으로 프록시)
```

테스트 계정 없이 `/register`에서 가입 — 가입 시 발급되는 **복구 코드**(XXXX-XXXX-XXXX-XXXX)가
비밀번호 재설정 수단이므로 보관 필수 (이메일 발송 없음).

## AI agent

`server/.env`에 `OPENAI_API_KEY`를 넣으면 AI가 일정·투두·라이브 통화 상황을
분석해 nowbar 브리핑을 생성한다. 키가 없으면 규칙 기반 폴백으로 동작한다.
브리핑 외에도 통화 recap(결정·할 일 추출), `@AI` 총무 응답, 팀 인사이트가 같은 키를 쓴다.

- 브리핑: `GET /api/agent/brief` — 2분 캐시, 통화 인원 변동 시 즉시 재생성
- 리마인더: 회의 30분/10분 전 Socket.IO 푸시(`agent:notify`) → 토스트

## 프로덕션

```bash
npm run build              # client + server 빌드
NODE_ENV=production node server/dist/index.js   # 정적 서빙 + SPA 폴백 포함
```

화상회의는 HTTPS 필수(getUserMedia). 배포 절차·방화벽(UDP 40000-40100)·백업 대상은
[DEPLOY.md](DEPLOY.md) 참고.

## 완료된 로드맵

1. ✅ 스켈레톤 (로그인 + 대시보드 + nowbar)
2. ✅ 투두/일정 CRUD + nowbar 카운트다운
3. ✅ SFU 화상회의 (다자 중계, 다중 화면공유, 카메라 꺼짐 플레이스홀더, 호스트 잠금·강퇴)
4. ✅ AI agent (브리핑 + 리마인더 + 라이브 통화 인지)
5. ✅ 동시편집 (Yjs — 문서/코드/시트/슬라이드/캔버스, 워크스페이스·회의)
6. ✅ 회의 허브 (대시보드/통화/채팅/캔버스 서브탭, 미니 PiP, 무중단 전체화면)
7. ✅ 계정 (가입, 복구 코드 재설정, 아바타, 비밀번호 변경, rate limit)
8. ✅ 프로덕션 빌드·보안 헤더·모바일 반응형
9. ✅ 다이렉트 메시지(DM) — 대시보드 홈, 조직별/개인 1:1, 실시간·안읽음·읽음 처리

## 남은 백로그

녹화, Postgres 전환
