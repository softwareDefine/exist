# exist

재택근무 플랫폼 — 완전한 대면근무의 대체.

AI agent가 일정·알림·작업 진척도·to-do를 **nowbar**(상단 고정 상태바)로 보여주고,
실시간 공동작업과 화상회의가 가능한 플랫폼.

## 구조

```
client/   React + Vite + TypeScript
server/   Node + Express + TypeScript
docs/     기획 PDF, 디자인 페이지 렌더링 (git 제외)
```

## 핵심 스택

| 영역 | 기술 |
|---|---|
| 프론트 | React, Vite, TypeScript, zustand, react-router |
| 백엔드 | Express, Socket.IO, better-sqlite3 (→ Postgres 예정) |
| 화상회의 | mediasoup (SFU 직접 구현) |
| 동시편집 | tldraw + Yjs |
| AI agent | Claude API — 목표·투두 상태 분석 → nowbar 알림 생성 |

## 개발

```bash
# 서버
cd server && npm run dev   # http://localhost:4000

# 클라이언트
cd client && npm run dev   # http://localhost:5173
```

## AI agent

`server/.env`에 `ANTHROPIC_API_KEY`를 넣으면 Claude(claude-opus-4-8)가 일정·투두 상태를
분석해 nowbar 브리핑을 생성한다. 키가 없으면 규칙 기반 폴백으로 동작한다.
회의 시작 30분/10분 전 리마인더는 Socket.IO 푸시(`agent:notify`)로 전달된다.

## 빌드 로드맵

1. ✅ 스켈레톤 (로그인 + 대시보드 레이아웃 + nowbar)
2. ✅ 투두/일정 CRUD + nowbar 카운트다운
3. ✅ SFU 화상회의 (mediasoup)
4. ✅ AI agent (브리핑 + 회의 리마인더 푸시)
5. ✅ 동시편집 작업공간 (tldraw 공식 sync)

다음: 회의실 권한, 화면공유, 회의 내 채팅, 보안 강화(rate limit·세션 만료), 배포 준비
