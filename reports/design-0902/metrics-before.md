# exist 디자인 계측 리포트 — 2026-09-02

실측 기반: Playwright(Chromium) 실 DOM `getComputedStyle` 측정. 뷰포트 4단계: 모바일 390×844 / 태블릿 768×1024 / 노트북 1366×768 / 데스크탑 1920×1080.

심각도 기준: **Major** = 대비 < 3:1, 모바일 가로 스크롤. **Minor** = 대비 < 기준(4.5:1, 큰 텍스트 3:1), 모바일 터치 타겟 < 44×44. **Cosmetic** = 모바일 본문 폰트 < 16px, 시각적 1순위 동률.

## 요약 — 화면 × 뷰포트 위반 카운트

표기 — 모바일: `대비Major/대비Minor · 터치타겟<44 · 본문<16px · 가로스크롤` / 그 외: `대비Major/대비Minor · 가로스크롤`

| 화면 | mobile | tablet | laptop | desktop |
|---|---|---|---|---|
| login | 3/0 · 2 · 0 · 0 | 3/0 · 0 | 3/0 · 0 | 3/0 · 0 |
| home-personal | 30/17 · 41 · 9 · 0 | 30/16 · 0 | 30/16 · 0 | 30/16 · 0 |
| hub-chat | 46/7 · 9 · 5 · 0 | 31/1 · 0 | 31/1 · 0 | 31/1 · 0 |
| schedule-week | 62/8 · 52 · 6 · 0 | 63/2 · 0 | 64/2 · 0 | 64/2 · 0 |
| ledger | 47/12 · 17 · 7 · 0 | 31/6 · 0 | 31/6 · 0 | 31/6 · 0 |
| files | 44/9 · 16 · 6 · 0 | 32/2 · 0 | 32/2 · 0 | 32/2 · 0 |
| hub-settings | 45/9 · 18 · 11 · 0 | 29/3 · 0 | 29/3 · 0 | 29/3 · 0 |
| home-org | 17/12 · 34 · 1 · 0 | 18/12 · 0 | 18/12 · 0 | 18/12 · 0 |
| orgchart | 24/3 · 6 · 0 · 0 | 24/3 · 0 | 24/3 · 0 | 24/3 · 0 |

## 가로 오버플로
- 없음 — 모든 화면·뷰포트에서 `scrollWidth ≤ clientWidth`.

## login
### mobile — 텍스트 노드 3개 스캔
**대비 위반 3건** (mobile):
  - [Major] `form > button.submit` "로그인" — 2.25:1 (기준 4.5:1, 16px w600, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.meta > a` "아이디/비번을 잊어버리셨나요?" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.meta > a` "회원가입" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
**[Minor] 44px 미만 터치 타겟 2건**:
  - `div.meta > a` "회원가입" — 46×15px
  - `div.meta > a` "아이디/비번을 잊어버리셨나요?" — 162×15px
시각적 1순위 유일: 16px w600 "로그인"

### tablet — 텍스트 노드 3개 스캔
**대비 위반 3건** (tablet):
  - [Major] `form > button.submit` "로그인" — 2.25:1 (기준 4.5:1, 16px w600, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.meta > a` "아이디/비번을 잊어버리셨나요?" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.meta > a` "회원가입" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
시각적 1순위 유일: 16px w600 "로그인"

### laptop — 텍스트 노드 3개 스캔
**대비 위반 3건** (laptop):
  - [Major] `form > button.submit` "로그인" — 2.25:1 (기준 4.5:1, 16px w600, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.meta > a` "아이디/비번을 잊어버리셨나요?" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.meta > a` "회원가입" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
시각적 1순위 유일: 16px w600 "로그인"

### desktop — 텍스트 노드 3개 스캔
**대비 위반 3건** (desktop):
  - [Major] `form > button.submit` "로그인" — 2.25:1 (기준 4.5:1, 16px w600, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.meta > a` "아이디/비번을 잊어버리셨나요?" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.meta > a` "회원가입" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
시각적 1순위 유일: 16px w600 "로그인"

## home-personal
### mobile — 텍스트 노드 121개 스캔
**대비 위반 47건** (mobile):
  - [Major] `span.marquee-inner > b` "시작" — 2.06:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `div > span` "통화 정리" — 2.08:1 (기준 4.5:1, 11px w700, rgb(33, 200, 24) on rgb(234,251,232))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `aside > button.drawer-add` "+" — 2.25:1 (기준 3:1, 24px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div > span.pd-ack-count` "2" — 2.25:1 (기준 4.5:1, 12px w800, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div > span.pd-ack-count` "1" — 2.25:1 (기준 4.5:1, 12px w800, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.pd-sent-row.done > span.pd-sent-done` "전원 확인" — 2.25:1 (기준 4.5:1, 12px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div > button` "3" — 2.25:1 (기준 4.5:1, 12.5px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div > span` "채팅" — 2.58:1 (기준 4.5:1, 11px w700, rgb(154, 154, 154) on rgb(244,245,247))
  - [Major] `div.nowbar-card.hidden > div.nb-next-empty` "진행 중인 그룹이 없어요" — 2.81:1 (기준 4.5:1, 14px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.nb-notif-lead > span.nb-notif-time` "방금" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div > span.pd-inbox-hint` "비우면 오늘 준비 끝" — 2.81:1 (기준 4.5:1, 12px w500, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.pd-act-row > span.pd-act-badge` "결정" — 2.81:1 (기준 4.5:1, 11.5px w700, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.pd-act-main > span.pd-act-sub` "주간 품질 회의 · 9. 3. 회의" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - …외 32건 (metrics-raw.json 참조)
**[Minor] 44px 미만 터치 타겟 41건**:
  - `div > button` "" — 24×24px
  - `div > button` "" — 24×24px
  - `div > button` "1" — 37×37px
  - `div > button` "2" — 37×37px
  - `div > button` "3" — 37×37px
  - `div > button` "4" — 37×37px
  - `div > button` "5" — 37×37px
  - `div > button` "6" — 37×37px
  - `div > button` "7" — 37×37px
  - `div > button` "8" — 37×37px
  - `div > button` "9" — 37×37px
  - `div > button` "10" — 37×37px
  - `div > button` "11" — 37×37px
  - `div > button` "12" — 37×37px
  - `div > button` "13" — 37×37px
  - …외 26건
**[Cosmetic] 모바일 16px 미만 본문 9건**:
  - `span.pd-act-sub > span.pd-sent-missing` "— 미확인: 이주호, 김소희, 박민수" — 12px
  - `div.pd-act-main > span.pd-act-sub` "주간 품질 회의 · 팀 확인 3 / " — 12px
  - `span.marquee.dm-item-preview-text > span.marquee-inner.on` "결정 사항은 기록 탭에서 확인 눌러주" — 12px
  - `span.marquee.countdown > span.marquee-inner.on` "'주간 품질 회의'에 일정 추가 — " — 14px
  - `span.marquee.pd-act-title > span.marquee-inner.on` "『 방열판 설계 변경 공지 』 열람 " — 14px
  - `span.marquee.pd-act-title > span.marquee-inner.on` "🔴 방열판 두께를 3mm로 변경한다" — 14px
  - `span.marquee.pd-act-title > span.marquee-inner.on` "주간 정기 점검을 목요일 오전으로 옮" — 14px
  - `span.marquee.pd-act-title > span.marquee-inner.on` "주간 정기 점검을 목요일 오전으로 옮" — 14px
  - `span.marquee.pd-catchup-text > span.marquee-inner.on` "통화 정리 — 주간 품질 회의 — 방" — 14px
**[Cosmetic] 시각적 1순위 동률 4개** (17px w900): "1건", "0건", "1건", "1건"
(배경 이미지/그라데이션 때문에 대비 미계산 17개 노드)

### tablet — 텍스트 노드 137개 스캔
**대비 위반 46건** (tablet):
  - [Major] `span.marquee-inner > b` "시작" — 2.06:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `aside > div.section-title` "최근 그룹" — 2.25:1 (기준 3:1, 21px w900, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div > span.pd-ack-count` "2" — 2.25:1 (기준 4.5:1, 12px w800, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div > span.pd-ack-count` "1" — 2.25:1 (기준 4.5:1, 12px w800, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.pd-sent-row.done > span.pd-sent-done` "전원 확인" — 2.25:1 (기준 4.5:1, 12px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div > button` "3" — 2.25:1 (기준 4.5:1, 12.5px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.nowbar-card.hidden > div.nb-next-empty` "진행 중인 그룹이 없어요" — 2.81:1 (기준 4.5:1, 14px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.nb-notif-lead > span.nb-notif-time` "방금" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div > span.pd-inbox-hint` "비우면 오늘 준비 끝" — 2.81:1 (기준 4.5:1, 12px w500, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.pd-act-row > span.pd-act-badge` "결정" — 2.81:1 (기준 4.5:1, 11.5px w700, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.pd-act-main > span.pd-act-sub` "주간 품질 회의 · 9. 3. 회의" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - …외 31건 (metrics-raw.json 참조)
시각적 1순위 유일: 24px w900 "그룹 입장"
(배경 이미지/그라데이션 때문에 대비 미계산 23개 노드)

### laptop — 텍스트 노드 137개 스캔
**대비 위반 46건** (laptop):
  - [Major] `span.marquee-inner > b` "시작" — 2.06:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `aside > div.section-title` "최근 그룹" — 2.25:1 (기준 3:1, 21px w900, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div > span.pd-ack-count` "2" — 2.25:1 (기준 4.5:1, 12px w800, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div > span.pd-ack-count` "1" — 2.25:1 (기준 4.5:1, 12px w800, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.pd-sent-row.done > span.pd-sent-done` "전원 확인" — 2.25:1 (기준 4.5:1, 12px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div > button` "3" — 2.25:1 (기준 4.5:1, 12.5px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.nowbar-card.hidden > div.nb-next-empty` "진행 중인 그룹이 없어요" — 2.81:1 (기준 4.5:1, 14px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.nb-notif-lead > span.nb-notif-time` "방금" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div > span.pd-inbox-hint` "비우면 오늘 준비 끝" — 2.81:1 (기준 4.5:1, 12px w500, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.pd-act-row > span.pd-act-badge` "결정" — 2.81:1 (기준 4.5:1, 11.5px w700, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.pd-act-main > span.pd-act-sub` "주간 품질 회의 · 9. 3. 회의" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - …외 31건 (metrics-raw.json 참조)
**[Cosmetic] 시각적 1순위 동률 4개** (26px w900): "1건", "0건", "1건", "1건"
(배경 이미지/그라데이션 때문에 대비 미계산 23개 노드)

### desktop — 텍스트 노드 137개 스캔
**대비 위반 46건** (desktop):
  - [Major] `span.marquee-inner > b` "시작" — 2.06:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `aside > div.section-title` "최근 그룹" — 2.25:1 (기준 3:1, 21px w900, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div > span.pd-ack-count` "2" — 2.25:1 (기준 4.5:1, 12px w800, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div > span.pd-ack-count` "1" — 2.25:1 (기준 4.5:1, 12px w800, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.pd-sent-row.done > span.pd-sent-done` "전원 확인" — 2.25:1 (기준 4.5:1, 12px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div > button` "3" — 2.25:1 (기준 4.5:1, 12.5px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.nowbar-card.hidden > div.nb-next-empty` "진행 중인 그룹이 없어요" — 2.81:1 (기준 4.5:1, 14px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.nb-notif-lead > span.nb-notif-time` "1분 전" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div > span.pd-inbox-hint` "비우면 오늘 준비 끝" — 2.81:1 (기준 4.5:1, 12px w500, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.pd-act-row > span.pd-act-badge` "결정" — 2.81:1 (기준 4.5:1, 11.5px w700, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.pd-act-main > span.pd-act-sub` "주간 품질 회의 · 9. 3. 회의" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - …외 31건 (metrics-raw.json 참조)
**[Cosmetic] 시각적 1순위 동률 4개** (26px w900): "1건", "0건", "1건", "1건"
(배경 이미지/그라데이션 때문에 대비 미계산 23개 노드)

## hub-chat
### mobile — 텍스트 노드 101개 스캔
**대비 위반 53건** (mobile):
  - [Major] `span.marquee-inner > b` "시작" — 2.06:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `button.hub-channel-item.active > span.hub-channel-hash` "#" — 2.08:1 (기준 4.5:1, 13.5px w700, rgb(33, 200, 24) on rgb(234,251,232))
  - [Major] `span.marquee.hub-channel-name > span.marquee-inner` "일반" — 2.08:1 (기준 4.5:1, 13.5px w600, rgb(33, 200, 24) on rgb(234,251,232))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `aside > button.drawer-add` "+" — 2.25:1 (기준 3:1, 24px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-section-title > button.hub-recap-run` "지금 정리하기" — 2.25:1 (기준 4.5:1, 12px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-followup > button.hub-followup-btn` "리마인드" — 2.25:1 (기준 4.5:1, 12px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.hub-recap-next.suggest > span.hub-recap-next-label` "다음 회의" — 2.25:1 (기준 4.5:1, 12.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-recap-next.suggest > button.hub-recap-next-btn` "겹치는 시간 찾기" — 2.25:1 (기준 4.5:1, 12px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `section.hub-section.pipe-card > button.pipe-cta` "일정 잡기" — 2.25:1 (기준 4.5:1, 12.5px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `section.hub-section.pipe-card > div.pipe-step.now` "지금 · 실행 중" — 2.25:1 (기준 4.5:1, 12.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `form.hub-todo-add > button` "추가" — 2.25:1 (기준 4.5:1, 13px w600, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.hub-section-title.clickable > b` "3" — 2.25:1 (기준 4.5:1, 14px w900, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.chat-line > div.chat-bubble` "이번 주 방열판 라인 점검 일정 공유" — 2.25:1 (기준 4.5:1, 14px w400, rgb(255, 255, 255) on rgb(33,200,24))
  - …외 38건 (metrics-raw.json 참조)
**[Minor] 44px 미만 터치 타겟 9건**:
  - `button.hub-channel-item.active > span.hub-channel-notify.mode-mention` "" — 19×13px
  - `div.hub-channels-head > button.hub-channels-add` "＋" — 27×19px
  - `div.hub-m-back > button` "" — 40×28px
  - `form.hub-todo-add > button` "추가" — 53×34px
  - `div.hub-recap-next.suggest > button.hub-recap-next-btn` "겹치는 시간 찾기" — 122×23px
  - `section.hub-section.pipe-card > button.pipe-cta` "일정 잡기" — 98×31px
  - `div.hub-channels-list > button.hub-channel-item.active` "#일반" — 108×30px
  - `section.hub-section.pa-ros > div.hub-section-title.clickable` "참가자 3🐧🐧🐧" — 160×22px
  - `section.hub-section.pipe-card > button.pipe-more` "회의 정리 다시 보기" — 130×31px
**[Cosmetic] 모바일 16px 미만 본문 5건**:
  - `div.hub-followup > span.hub-followup-text` "' 방열판 두께를 3mm로 변경한다 " — 12.5px
  - `ul.hub-recap-decisions > li` "주간 정기 점검을 목요일 오전으로 옮" — 13px
  - `span.marquee.countdown > span.marquee-inner.on` "'주간 품질 회의'에 일정 추가 — " — 14px
  - `div.hub-recap-head > span.hub-recap-summary` "주간 품질 회의 — 방열판 라인 점검" — 14px
  - `span.marquee.hub-decision-text > span.marquee-inner.on` "주간 정기 점검을 목요일 오전으로 옮" — 14px
시각적 1순위 유일: 24px w600 "+"
(배경 이미지/그라데이션 때문에 대비 미계산 12개 노드)

### tablet — 텍스트 노드 71개 스캔
**대비 위반 32건** (tablet):
  - [Major] `span.marquee-inner > b` "시작" — 2.06:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `button.hub-channel-item.active > span.hub-channel-hash` "#" — 2.08:1 (기준 4.5:1, 13.5px w700, rgb(33, 200, 24) on rgb(234,251,232))
  - [Major] `span.marquee.hub-channel-name > span.marquee-inner` "일반" — 2.08:1 (기준 4.5:1, 13.5px w600, rgb(33, 200, 24) on rgb(234,251,232))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `aside > div.section-title` "최근 그룹" — 2.25:1 (기준 3:1, 21px w900, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `button.ws-tab.meeting > span.ws-tab-text` "주간 품질 회의" — 2.25:1 (기준 4.5:1, 15px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-tabs > button.hub-tab.active` "채팅" — 2.25:1 (기준 4.5:1, 14px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.chat-line > div.chat-bubble` "이번 주 방열판 라인 점검 일정 공유" — 2.25:1 (기준 4.5:1, 14px w400, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.chat-line > div.chat-bubble` "결정 사항은 기록 탭에서 확인 눌러주" — 2.25:1 (기준 4.5:1, 14px w400, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `form.hub-chat-input > button` "전송" — 2.25:1 (기준 4.5:1, 15px w600, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.chat-date > span` "오늘" — 2.46:1 (기준 4.5:1, 11px w600, rgb(154, 154, 154) on rgb(238,240,242))
  - [Major] `div.hub-channels-head > span` "채널" — 2.58:1 (기준 4.5:1, 12.5px w700, rgb(154, 154, 154) on rgb(244,245,247))
  - …외 17건 (metrics-raw.json 참조)
시각적 1순위 유일: 24px w900 "그룹 입장"
(배경 이미지/그라데이션 때문에 대비 미계산 10개 노드)

### laptop — 텍스트 노드 71개 스캔
**대비 위반 32건** (laptop):
  - [Major] `span.marquee-inner > b` "시작" — 2.06:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `button.hub-channel-item.active > span.hub-channel-hash` "#" — 2.08:1 (기준 4.5:1, 13.5px w700, rgb(33, 200, 24) on rgb(234,251,232))
  - [Major] `span.marquee.hub-channel-name > span.marquee-inner` "일반" — 2.08:1 (기준 4.5:1, 13.5px w600, rgb(33, 200, 24) on rgb(234,251,232))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `aside > div.section-title` "최근 그룹" — 2.25:1 (기준 3:1, 21px w900, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `button.ws-tab.meeting > span.ws-tab-text` "주간 품질 회의" — 2.25:1 (기준 4.5:1, 15px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-tabs > button.hub-tab.active` "채팅" — 2.25:1 (기준 4.5:1, 14px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.chat-line > div.chat-bubble` "이번 주 방열판 라인 점검 일정 공유" — 2.25:1 (기준 4.5:1, 14px w400, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.chat-line > div.chat-bubble` "결정 사항은 기록 탭에서 확인 눌러주" — 2.25:1 (기준 4.5:1, 14px w400, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `form.hub-chat-input > button` "전송" — 2.25:1 (기준 4.5:1, 15px w600, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.chat-date > span` "오늘" — 2.46:1 (기준 4.5:1, 11px w600, rgb(154, 154, 154) on rgb(238,240,242))
  - [Major] `div.hub-channels-head > span` "채널" — 2.58:1 (기준 4.5:1, 12.5px w700, rgb(154, 154, 154) on rgb(244,245,247))
  - …외 17건 (metrics-raw.json 참조)
시각적 1순위 유일: 24px w900 "그룹 입장"
(배경 이미지/그라데이션 때문에 대비 미계산 10개 노드)

### desktop — 텍스트 노드 71개 스캔
**대비 위반 32건** (desktop):
  - [Major] `span.marquee-inner > b` "시작" — 2.06:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `button.hub-channel-item.active > span.hub-channel-hash` "#" — 2.08:1 (기준 4.5:1, 13.5px w700, rgb(33, 200, 24) on rgb(234,251,232))
  - [Major] `span.marquee.hub-channel-name > span.marquee-inner` "일반" — 2.08:1 (기준 4.5:1, 13.5px w600, rgb(33, 200, 24) on rgb(234,251,232))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `aside > div.section-title` "최근 그룹" — 2.25:1 (기준 3:1, 21px w900, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `button.ws-tab.meeting > span.ws-tab-text` "주간 품질 회의" — 2.25:1 (기준 4.5:1, 15px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-tabs > button.hub-tab.active` "채팅" — 2.25:1 (기준 4.5:1, 14px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.chat-line > div.chat-bubble` "이번 주 방열판 라인 점검 일정 공유" — 2.25:1 (기준 4.5:1, 14px w400, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.chat-line > div.chat-bubble` "결정 사항은 기록 탭에서 확인 눌러주" — 2.25:1 (기준 4.5:1, 14px w400, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `form.hub-chat-input > button` "전송" — 2.25:1 (기준 4.5:1, 15px w600, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.chat-date > span` "오늘" — 2.46:1 (기준 4.5:1, 11px w600, rgb(154, 154, 154) on rgb(238,240,242))
  - [Major] `div.hub-channels-head > span` "채널" — 2.58:1 (기준 4.5:1, 12.5px w700, rgb(154, 154, 154) on rgb(244,245,247))
  - …외 17건 (metrics-raw.json 참조)
시각적 1순위 유일: 24px w900 "그룹 입장"
(배경 이미지/그라데이션 때문에 대비 미계산 10개 노드)

## schedule-week
### mobile — 텍스트 노드 123개 스캔
**대비 위반 70건** (mobile):
  - [Major] `span.marquee-inner > b` "시작" — 2.06:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `div.msched-event > span.msched-event-time` "오전 9:00~오후 12:00" — 2.06:1 (기준 4.5:1, 12px w600, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `div.msched-event > button.msched-event-link` "이 회의의 기록 — 결정 2 건" — 2.06:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `aside > button.drawer-add` "+" — 2.25:1 (기준 3:1, 24px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-section-title > button.hub-recap-run` "지금 정리하기" — 2.25:1 (기준 4.5:1, 12px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-followup > button.hub-followup-btn` "리마인드" — 2.25:1 (기준 4.5:1, 12px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.hub-recap-next.suggest > span.hub-recap-next-label` "다음 회의" — 2.25:1 (기준 4.5:1, 12.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-recap-next.suggest > button.hub-recap-next-btn` "겹치는 시간 찾기" — 2.25:1 (기준 4.5:1, 12px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `section.hub-section.pipe-card > button.pipe-cta` "일정 잡기" — 2.25:1 (기준 4.5:1, 12.5px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `section.hub-section.pipe-card > div.pipe-step.now` "지금 · 실행 중" — 2.25:1 (기준 4.5:1, 12.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `form.hub-todo-add > button` "추가" — 2.25:1 (기준 4.5:1, 13px w600, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.hub-section-title.clickable > b` "3" — 2.25:1 (기준 4.5:1, 14px w900, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `button.msched-wday-btn.sel > span.msched-wcol-num.today` "3" — 2.25:1 (기준 4.5:1, 14px w800, rgb(255, 255, 255) on rgb(33,200,24))
  - …외 55건 (metrics-raw.json 참조)
**[Minor] 44px 미만 터치 타겟 52건**:
  - `div.msched-event > button.msched-event-edit` "" — 24×16px
  - `div.msched-event > button.msched-event-del` "" — 25×19px
  - `div.msched-cal-head > button` "" — 35×26px
  - `div.msched-cal-head > button` "" — 35×26px
  - `div.msched-viewpill > button.vp-view` "" — 34×28px
  - `div.msched-viewpill > button.vp-plus` "" — 34×28px
  - `div.hub-m-back > button` "" — 40×28px
  - `form.hub-todo-add > button` "추가" — 53×34px
  - `div.msched-cal-head > button.msched-today-btn` "오늘" — 56×34px
  - `div.hub-recap-next.suggest > button.hub-recap-next-btn` "겹치는 시간 찾기" — 122×23px
  - `section.hub-section.pipe-card > button.pipe-cta` "일정 잡기" — 98×31px
  - `div.msched-event > button.msched-event-link` "이 회의의 기록 — 결정 2건" — 162×20px
  - `section.hub-section.pa-ros > div.hub-section-title.clickable` "참가자 3🐧🐧🐧" — 160×22px
  - `section.hub-section.pipe-card > button.pipe-more` "회의 정리 다시 보기" — 130×31px
  - `div.msched-week-col.sel > div.msched-week-cell` "" — 142×40px
  - …외 37건
**[Cosmetic] 모바일 16px 미만 본문 6건**:
  - `div.hub-followup > span.hub-followup-text` "' 방열판 두께를 3mm로 변경한다 " — 12.5px
  - `ul.hub-recap-decisions > li` "주간 정기 점검을 목요일 오전으로 옮" — 13px
  - `span.marquee.countdown > span.marquee-inner.on` "'주간 품질 회의'에 일정 추가 — " — 14px
  - `div.hub-recap-head > span.hub-recap-summary` "주간 품질 회의 — 방열판 라인 점검" — 14px
  - `span.marquee.hub-decision-text > span.marquee-inner.on` "주간 정기 점검을 목요일 오전으로 옮" — 14px
  - `span.marquee.hub-agenda-title > span.marquee-inner.on` "지난 결정 후속 점검 — 주간 정기 " — 14px
**[Cosmetic] 시각적 1순위 동률 3개** (24px w600): "+", "9월 3일 ~ 4일", "9월 3일 (목)"
(배경 이미지/그라데이션 때문에 대비 미계산 12개 노드)

### tablet — 텍스트 노드 114개 스캔
**대비 위반 65건** (tablet):
  - [Major] `span.marquee-inner > b` "시작" — 2.06:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `div.msched-event > span.msched-event-time` "오전 9:00~오후 12:00" — 2.06:1 (기준 4.5:1, 12px w600, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `div.msched-event > button.msched-event-link` "이 회의의 기록 — 결정 2 건" — 2.06:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `aside > div.section-title` "최근 그룹" — 2.25:1 (기준 3:1, 21px w900, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `button.ws-tab.meeting > span.ws-tab-text` "주간 품질 회의" — 2.25:1 (기준 4.5:1, 15px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-tabs > button.hub-tab.active` "일정" — 2.25:1 (기준 4.5:1, 14px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `button.msched-wday-btn.sel > span.msched-wcol-num.today` "3" — 2.25:1 (기준 4.5:1, 14px w800, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.msched-add-actions > button.msched-add-btn` "일정 추가" — 2.25:1 (기준 4.5:1, 14px w600, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `span.msched-se-group > span.msched-se-label` "시작" — 2.58:1 (기준 4.5:1, 11.5px w700, rgb(154, 154, 154) on rgb(244,245,247))
  - [Major] `div.msched-add-remind.msched-se > span.msched-times-sep` "~" — 2.58:1 (기준 4.5:1, 10px w600, rgb(154, 154, 154) on rgb(244,245,247))
  - [Major] `span.msched-se-group > span.msched-se-label` "종료" — 2.58:1 (기준 4.5:1, 11.5px w700, rgb(154, 154, 154) on rgb(244,245,247))
  - …외 50건 (metrics-raw.json 참조)
시각적 1순위 유일: 24px w900 "그룹 입장"
(배경 이미지/그라데이션 때문에 대비 미계산 10개 노드)

### laptop — 텍스트 노드 115개 스캔
**대비 위반 66건** (laptop):
  - [Major] `span.marquee-inner > b` "시작" — 2.06:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `div.msched-event > span.msched-event-time` "오전 9:00~오후 12:00" — 2.06:1 (기준 4.5:1, 12px w600, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `div.msched-event > button.msched-event-link` "이 회의의 기록 — 결정 2 건" — 2.06:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `aside > div.section-title` "최근 그룹" — 2.25:1 (기준 3:1, 21px w900, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `button.ws-tab.meeting > span.ws-tab-text` "주간 품질 회의" — 2.25:1 (기준 4.5:1, 15px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-tabs > button.hub-tab.active` "일정" — 2.25:1 (기준 4.5:1, 14px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `button.msched-wday-btn.sel > span.msched-wcol-num.today` "3" — 2.25:1 (기준 4.5:1, 14px w800, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.msched-add-actions > button.msched-add-btn` "일정 추가" — 2.25:1 (기준 4.5:1, 14px w600, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.msched-event > span.msched-event-author` "이주호" — 2.58:1 (기준 4.5:1, 11px w600, rgb(154, 154, 154) on rgb(244,245,247))
  - [Major] `span.msched-se-group > span.msched-se-label` "시작" — 2.58:1 (기준 4.5:1, 11.5px w700, rgb(154, 154, 154) on rgb(244,245,247))
  - [Major] `div.msched-add-remind.msched-se > span.msched-times-sep` "~" — 2.58:1 (기준 4.5:1, 10px w600, rgb(154, 154, 154) on rgb(244,245,247))
  - …외 51건 (metrics-raw.json 참조)
시각적 1순위 유일: 24px w900 "그룹 입장"
(배경 이미지/그라데이션 때문에 대비 미계산 10개 노드)

### desktop — 텍스트 노드 115개 스캔
**대비 위반 66건** (desktop):
  - [Major] `span.marquee-inner > b` "시작" — 2.06:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `div.msched-event > span.msched-event-time` "오전 9:00~오후 12:00" — 2.06:1 (기준 4.5:1, 12px w600, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `div.msched-event > button.msched-event-link` "이 회의의 기록 — 결정 2 건" — 2.06:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `aside > div.section-title` "최근 그룹" — 2.25:1 (기준 3:1, 21px w900, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `button.ws-tab.meeting > span.ws-tab-text` "주간 품질 회의" — 2.25:1 (기준 4.5:1, 15px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-tabs > button.hub-tab.active` "일정" — 2.25:1 (기준 4.5:1, 14px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `button.msched-wday-btn.sel > span.msched-wcol-num.today` "3" — 2.25:1 (기준 4.5:1, 14px w800, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.msched-add-actions > button.msched-add-btn` "일정 추가" — 2.25:1 (기준 4.5:1, 14px w600, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.msched-event > span.msched-event-author` "이주호" — 2.58:1 (기준 4.5:1, 11px w600, rgb(154, 154, 154) on rgb(244,245,247))
  - [Major] `span.msched-se-group > span.msched-se-label` "시작" — 2.58:1 (기준 4.5:1, 13.5px w700, rgb(154, 154, 154) on rgb(244,245,247))
  - [Major] `div.msched-add-remind.msched-se > span.msched-times-sep` "~" — 2.58:1 (기준 4.5:1, 10px w600, rgb(154, 154, 154) on rgb(244,245,247))
  - …외 51건 (metrics-raw.json 참조)
시각적 1순위 유일: 24px w900 "그룹 입장"
(배경 이미지/그라데이션 때문에 대비 미계산 10개 노드)

## ledger
### mobile — 텍스트 노드 107개 스캔
**대비 위반 59건** (mobile):
  - [Major] `span.marquee-inner > b` "시작" — 2.06:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `div.ledger-title > span.ledger-count` "2" — 2.08:1 (기준 4.5:1, 12px w700, rgb(33, 200, 24) on rgb(234,251,232))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `aside > button.drawer-add` "+" — 2.25:1 (기준 3:1, 24px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-section-title > button.hub-recap-run` "지금 정리하기" — 2.25:1 (기준 4.5:1, 12px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-followup > button.hub-followup-btn` "리마인드" — 2.25:1 (기준 4.5:1, 12px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.hub-recap-next.suggest > span.hub-recap-next-label` "다음 회의" — 2.25:1 (기준 4.5:1, 12.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-recap-next.suggest > button.hub-recap-next-btn` "겹치는 시간 찾기" — 2.25:1 (기준 4.5:1, 12px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `section.hub-section.pipe-card > button.pipe-cta` "일정 잡기" — 2.25:1 (기준 4.5:1, 12.5px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `section.hub-section.pipe-card > div.pipe-step.now` "지금 · 실행 중" — 2.25:1 (기준 4.5:1, 12.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `form.hub-todo-add > button` "추가" — 2.25:1 (기준 4.5:1, 13px w600, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.hub-section-title.clickable > b` "3" — 2.25:1 (기준 4.5:1, 14px w900, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.ledger-meta > button.ledger-src-link` "정리 보기" — 2.25:1 (기준 4.5:1, 12px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.ledger-meta > button.ledger-src-link` "정정" — 2.25:1 (기준 4.5:1, 12px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - …외 44건 (metrics-raw.json 참조)
**[Minor] 44px 미만 터치 타겟 17건**:
  - `div.ledger-meta > button.ledger-src-link` "정정" — 23×15px
  - `div.ledger-meta > button.ledger-src-link.ledger-withdraw-link` "철회" — 23×15px
  - `div.ledger-meta > button.ledger-src-link` "정정" — 23×15px
  - `div.ledger-meta > button.ledger-src-link.ledger-withdraw-link` "철회" — 23×15px
  - `div.ledger-meta > button.ledger-src-link` "정리 보기" — 48×15px
  - `div.ledger-meta > button.ledger-src-link` "정리 보기" — 48×15px
  - `div.hub-m-back > button` "" — 40×28px
  - `div.ledger-item.critical > button.ledger-ack.critical` "확인" — 45×25px
  - `div.pillseg.ledger-view-seg > button.on` "원장" — 53×26px
  - `div.pillseg.ledger-view-seg > button` "회의" — 53×26px
  - `form.hub-todo-add > button` "추가" — 53×34px
  - `div.pillseg.ledger-view-seg > button` "인수인계" — 77×26px
  - `div.pillseg.ledger-view-seg > button` "변경 이력" — 80×26px
  - `div.hub-recap-next.suggest > button.hub-recap-next-btn` "겹치는 시간 찾기" — 122×23px
  - `section.hub-section.pipe-card > button.pipe-cta` "일정 잡기" — 98×31px
  - …외 2건
**[Cosmetic] 모바일 16px 미만 본문 7건**:
  - `div.ledger-meta > span.ledger-ack-list` "· 확인 3 명 ( 이주호, 김소희," — 12px
  - `div.hub-followup > span.hub-followup-text` "' 방열판 두께를 3mm로 변경한다 " — 12.5px
  - `ul.hub-recap-decisions > li` "주간 정기 점검을 목요일 오전으로 옮" — 13px
  - `span.marquee.countdown > span.marquee-inner.on` "'주간 품질 회의'에 일정 추가 — " — 14px
  - `div.hub-recap-head > span.hub-recap-summary` "주간 품질 회의 — 방열판 라인 점검" — 14px
  - `span.marquee.hub-decision-text > span.marquee-inner.on` "주간 정기 점검을 목요일 오전으로 옮" — 14px
  - `span.marquee.hub-agenda-title > span.marquee-inner.on` "지난 결정 후속 점검 — 주간 정기 " — 14px
시각적 1순위 유일: 24px w600 "+"
(배경 이미지/그라데이션 때문에 대비 미계산 12개 노드)

### tablet — 텍스트 노드 73개 스캔
**대비 위반 37건** (tablet):
  - [Major] `span.marquee-inner > b` "시작" — 2.06:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `div.ledger-title > span.ledger-count` "2" — 2.08:1 (기준 4.5:1, 12px w700, rgb(33, 200, 24) on rgb(234,251,232))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `aside > div.section-title` "최근 그룹" — 2.25:1 (기준 3:1, 21px w900, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `button.ws-tab.meeting > span.ws-tab-text` "주간 품질 회의" — 2.25:1 (기준 4.5:1, 15px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-tabs > button.hub-tab.active` "기록" — 2.25:1 (기준 4.5:1, 14px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.ledger-meta > button.ledger-src-link` "정리 보기" — 2.25:1 (기준 4.5:1, 12px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.ledger-meta > button.ledger-src-link` "정정" — 2.25:1 (기준 4.5:1, 12px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.ledger-meta > button.ledger-src-link` "정리 보기" — 2.25:1 (기준 4.5:1, 12px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.ledger-meta > button.ledger-src-link` "정정" — 2.25:1 (기준 4.5:1, 12px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.ledger-item > span.ledger-ack.done` "확인함" — 2.58:1 (기준 4.5:1, 12px w700, rgb(154, 154, 154) on rgb(244,245,247))
  - [Major] `div.nowbar-card.hidden > div.nb-next-empty` "진행 중인 그룹이 없어요" — 2.81:1 (기준 4.5:1, 14px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - …외 22건 (metrics-raw.json 참조)
시각적 1순위 유일: 24px w900 "그룹 입장"
(배경 이미지/그라데이션 때문에 대비 미계산 10개 노드)

### laptop — 텍스트 노드 73개 스캔
**대비 위반 37건** (laptop):
  - [Major] `span.marquee-inner > b` "시작" — 2.06:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `div.ledger-title > span.ledger-count` "2" — 2.08:1 (기준 4.5:1, 12px w700, rgb(33, 200, 24) on rgb(234,251,232))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `aside > div.section-title` "최근 그룹" — 2.25:1 (기준 3:1, 21px w900, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `button.ws-tab.meeting > span.ws-tab-text` "주간 품질 회의" — 2.25:1 (기준 4.5:1, 15px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-tabs > button.hub-tab.active` "기록" — 2.25:1 (기준 4.5:1, 14px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.ledger-meta > button.ledger-src-link` "정리 보기" — 2.25:1 (기준 4.5:1, 12px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.ledger-meta > button.ledger-src-link` "정정" — 2.25:1 (기준 4.5:1, 12px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.ledger-meta > button.ledger-src-link` "정리 보기" — 2.25:1 (기준 4.5:1, 12px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.ledger-meta > button.ledger-src-link` "정정" — 2.25:1 (기준 4.5:1, 12px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.ledger-item > span.ledger-ack.done` "확인함" — 2.58:1 (기준 4.5:1, 12px w700, rgb(154, 154, 154) on rgb(244,245,247))
  - [Major] `div.nowbar-card.hidden > div.nb-next-empty` "진행 중인 그룹이 없어요" — 2.81:1 (기준 4.5:1, 14px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - …외 22건 (metrics-raw.json 참조)
시각적 1순위 유일: 24px w900 "그룹 입장"
(배경 이미지/그라데이션 때문에 대비 미계산 10개 노드)

### desktop — 텍스트 노드 73개 스캔
**대비 위반 37건** (desktop):
  - [Major] `span.marquee-inner > b` "시작" — 2.06:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `div.ledger-title > span.ledger-count` "2" — 2.08:1 (기준 4.5:1, 12px w700, rgb(33, 200, 24) on rgb(234,251,232))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `aside > div.section-title` "최근 그룹" — 2.25:1 (기준 3:1, 21px w900, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `button.ws-tab.meeting > span.ws-tab-text` "주간 품질 회의" — 2.25:1 (기준 4.5:1, 15px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-tabs > button.hub-tab.active` "기록" — 2.25:1 (기준 4.5:1, 14px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.ledger-meta > button.ledger-src-link` "정리 보기" — 2.25:1 (기준 4.5:1, 12px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.ledger-meta > button.ledger-src-link` "정정" — 2.25:1 (기준 4.5:1, 12px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.ledger-meta > button.ledger-src-link` "정리 보기" — 2.25:1 (기준 4.5:1, 12px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.ledger-meta > button.ledger-src-link` "정정" — 2.25:1 (기준 4.5:1, 12px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.ledger-item > span.ledger-ack.done` "확인함" — 2.58:1 (기준 4.5:1, 12px w700, rgb(154, 154, 154) on rgb(244,245,247))
  - [Major] `div.nowbar-card.hidden > div.nb-next-empty` "진행 중인 그룹이 없어요" — 2.81:1 (기준 4.5:1, 14px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - …외 22건 (metrics-raw.json 참조)
시각적 1순위 유일: 24px w900 "그룹 입장"
(배경 이미지/그라데이션 때문에 대비 미계산 10개 노드)

## files
### mobile — 텍스트 노드 98개 스캔
**대비 위반 53건** (mobile):
  - [Major] `span.marquee-inner > b` "시작" — 2.06:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `aside > button.drawer-add` "+" — 2.25:1 (기준 3:1, 24px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-section-title > button.hub-recap-run` "지금 정리하기" — 2.25:1 (기준 4.5:1, 12px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-followup > button.hub-followup-btn` "리마인드" — 2.25:1 (기준 4.5:1, 12px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.hub-recap-next.suggest > span.hub-recap-next-label` "다음 회의" — 2.25:1 (기준 4.5:1, 12.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-recap-next.suggest > button.hub-recap-next-btn` "겹치는 시간 찾기" — 2.25:1 (기준 4.5:1, 12px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `section.hub-section.pipe-card > button.pipe-cta` "일정 잡기" — 2.25:1 (기준 4.5:1, 12.5px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `section.hub-section.pipe-card > div.pipe-step.now` "지금 · 실행 중" — 2.25:1 (기준 4.5:1, 12.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `form.hub-todo-add > button` "추가" — 2.25:1 (기준 4.5:1, 13px w600, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.hub-section-title.clickable > b` "3" — 2.25:1 (기준 4.5:1, 14px w900, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-recap-foot > span.hub-recap-src` "규칙 정리" — 2.58:1 (기준 4.5:1, 11px w600, rgb(154, 154, 154) on rgb(244,245,247))
  - [Major] `div.hub-decision-row > span.hub-decision-ack.done` "확인함" — 2.58:1 (기준 4.5:1, 12px w700, rgb(154, 154, 154) on rgb(244,245,247))
  - [Major] `div.hub-decision-row > span.hub-decision-stat` "확인 0 / 3" — 2.58:1 (기준 4.5:1, 10.5px w700, rgb(154, 154, 154) on rgb(244,245,247))
  - …외 38건 (metrics-raw.json 참조)
**[Minor] 44px 미만 터치 타겟 16건**:
  - `div.cf-head > button.cf-add` "" — 26×20px
  - `div.hub-m-back > button` "" — 40×28px
  - `form.hub-todo-add > button` "추가" — 53×34px
  - `div.hub-recap-next.suggest > button.hub-recap-next-btn` "겹치는 시간 찾기" — 122×23px
  - `section.hub-section.pipe-card > button.pipe-cta` "일정 잡기" — 98×31px
  - `section.hub-section.pa-ros > div.hub-section-title.clickable` "참가자 3🐧🐧🐧" — 160×22px
  - `section.hub-section.pipe-card > button.pipe-more` "회의 정리 다시 보기" — 130×31px
  - `div > div.cf-item` "도면·설계＋" — 368×28px
  - `div > div.cf-item` "설비·정비＋" — 368×28px
  - `div > div.cf-item` "안전·환경＋" — 368×28px
  - `div > div.cf-item` "작업·교대 일지＋" — 368×28px
  - `div > div.cf-item` "작업표준·SOP＋" — 368×28px
  - `div > div.cf-item` "품질·검사＋" — 368×28px
  - `div > div.cf-item` "회의 자료＋" — 368×28px
  - `div > div.cf-item` "9월 설비 점검표" — 368×28px
  - …외 1건
**[Cosmetic] 모바일 16px 미만 본문 6건**:
  - `div.hub-followup > span.hub-followup-text` "' 방열판 두께를 3mm로 변경한다 " — 12.5px
  - `ul.hub-recap-decisions > li` "주간 정기 점검을 목요일 오전으로 옮" — 13px
  - `span.marquee.countdown > span.marquee-inner.on` "'주간 품질 회의'에 일정 추가 — " — 14px
  - `div.hub-recap-head > span.hub-recap-summary` "주간 품질 회의 — 방열판 라인 점검" — 14px
  - `span.marquee.hub-decision-text > span.marquee-inner.on` "주간 정기 점검을 목요일 오전으로 옮" — 14px
  - `span.marquee.hub-agenda-title > span.marquee-inner.on` "지난 결정 후속 점검 — 주간 정기 " — 14px
시각적 1순위 유일: 24px w600 "+"
(배경 이미지/그라데이션 때문에 대비 미계산 12개 노드)

### tablet — 텍스트 노드 97개 스캔
**대비 위반 34건** (tablet):
  - [Major] `span.marquee-inner > b` "시작" — 2.06:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `aside.cf-desktree > button.cf-desktree-item.side-ic-folder` "주간 품질 회의" — 2.08:1 (기준 4.5:1, 12.5px w700, rgb(33, 200, 24) on rgb(234,251,232))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `aside > div.section-title` "최근 그룹" — 2.25:1 (기준 3:1, 21px w900, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `button.ws-tab.meeting > span.ws-tab-text` "주간 품질 회의" — 2.25:1 (기준 4.5:1, 15px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-tabs > button.hub-tab.active` "공동편집" — 2.25:1 (기준 4.5:1, 14px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.cf-tool-wrap > button.cf-tool.primary` "새로 만들기" — 2.25:1 (기준 4.5:1, 12px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.cf-newgroup > button.cf-tool.primary` "업로드" — 2.25:1 (기준 4.5:1, 12px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.cf-details-primary > button.cf-details-open` "열기" — 2.25:1 (기준 4.5:1, 13px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.cf-ack > button.cf-details-open` "읽고 서명하기" — 2.25:1 (기준 4.5:1, 13px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `span.cf-ack-pend > span.avatar.cf-ack-pend-avatar` "🐧" — 2.58:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(244,245,247))
  - [Major] `span.cf-ack-pend > span` "이주호" — 2.58:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(244,245,247))
  - …외 19건 (metrics-raw.json 참조)
시각적 1순위 유일: 24px w900 "그룹 입장"
(배경 이미지/그라데이션 때문에 대비 미계산 10개 노드)

### laptop — 텍스트 노드 97개 스캔
**대비 위반 34건** (laptop):
  - [Major] `span.marquee-inner > b` "시작" — 2.06:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `aside.cf-desktree > button.cf-desktree-item.side-ic-folder` "주간 품질 회의" — 2.08:1 (기준 4.5:1, 12.5px w700, rgb(33, 200, 24) on rgb(234,251,232))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `aside > div.section-title` "최근 그룹" — 2.25:1 (기준 3:1, 21px w900, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `button.ws-tab.meeting > span.ws-tab-text` "주간 품질 회의" — 2.25:1 (기준 4.5:1, 15px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-tabs > button.hub-tab.active` "공동편집" — 2.25:1 (기준 4.5:1, 14px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.cf-tool-wrap > button.cf-tool.primary` "새로 만들기" — 2.25:1 (기준 4.5:1, 12px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.cf-newgroup > button.cf-tool.primary` "업로드" — 2.25:1 (기준 4.5:1, 12px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.cf-details-primary > button.cf-details-open` "열기" — 2.25:1 (기준 4.5:1, 13px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.cf-ack > button.cf-details-open` "읽고 서명하기" — 2.25:1 (기준 4.5:1, 13px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `span.cf-ack-pend > span.avatar.cf-ack-pend-avatar` "🐧" — 2.58:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(244,245,247))
  - [Major] `span.cf-ack-pend > span` "이주호" — 2.58:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(244,245,247))
  - …외 19건 (metrics-raw.json 참조)
시각적 1순위 유일: 24px w900 "그룹 입장"
(배경 이미지/그라데이션 때문에 대비 미계산 10개 노드)

### desktop — 텍스트 노드 97개 스캔
**대비 위반 34건** (desktop):
  - [Major] `span.marquee-inner > b` "시작" — 2.06:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `aside.cf-desktree > button.cf-desktree-item.side-ic-folder` "주간 품질 회의" — 2.08:1 (기준 4.5:1, 12.5px w700, rgb(33, 200, 24) on rgb(234,251,232))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `aside > div.section-title` "최근 그룹" — 2.25:1 (기준 3:1, 21px w900, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `button.ws-tab.meeting > span.ws-tab-text` "주간 품질 회의" — 2.25:1 (기준 4.5:1, 15px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-tabs > button.hub-tab.active` "공동편집" — 2.25:1 (기준 4.5:1, 14px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.cf-tool-wrap > button.cf-tool.primary` "새로 만들기" — 2.25:1 (기준 4.5:1, 12px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.cf-newgroup > button.cf-tool.primary` "업로드" — 2.25:1 (기준 4.5:1, 12px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.cf-details-primary > button.cf-details-open` "열기" — 2.25:1 (기준 4.5:1, 13px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.cf-ack > button.cf-details-open` "읽고 서명하기" — 2.25:1 (기준 4.5:1, 13px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `span.cf-ack-pend > span.avatar.cf-ack-pend-avatar` "🐧" — 2.58:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(244,245,247))
  - [Major] `span.cf-ack-pend > span` "이주호" — 2.58:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(244,245,247))
  - …외 19건 (metrics-raw.json 참조)
시각적 1순위 유일: 24px w900 "그룹 입장"
(배경 이미지/그라데이션 때문에 대비 미계산 10개 노드)

## hub-settings
### mobile — 텍스트 노드 120개 스캔
**대비 위반 54건** (mobile):
  - [Major] `span.marquee-inner > b` "시작" — 2.06:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `aside > button.drawer-add` "+" — 2.25:1 (기준 3:1, 24px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-section-title > button.hub-recap-run` "지금 정리하기" — 2.25:1 (기준 4.5:1, 12px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-followup > button.hub-followup-btn` "리마인드" — 2.25:1 (기준 4.5:1, 12px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.hub-recap-next.suggest > span.hub-recap-next-label` "다음 회의" — 2.25:1 (기준 4.5:1, 12.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-recap-next.suggest > button.hub-recap-next-btn` "겹치는 시간 찾기" — 2.25:1 (기준 4.5:1, 12px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `section.hub-section.pipe-card > button.pipe-cta` "일정 잡기" — 2.25:1 (기준 4.5:1, 12.5px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `section.hub-section.pipe-card > div.pipe-step.now` "지금 · 실행 중" — 2.25:1 (기준 4.5:1, 12.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `form.hub-todo-add > button` "추가" — 2.25:1 (기준 4.5:1, 13px w600, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.hub-section-title.clickable > b` "3" — 2.25:1 (기준 4.5:1, 14px w900, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-section-title > b` "3" — 2.25:1 (기준 4.5:1, 14px w900, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `form.hub-gloss-add > button` "등록" — 2.25:1 (기준 4.5:1, 13px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.hub-recap-foot > span.hub-recap-src` "규칙 정리" — 2.58:1 (기준 4.5:1, 11px w600, rgb(154, 154, 154) on rgb(244,245,247))
  - …외 39건 (metrics-raw.json 참조)
**[Minor] 44px 미만 터치 타겟 18건**:
  - `div.hub-perm > button.hub-switch` "" — 44×25px
  - `div.hub-perm > button.hub-switch.on` "" — 44×25px
  - `div.hub-perm > button.hub-switch` "" — 44×25px
  - `div.hub-perm > button.hub-switch` "" — 44×25px
  - `div.hub-m-back > button` "" — 40×28px
  - `form.hub-todo-add > button` "추가" — 53×34px
  - `form.hub-gloss-add > button` "등록" — 57×34px
  - `span.hub-set-actions > button.hub-set-btn.danger` "내보내기" — 71×29px
  - `span.hub-set-actions > button.hub-set-btn.danger` "내보내기" — 71×29px
  - `span.hub-set-actions > button.hub-set-btn` "호스트 위임" — 86×29px
  - `span.hub-set-actions > button.hub-set-btn` "호스트 위임" — 86×29px
  - `div.hub-recap-next.suggest > button.hub-recap-next-btn` "겹치는 시간 찾기" — 122×23px
  - `section.hub-section.pipe-card > button.pipe-cta` "일정 잡기" — 98×31px
  - `div.hub-invite-row > button.hub-set-btn` "초대 링크 복사" — 119×29px
  - `div.hub-invite-row > button.hub-set-btn` "코드 E9UY9C" — 120×29px
  - …외 3건
**[Cosmetic] 모바일 16px 미만 본문 11건**:
  - `div.hub-invite-row > span.hub-invite-hint` "링크를 받은 사람은 로그인만 하면 자" — 12px
  - `div.hub-followup > span.hub-followup-text` "' 방열판 두께를 3mm로 변경한다 " — 12.5px
  - `span.hub-perm-text > span.hub-perm-desc` "참가자도 문서·시트·캔버스를 편집할 " — 12.5px
  - `span.hub-perm-text > span.hub-perm-desc` "통화 입장할 때 마이크를 끈 상태로 " — 12.5px
  - `span.hub-perm-text > span.hub-perm-desc` "최근 그룹 목록 맨 위에 고정해요 (" — 12.5px
  - `ul.hub-recap-decisions > li` "주간 정기 점검을 목요일 오전으로 옮" — 13px
  - `section.hub-set-card.danger-zone > p.hub-danger-desc` "회의와 모든 채팅·일정 기록이 영구적" — 13px
  - `span.marquee.countdown > span.marquee-inner.on` "'주간 품질 회의'에 일정 추가 — " — 14px
  - `div.hub-recap-head > span.hub-recap-summary` "주간 품질 회의 — 방열판 라인 점검" — 14px
  - `span.marquee.hub-decision-text > span.marquee-inner.on` "주간 정기 점검을 목요일 오전으로 옮" — 14px
  - …외 1건
시각적 1순위 유일: 24px w600 "+"
(배경 이미지/그라데이션 때문에 대비 미계산 12개 노드)

### tablet — 텍스트 노드 86개 스캔
**대비 위반 32건** (tablet):
  - [Major] `span.marquee-inner > b` "시작" — 2.06:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `aside > div.section-title` "최근 그룹" — 2.25:1 (기준 3:1, 21px w900, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `button.ws-tab.meeting > span.ws-tab-text` "주간 품질 회의" — 2.25:1 (기준 4.5:1, 15px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-tabs > button.hub-tab.active` "설정" — 2.25:1 (기준 4.5:1, 14px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-section-title > b` "3" — 2.25:1 (기준 4.5:1, 14px w900, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `form.hub-gloss-add > button` "등록" — 2.25:1 (기준 4.5:1, 13px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.nowbar-card.hidden > div.nb-next-empty` "진행 중인 그룹이 없어요" — 2.81:1 (기준 4.5:1, 14px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.nb-notif-lead > span.nb-notif-time` "방금" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.nowbar-pill > button.nowbar-auto` "수동" — 2.81:1 (기준 4.5:1, 10.5px w600, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.hub-tabs > button.hub-tab` "대시보드" — 2.81:1 (기준 4.5:1, 14px w600, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.hub-tabs > button.hub-tab` "일정" — 2.81:1 (기준 4.5:1, 14px w600, rgb(154, 154, 154) on rgb(255,255,255))
  - …외 17건 (metrics-raw.json 참조)
시각적 1순위 유일: 24px w900 "그룹 입장"
(배경 이미지/그라데이션 때문에 대비 미계산 10개 노드)

### laptop — 텍스트 노드 86개 스캔
**대비 위반 32건** (laptop):
  - [Major] `span.marquee-inner > b` "시작" — 2.06:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `aside > div.section-title` "최근 그룹" — 2.25:1 (기준 3:1, 21px w900, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `button.ws-tab.meeting > span.ws-tab-text` "주간 품질 회의" — 2.25:1 (기준 4.5:1, 15px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-tabs > button.hub-tab.active` "설정" — 2.25:1 (기준 4.5:1, 14px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-section-title > b` "3" — 2.25:1 (기준 4.5:1, 14px w900, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `form.hub-gloss-add > button` "등록" — 2.25:1 (기준 4.5:1, 13px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.nowbar-card.hidden > div.nb-next-empty` "진행 중인 그룹이 없어요" — 2.81:1 (기준 4.5:1, 14px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.nb-notif-lead > span.nb-notif-time` "1분 전" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.nowbar-pill > button.nowbar-auto` "수동" — 2.81:1 (기준 4.5:1, 10.5px w600, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.hub-tabs > button.hub-tab` "대시보드" — 2.81:1 (기준 4.5:1, 14px w600, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.hub-tabs > button.hub-tab` "일정" — 2.81:1 (기준 4.5:1, 14px w600, rgb(154, 154, 154) on rgb(255,255,255))
  - …외 17건 (metrics-raw.json 참조)
시각적 1순위 유일: 24px w900 "그룹 입장"
(배경 이미지/그라데이션 때문에 대비 미계산 10개 노드)

### desktop — 텍스트 노드 86개 스캔
**대비 위반 32건** (desktop):
  - [Major] `span.marquee-inner > b` "시작" — 2.06:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.nb-next-start > b` "시작" — 2.25:1 (기준 4.5:1, 11.5px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `aside > div.section-title` "최근 그룹" — 2.25:1 (기준 3:1, 21px w900, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `button.ws-tab.meeting > span.ws-tab-text` "주간 품질 회의" — 2.25:1 (기준 4.5:1, 15px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-tabs > button.hub-tab.active` "설정" — 2.25:1 (기준 4.5:1, 14px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div.hub-section-title > b` "3" — 2.25:1 (기준 4.5:1, 14px w900, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `form.hub-gloss-add > button` "등록" — 2.25:1 (기준 4.5:1, 13px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.nowbar-card.hidden > div.nb-next-empty` "진행 중인 그룹이 없어요" — 2.81:1 (기준 4.5:1, 14px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.nb-notif-lead > span.nb-notif-time` "1분 전" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.nowbar-pill > button.nowbar-auto` "수동" — 2.81:1 (기준 4.5:1, 10.5px w600, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.hub-tabs > button.hub-tab` "대시보드" — 2.81:1 (기준 4.5:1, 14px w600, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.hub-tabs > button.hub-tab` "일정" — 2.81:1 (기준 4.5:1, 14px w600, rgb(154, 154, 154) on rgb(255,255,255))
  - …외 17건 (metrics-raw.json 참조)
시각적 1순위 유일: 24px w900 "그룹 입장"
(배경 이미지/그라데이션 때문에 대비 미계산 10개 노드)

## home-org
### mobile — 텍스트 노드 92개 스캔
**대비 위반 29건** (mobile):
  - [Major] `span.marquee-inner > b` "시작" — 2.06:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `aside > button.drawer-add` "+" — 2.25:1 (기준 3:1, 24px w600, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div > button` "3" — 2.25:1 (기준 4.5:1, 12.5px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.nowbar-card.hidden > div.nb-next-empty` "진행 중인 그룹이 없어요" — 2.81:1 (기준 4.5:1, 14px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.nb-notif-lead > span.nb-notif-time` "방금" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div > span.pd-inbox-hint` "비우면 오늘 준비 끝" — 2.81:1 (기준 4.5:1, 12px w500, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.pd-inbox > div.pd-inbox-empty` "모두 처리했어요 — 오늘 준비 끝" — 2.81:1 (기준 4.5:1, 14px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div > div` "이 날 일정이 없어요" — 2.81:1 (기준 4.5:1, 13px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div > div` "할 일이 없어요" — 2.81:1 (기준 4.5:1, 13px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `span.marquee-inner > span.dm-item-muted` "아직 메시지가 없어요" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `span.marquee-inner > span.dm-item-muted` "생산 1팀 · 설비담당" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `span.marquee-inner > span.dm-item-muted` "생산 1팀 · 작업반장" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `span.marquee-inner > span.dm-item-muted` "AI 총무" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - …외 14건 (metrics-raw.json 참조)
**[Minor] 44px 미만 터치 타겟 34건**:
  - `div > button` "" — 24×24px
  - `div > button` "" — 24×24px
  - `div > button` "1" — 37×37px
  - `div > button` "2" — 37×37px
  - `div > button` "3" — 37×37px
  - `div > button` "4" — 37×37px
  - `div > button` "5" — 37×37px
  - `div > button` "6" — 37×37px
  - `div > button` "7" — 37×37px
  - `div > button` "8" — 37×37px
  - `div > button` "9" — 37×37px
  - `div > button` "10" — 37×37px
  - `div > button` "11" — 37×37px
  - `div > button` "12" — 37×37px
  - `div > button` "13" — 37×37px
  - …외 19건
**[Cosmetic] 모바일 16px 미만 본문 1건**:
  - `span.marquee.countdown > span.marquee-inner.on` "'주간 품질 회의'에 일정 추가 — " — 14px
**[Cosmetic] 시각적 1순위 동률 3개** (17px w900): "0건", "0건", "0건"
(배경 이미지/그라데이션 때문에 대비 미계산 13개 노드)

### tablet — 텍스트 노드 107개 스캔
**대비 위반 30건** (tablet):
  - [Major] `span.marquee-inner > b` "시작" — 2.06:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `aside > div.section-title` "최근 그룹" — 2.25:1 (기준 3:1, 21px w900, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div > button` "3" — 2.25:1 (기준 4.5:1, 12.5px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.nb-next-list.nb-next-grid > div.nb-next-empty` "다음 일정이 없어요" — 2.81:1 (기준 4.5:1, 14px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.nowbar-card.hidden > div.nb-next-empty` "진행 중인 그룹이 없어요" — 2.81:1 (기준 4.5:1, 14px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.nb-notif-lead > span.nb-notif-time` "방금" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div > span.pd-inbox-hint` "비우면 오늘 준비 끝" — 2.81:1 (기준 4.5:1, 12px w500, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.pd-inbox > div.pd-inbox-empty` "모두 처리했어요 — 오늘 준비 끝" — 2.81:1 (기준 4.5:1, 14px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div > div` "이 날 일정이 없어요" — 2.81:1 (기준 4.5:1, 13px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div > div` "할 일이 없어요" — 2.81:1 (기준 4.5:1, 13px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `span.marquee-inner > span.dm-item-muted` "아직 메시지가 없어요" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `span.marquee-inner > span.dm-item-muted` "생산 1팀 · 설비담당" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `span.marquee-inner > span.dm-item-muted` "생산 1팀 · 작업반장" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - …외 15건 (metrics-raw.json 참조)
시각적 1순위 유일: 24px w900 "그룹 입장"
(배경 이미지/그라데이션 때문에 대비 미계산 17개 노드)

### laptop — 텍스트 노드 107개 스캔
**대비 위반 30건** (laptop):
  - [Major] `span.marquee-inner > b` "시작" — 2.06:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `aside > div.section-title` "최근 그룹" — 2.25:1 (기준 3:1, 21px w900, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div > button` "3" — 2.25:1 (기준 4.5:1, 12.5px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.nb-next-list.nb-next-grid > div.nb-next-empty` "다음 일정이 없어요" — 2.81:1 (기준 4.5:1, 14px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.nowbar-card.hidden > div.nb-next-empty` "진행 중인 그룹이 없어요" — 2.81:1 (기준 4.5:1, 14px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.nb-notif-lead > span.nb-notif-time` "1분 전" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div > span.pd-inbox-hint` "비우면 오늘 준비 끝" — 2.81:1 (기준 4.5:1, 12px w500, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.pd-inbox > div.pd-inbox-empty` "모두 처리했어요 — 오늘 준비 끝" — 2.81:1 (기준 4.5:1, 14px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div > div` "이 날 일정이 없어요" — 2.81:1 (기준 4.5:1, 13px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div > div` "할 일이 없어요" — 2.81:1 (기준 4.5:1, 13px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `span.marquee-inner > span.dm-item-muted` "아직 메시지가 없어요" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `span.marquee-inner > span.dm-item-muted` "생산 1팀 · 설비담당" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `span.marquee-inner > span.dm-item-muted` "생산 1팀 · 작업반장" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - …외 15건 (metrics-raw.json 참조)
**[Cosmetic] 시각적 1순위 동률 3개** (26px w900): "0건", "0건", "0건"
(배경 이미지/그라데이션 때문에 대비 미계산 17개 노드)

### desktop — 텍스트 노드 107개 스캔
**대비 위반 30건** (desktop):
  - [Major] `span.marquee-inner > b` "시작" — 2.06:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `span.marquee-inner > b` "시작" — 2.25:1 (기준 4.5:1, 14px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `aside > div.section-title` "최근 그룹" — 2.25:1 (기준 3:1, 21px w900, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div > button` "3" — 2.25:1 (기준 4.5:1, 12.5px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div.nb-next-list.nb-next-grid > div.nb-next-empty` "다음 일정이 없어요" — 2.81:1 (기준 4.5:1, 14px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.nowbar-card.hidden > div.nb-next-empty` "진행 중인 그룹이 없어요" — 2.81:1 (기준 4.5:1, 14px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.nb-notif-lead > span.nb-notif-time` "1분 전" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div > span.pd-inbox-hint` "비우면 오늘 준비 끝" — 2.81:1 (기준 4.5:1, 12px w500, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div.pd-inbox > div.pd-inbox-empty` "모두 처리했어요 — 오늘 준비 끝" — 2.81:1 (기준 4.5:1, 14px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div > div` "이 날 일정이 없어요" — 2.81:1 (기준 4.5:1, 13px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `div > div` "할 일이 없어요" — 2.81:1 (기준 4.5:1, 13px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `span.marquee-inner > span.dm-item-muted` "아직 메시지가 없어요" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `span.marquee-inner > span.dm-item-muted` "생산 1팀 · 설비담당" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - [Major] `span.marquee-inner > span.dm-item-muted` "생산 1팀 · 작업반장" — 2.81:1 (기준 4.5:1, 12px w400, rgb(154, 154, 154) on rgb(255,255,255))
  - …외 15건 (metrics-raw.json 참조)
**[Cosmetic] 시각적 1순위 동률 3개** (26px w900): "0건", "0건", "0건"
(배경 이미지/그라데이션 때문에 대비 미계산 17개 노드)

## orgchart
### mobile — 텍스트 노드 40개 스캔
**대비 위반 27건** (mobile):
  - [Major] `div > span` "규칙 기반 · 최근 14 일" — 2.06:1 (기준 4.5:1, 12px w600, rgb(33, 200, 24) on rgb(233,250,232))
  - [Major] `div.orgchart-info > div.orgchart-pos` "팀장 · 생산 1팀" — 2.06:1 (기준 4.5:1, 13px w600, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `div.orgchart-info > div.orgchart-pos` "작업반장 · 생산 1팀" — 2.06:1 (기준 4.5:1, 13px w600, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `div.orgchart-info > div.orgchart-pos` "설비담당 · 생산 1팀" — 2.06:1 (기준 4.5:1, 13px w600, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `button.orgchart-code > b` "KWVV-99QL" — 2.08:1 (기준 4.5:1, 13px w900, rgb(33, 200, 24) on rgb(234,251,232))
  - [Major] `div.orgchart-dept-head > span.orgchart-dept-count` "3" — 2.08:1 (기준 4.5:1, 12px w600, rgb(33, 200, 24) on rgb(234,251,232))
  - [Major] `div.orgchart-name > span.org-role.owner` "소유자" — 2.08:1 (기준 4.5:1, 11px w600, rgb(33, 200, 24) on rgb(234,251,232))
  - [Major] `span.orgchart-invite > button.orgchart-manage` "역할 관리" — 2.25:1 (기준 4.5:1, 13px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div > div` "0%" — 2.25:1 (기준 3:1, 22px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div > div` "1" — 2.25:1 (기준 3:1, 22px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div > div` "0회" — 2.25:1 (기준 3:1, 22px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div > div` "0/3" — 2.25:1 (기준 3:1, 22px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div > div.orgchart-sub` "멤버 3 명 · 부서 1 개" — 2.58:1 (기준 4.5:1, 13px w600, rgb(154, 154, 154) on rgb(244,245,247))
  - [Major] `span.orgchart-invite > button.orgchart-editmode` "관리 모드" — 2.58:1 (기준 4.5:1, 13px w600, rgb(154, 154, 154) on rgb(244,245,247))
  - [Major] `span.orgchart-invite > button.orgchart-code` "가입코드" — 2.61:1 (기준 4.5:1, 13px w600, rgb(154, 154, 154) on rgb(234,251,232))
  - …외 12건 (metrics-raw.json 참조)
**[Minor] 44px 미만 터치 타겟 6건**:
  - `header.orgchart-top > button.orgchart-back` "대시보드" — 114×21px
  - `div > button` "ESG · 원격근무 사회적 가치 보기" — 215×16px
  - `span.orgchart-invite > button.orgchart-code` "초대 링크" — 100×38px
  - `span.orgchart-invite > button.orgchart-editmode` "관리 모드" — 100×38px
  - `span.orgchart-invite > button.orgchart-manage` "역할 관리" — 102×38px
  - `span.orgchart-invite > button.orgchart-code` "가입코드 KWVV-99QL" — 178×38px
시각적 1순위 유일: 24px w900 "런타임 제조"

### tablet — 텍스트 노드 40개 스캔
**대비 위반 27건** (tablet):
  - [Major] `div > span` "규칙 기반 · 최근 14 일" — 2.06:1 (기준 4.5:1, 12px w600, rgb(33, 200, 24) on rgb(233,250,232))
  - [Major] `div.orgchart-info > div.orgchart-pos` "팀장 · 생산 1팀" — 2.06:1 (기준 4.5:1, 13px w600, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `div.orgchart-info > div.orgchart-pos` "작업반장 · 생산 1팀" — 2.06:1 (기준 4.5:1, 13px w600, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `div.orgchart-info > div.orgchart-pos` "설비담당 · 생산 1팀" — 2.06:1 (기준 4.5:1, 13px w600, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `button.orgchart-code > b` "KWVV-99QL" — 2.08:1 (기준 4.5:1, 13px w900, rgb(33, 200, 24) on rgb(234,251,232))
  - [Major] `div.orgchart-dept-head > span.orgchart-dept-count` "3" — 2.08:1 (기준 4.5:1, 12px w600, rgb(33, 200, 24) on rgb(234,251,232))
  - [Major] `div.orgchart-name > span.org-role.owner` "소유자" — 2.08:1 (기준 4.5:1, 11px w600, rgb(33, 200, 24) on rgb(234,251,232))
  - [Major] `span.orgchart-invite > button.orgchart-manage` "역할 관리" — 2.25:1 (기준 4.5:1, 13px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div > div` "0%" — 2.25:1 (기준 3:1, 22px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div > div` "1" — 2.25:1 (기준 3:1, 22px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div > div` "0회" — 2.25:1 (기준 3:1, 22px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div > div` "0/3" — 2.25:1 (기준 3:1, 22px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div > div.orgchart-sub` "멤버 3 명 · 부서 1 개" — 2.58:1 (기준 4.5:1, 13px w600, rgb(154, 154, 154) on rgb(244,245,247))
  - [Major] `span.orgchart-invite > button.orgchart-editmode` "관리 모드" — 2.58:1 (기준 4.5:1, 13px w600, rgb(154, 154, 154) on rgb(244,245,247))
  - [Major] `span.orgchart-invite > button.orgchart-code` "가입코드" — 2.61:1 (기준 4.5:1, 13px w600, rgb(154, 154, 154) on rgb(234,251,232))
  - …외 12건 (metrics-raw.json 참조)
시각적 1순위 유일: 24px w900 "런타임 제조"

### laptop — 텍스트 노드 40개 스캔
**대비 위반 27건** (laptop):
  - [Major] `div > span` "규칙 기반 · 최근 14 일" — 2.06:1 (기준 4.5:1, 12px w600, rgb(33, 200, 24) on rgb(233,250,232))
  - [Major] `div.orgchart-info > div.orgchart-pos` "팀장 · 생산 1팀" — 2.06:1 (기준 4.5:1, 13px w600, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `div.orgchart-info > div.orgchart-pos` "작업반장 · 생산 1팀" — 2.06:1 (기준 4.5:1, 13px w600, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `div.orgchart-info > div.orgchart-pos` "설비담당 · 생산 1팀" — 2.06:1 (기준 4.5:1, 13px w600, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `button.orgchart-code > b` "KWVV-99QL" — 2.08:1 (기준 4.5:1, 13px w900, rgb(33, 200, 24) on rgb(234,251,232))
  - [Major] `div.orgchart-dept-head > span.orgchart-dept-count` "3" — 2.08:1 (기준 4.5:1, 12px w600, rgb(33, 200, 24) on rgb(234,251,232))
  - [Major] `div.orgchart-name > span.org-role.owner` "소유자" — 2.08:1 (기준 4.5:1, 11px w600, rgb(33, 200, 24) on rgb(234,251,232))
  - [Major] `span.orgchart-invite > button.orgchart-manage` "역할 관리" — 2.25:1 (기준 4.5:1, 13px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div > div` "0%" — 2.25:1 (기준 3:1, 22px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div > div` "1" — 2.25:1 (기준 3:1, 22px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div > div` "0회" — 2.25:1 (기준 3:1, 22px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div > div` "0/3" — 2.25:1 (기준 3:1, 22px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div > div.orgchart-sub` "멤버 3 명 · 부서 1 개" — 2.58:1 (기준 4.5:1, 13px w600, rgb(154, 154, 154) on rgb(244,245,247))
  - [Major] `span.orgchart-invite > button.orgchart-editmode` "관리 모드" — 2.58:1 (기준 4.5:1, 13px w600, rgb(154, 154, 154) on rgb(244,245,247))
  - [Major] `span.orgchart-invite > button.orgchart-code` "가입코드" — 2.61:1 (기준 4.5:1, 13px w600, rgb(154, 154, 154) on rgb(234,251,232))
  - …외 12건 (metrics-raw.json 참조)
시각적 1순위 유일: 24px w900 "런타임 제조"

### desktop — 텍스트 노드 40개 스캔
**대비 위반 27건** (desktop):
  - [Major] `div > span` "규칙 기반 · 최근 14 일" — 2.06:1 (기준 4.5:1, 12px w600, rgb(33, 200, 24) on rgb(233,250,232))
  - [Major] `div.orgchart-info > div.orgchart-pos` "팀장 · 생산 1팀" — 2.06:1 (기준 4.5:1, 13px w600, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `div.orgchart-info > div.orgchart-pos` "작업반장 · 생산 1팀" — 2.06:1 (기준 4.5:1, 13px w600, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `div.orgchart-info > div.orgchart-pos` "설비담당 · 생산 1팀" — 2.06:1 (기준 4.5:1, 13px w600, rgb(33, 200, 24) on rgb(244,245,247))
  - [Major] `button.orgchart-code > b` "KWVV-99QL" — 2.08:1 (기준 4.5:1, 13px w900, rgb(33, 200, 24) on rgb(234,251,232))
  - [Major] `div.orgchart-dept-head > span.orgchart-dept-count` "3" — 2.08:1 (기준 4.5:1, 12px w600, rgb(33, 200, 24) on rgb(234,251,232))
  - [Major] `div.orgchart-name > span.org-role.owner` "소유자" — 2.08:1 (기준 4.5:1, 11px w600, rgb(33, 200, 24) on rgb(234,251,232))
  - [Major] `span.orgchart-invite > button.orgchart-manage` "역할 관리" — 2.25:1 (기준 4.5:1, 13px w700, rgb(255, 255, 255) on rgb(33,200,24))
  - [Major] `div > div` "0%" — 2.25:1 (기준 3:1, 22px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div > div` "1" — 2.25:1 (기준 3:1, 22px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div > div` "0회" — 2.25:1 (기준 3:1, 22px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div > div` "0/3" — 2.25:1 (기준 3:1, 22px w700, rgb(33, 200, 24) on rgb(255,255,255))
  - [Major] `div > div.orgchart-sub` "멤버 3 명 · 부서 1 개" — 2.58:1 (기준 4.5:1, 13px w600, rgb(154, 154, 154) on rgb(244,245,247))
  - [Major] `span.orgchart-invite > button.orgchart-editmode` "관리 모드" — 2.58:1 (기준 4.5:1, 13px w600, rgb(154, 154, 154) on rgb(244,245,247))
  - [Major] `span.orgchart-invite > button.orgchart-code` "가입코드" — 2.61:1 (기준 4.5:1, 13px w600, rgb(154, 154, 154) on rgb(234,251,232))
  - …외 12건 (metrics-raw.json 참조)
시각적 1순위 유일: 24px w900 "런타임 제조"

## 캡처 파일
- `C:\dev\exist\reports\design-0902\shots\login-mobile.png`
- `C:\dev\exist\reports\design-0902\shots\home-personal-mobile.png`
- `C:\dev\exist\reports\design-0902\shots\hub-chat-mobile.png`
- `C:\dev\exist\reports\design-0902\shots\schedule-week-mobile.png`
- `C:\dev\exist\reports\design-0902\shots\ledger-mobile.png`
- `C:\dev\exist\reports\design-0902\shots\files-mobile.png`
- `C:\dev\exist\reports\design-0902\shots\hub-settings-mobile.png`
- `C:\dev\exist\reports\design-0902\shots\home-org-mobile.png`
- `C:\dev\exist\reports\design-0902\shots\orgchart-mobile.png`
- `C:\dev\exist\reports\design-0902\shots\login-tablet.png`
- `C:\dev\exist\reports\design-0902\shots\home-personal-tablet.png`
- `C:\dev\exist\reports\design-0902\shots\hub-chat-tablet.png`
- `C:\dev\exist\reports\design-0902\shots\schedule-week-tablet.png`
- `C:\dev\exist\reports\design-0902\shots\ledger-tablet.png`
- `C:\dev\exist\reports\design-0902\shots\files-tablet.png`
- `C:\dev\exist\reports\design-0902\shots\hub-settings-tablet.png`
- `C:\dev\exist\reports\design-0902\shots\home-org-tablet.png`
- `C:\dev\exist\reports\design-0902\shots\orgchart-tablet.png`
- `C:\dev\exist\reports\design-0902\shots\login-laptop.png`
- `C:\dev\exist\reports\design-0902\shots\home-personal-laptop.png`
- `C:\dev\exist\reports\design-0902\shots\hub-chat-laptop.png`
- `C:\dev\exist\reports\design-0902\shots\schedule-week-laptop.png`
- `C:\dev\exist\reports\design-0902\shots\ledger-laptop.png`
- `C:\dev\exist\reports\design-0902\shots\files-laptop.png`
- `C:\dev\exist\reports\design-0902\shots\hub-settings-laptop.png`
- `C:\dev\exist\reports\design-0902\shots\home-org-laptop.png`
- `C:\dev\exist\reports\design-0902\shots\orgchart-laptop.png`
- `C:\dev\exist\reports\design-0902\shots\login-desktop.png`
- `C:\dev\exist\reports\design-0902\shots\home-personal-desktop.png`
- `C:\dev\exist\reports\design-0902\shots\hub-chat-desktop.png`
- `C:\dev\exist\reports\design-0902\shots\schedule-week-desktop.png`
- `C:\dev\exist\reports\design-0902\shots\ledger-desktop.png`
- `C:\dev\exist\reports\design-0902\shots\files-desktop.png`
- `C:\dev\exist\reports\design-0902\shots\hub-settings-desktop.png`
- `C:\dev\exist\reports\design-0902\shots\home-org-desktop.png`
- `C:\dev\exist\reports\design-0902\shots\orgchart-desktop.png`
