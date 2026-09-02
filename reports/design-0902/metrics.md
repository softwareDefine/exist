# exist 디자인 계측 리포트 — 2026-09-02

실측 기반: Playwright(Chromium) 실 DOM `getComputedStyle` 측정. 뷰포트 4단계: 모바일 390×844 / 태블릿 768×1024 / 노트북 1366×768 / 데스크탑 1920×1080.

심각도 기준: **Major** = 대비 < 3:1, 모바일 가로 스크롤. **Minor** = 대비 < 기준(4.5:1, 큰 텍스트 3:1), 모바일 터치 타겟 < 44×44. **Cosmetic** = 모바일 본문 폰트 < 16px, 시각적 1순위 동률.

## 요약 — 화면 × 뷰포트 위반 카운트

표기 — 모바일: `대비Major/대비Minor · 터치타겟<44 · 본문<16px · 가로스크롤` / 그 외: `대비Major/대비Minor · 가로스크롤`

| 화면 | mobile | tablet | laptop | desktop |
|---|---|---|---|---|
| login | 0/0 · 2 · 0 · 0 | 0/0 · 0 | 0/0 · 0 | 0/0 · 0 |
| home-personal | 0/14 · 41 · 8 · 0 | 0/12 · 0 | 0/12 · 0 | 0/12 · 0 |
| hub-chat | 0/8 · 9 · 5 · 0 | 0/4 · 0 | 0/4 · 0 | 0/4 · 0 |
| schedule-week | 1/9 · 52 · 6 · 0 | 1/10 · 0 | 1/11 · 0 | 1/11 · 0 |
| ledger | 0/9 · 15 · 7 · 0 | 0/3 · 0 | 0/3 · 0 | 0/3 · 0 |
| files | 0/9 · 16 · 6 · 0 | 0/7 · 0 | 0/7 · 0 | 0/7 · 0 |
| hub-settings | 0/9 · 18 · 11 · 0 | 0/3 · 0 | 0/3 · 0 | 0/3 · 0 |
| home-org | 0/11 · 34 · 1 · 0 | 0/11 · 0 | 0/11 · 0 | 0/11 · 0 |
| orgchart | 0/7 · 7 · 1 · 0 | 0/7 · 0 | 0/7 · 0 | 0/7 · 0 |

## 가로 오버플로
- 없음 — 모든 화면·뷰포트에서 `scrollWidth ≤ clientWidth`.

## login
### mobile — 텍스트 노드 3개 스캔
**[Minor] 44px 미만 터치 타겟 2건**:
  - `div.meta > a` "회원가입" — 46×15px
  - `div.meta > a` "아이디/비번을 잊어버리셨나요?" — 162×15px
시각적 1순위 유일: 16px w600 "로그인"

### tablet — 텍스트 노드 3개 스캔
시각적 1순위 유일: 16px w600 "로그인"

### laptop — 텍스트 노드 3개 스캔
시각적 1순위 유일: 16px w600 "로그인"

### desktop — 텍스트 노드 3개 스캔
시각적 1순위 유일: 16px w600 "로그인"

## home-personal
### mobile — 텍스트 노드 121개 스캔
**대비 위반 14건** (mobile):
  - [Minor] `span.pd-act-sub > span.pd-sent-missing` "— 미확인: 김소희, 박민수" — 3.19:1 (기준 4.5:1, 12px w700, rgb(217, 119, 6) on rgb(255,255,255))
  - [Minor] `div > div` "토" — 3.81:1 (기준 4.5:1, 11px w600, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div > button` "5" — 3.81:1 (기준 4.5:1, 12.5px w400, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div > button` "12" — 3.81:1 (기준 4.5:1, 12.5px w400, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div > button` "19" — 3.81:1 (기준 4.5:1, 12.5px w400, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div > button` "26" — 3.81:1 (기준 4.5:1, 12.5px w400, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div.nowbar-pill > span.nb-pill-count` "3" — 3.91:1 (기준 4.5:1, 11px w800, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `div > div` "일" — 3.91:1 (기준 4.5:1, 11px w600, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div > button` "6" — 3.91:1 (기준 4.5:1, 12.5px w400, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div > button` "13" — 3.91:1 (기준 4.5:1, 12.5px w400, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div > button` "20" — 3.91:1 (기준 4.5:1, 12.5px w400, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div > button` "27" — 3.91:1 (기준 4.5:1, 12.5px w400, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `button.dm-item > span.dm-item-badge` "2" — 3.91:1 (기준 4.5:1, 11px w600, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `div > span` "채팅" — 4.16:1 (기준 4.5:1, 11px w700, rgb(118, 118, 118) on rgb(244,245,247))
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
**[Cosmetic] 모바일 16px 미만 본문 8건**:
  - `div.pd-act-main > span.pd-act-sub` "주간 품질 회의 · 팀 확인 3 / " — 12px
  - `span.marquee.dm-item-preview-text > span.marquee-inner.on` "결정 사항은 기록 탭에서 확인 눌러주" — 12px
  - `span.marquee.countdown > span.marquee-inner.on` "'주간 품질 회의'에 일정 추가 — " — 14px
  - `span.marquee.pd-act-title > span.marquee-inner.on` "『 방열판 설계 변경 공지 』 열람 " — 14px
  - `span.marquee.pd-act-title > span.marquee-inner.on` "🔴 방열판 두께를 3mm로 변경한다" — 14px
  - `span.marquee.pd-act-title > span.marquee-inner.on` "주간 정기 점검을 목요일 오전으로 옮" — 14px
  - `span.marquee.pd-act-title > span.marquee-inner.on` "주간 정기 점검을 목요일 오전으로 옮" — 14px
  - `span.marquee.pd-catchup-text > span.marquee-inner.on` "통화 정리 — 주간 품질 회의 — 방" — 14px
시각적 1순위 유일: 28px w700 "이"
(배경 이미지/그라데이션 때문에 대비 미계산 16개 노드)

### tablet — 텍스트 노드 137개 스캔
**대비 위반 12건** (tablet):
  - [Minor] `span.pd-act-sub > span.pd-sent-missing` "— 미확인: 김소희, 박민수" — 3.19:1 (기준 4.5:1, 12px w700, rgb(217, 119, 6) on rgb(255,255,255))
  - [Minor] `div > div` "토" — 3.81:1 (기준 4.5:1, 11px w600, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div > button` "5" — 3.81:1 (기준 4.5:1, 12.5px w400, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div > button` "12" — 3.81:1 (기준 4.5:1, 12.5px w400, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div > button` "19" — 3.81:1 (기준 4.5:1, 12.5px w400, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div > button` "26" — 3.81:1 (기준 4.5:1, 12.5px w400, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `button.notif-bell > span.notif-count` "3" — 3.91:1 (기준 4.5:1, 10px w600, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `div > div` "일" — 3.91:1 (기준 4.5:1, 11px w600, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div > button` "6" — 3.91:1 (기준 4.5:1, 12.5px w400, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div > button` "13" — 3.91:1 (기준 4.5:1, 12.5px w400, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div > button` "20" — 3.91:1 (기준 4.5:1, 12.5px w400, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div > button` "27" — 3.91:1 (기준 4.5:1, 12.5px w400, rgb(229, 72, 77) on rgb(255,255,255))
시각적 1순위 유일: 32px w700 "이"
(배경 이미지/그라데이션 때문에 대비 미계산 19개 노드)

### laptop — 텍스트 노드 137개 스캔
**대비 위반 12건** (laptop):
  - [Minor] `span.pd-act-sub > span.pd-sent-missing` "— 미확인: 김소희, 박민수" — 3.19:1 (기준 4.5:1, 12px w700, rgb(217, 119, 6) on rgb(255,255,255))
  - [Minor] `div > div` "토" — 3.81:1 (기준 4.5:1, 11px w600, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div > button` "5" — 3.81:1 (기준 4.5:1, 12.5px w400, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div > button` "12" — 3.81:1 (기준 4.5:1, 12.5px w400, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div > button` "19" — 3.81:1 (기준 4.5:1, 12.5px w400, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div > button` "26" — 3.81:1 (기준 4.5:1, 12.5px w400, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `button.notif-bell > span.notif-count` "3" — 3.91:1 (기준 4.5:1, 10px w600, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `div > div` "일" — 3.91:1 (기준 4.5:1, 11px w600, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div > button` "6" — 3.91:1 (기준 4.5:1, 12.5px w400, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div > button` "13" — 3.91:1 (기준 4.5:1, 12.5px w400, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div > button` "20" — 3.91:1 (기준 4.5:1, 12.5px w400, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div > button` "27" — 3.91:1 (기준 4.5:1, 12.5px w400, rgb(229, 72, 77) on rgb(255,255,255))
**[Cosmetic] 시각적 1순위 동률 4개** (26px w900): "1건", "0건", "1건", "1건"
(배경 이미지/그라데이션 때문에 대비 미계산 19개 노드)

### desktop — 텍스트 노드 137개 스캔
**대비 위반 12건** (desktop):
  - [Minor] `span.pd-act-sub > span.pd-sent-missing` "— 미확인: 김소희, 박민수" — 3.19:1 (기준 4.5:1, 12px w700, rgb(217, 119, 6) on rgb(255,255,255))
  - [Minor] `div > div` "토" — 3.81:1 (기준 4.5:1, 11px w600, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div > button` "5" — 3.81:1 (기준 4.5:1, 12.5px w400, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div > button` "12" — 3.81:1 (기준 4.5:1, 12.5px w400, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div > button` "19" — 3.81:1 (기준 4.5:1, 12.5px w400, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div > button` "26" — 3.81:1 (기준 4.5:1, 12.5px w400, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `button.notif-bell > span.notif-count` "3" — 3.91:1 (기준 4.5:1, 10px w600, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `div > div` "일" — 3.91:1 (기준 4.5:1, 11px w600, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div > button` "6" — 3.91:1 (기준 4.5:1, 12.5px w400, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div > button` "13" — 3.91:1 (기준 4.5:1, 12.5px w400, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div > button` "20" — 3.91:1 (기준 4.5:1, 12.5px w400, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div > button` "27" — 3.91:1 (기준 4.5:1, 12.5px w400, rgb(229, 72, 77) on rgb(255,255,255))
**[Cosmetic] 시각적 1순위 동률 4개** (26px w900): "1건", "0건", "1건", "1건"
(배경 이미지/그라데이션 때문에 대비 미계산 19개 노드)

## hub-chat
### mobile — 텍스트 노드 101개 스캔
**대비 위반 8건** (mobile):
  - [Minor] `div.nowbar-pill > span.nb-pill-count` "3" — 3.91:1 (기준 4.5:1, 11px w800, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `div.chat-date > span` "오늘" — 3.98:1 (기준 4.5:1, 11px w600, rgb(118, 118, 118) on rgb(238,240,242))
  - [Minor] `div.hub-recap-foot > span.hub-recap-src` "규칙 정리" — 4.16:1 (기준 4.5:1, 11px w600, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.hub-decision-row > span.hub-decision-ack.done` "확인함" — 4.16:1 (기준 4.5:1, 12px w700, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.hub-decision-row > span.hub-decision-stat` "확인 0 / 3" — 4.16:1 (기준 4.5:1, 10.5px w700, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.hub-channels-head > button.hub-channels-add` "＋" — 4.16:1 (기준 4.5:1, 15px w400, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `span.hub-roster-stack > span.avatar.avatar-initial` "이" — 4.42:1 (기준 4.5:1, 13px w700, rgb(161, 98, 7) on rgb(254,243,199))
  - [Minor] `div.hub-cta-btns > button.hub-join.lg` "통화 참여" — 4.45:1 (기준 4.5:1, 15px w600, rgb(15, 138, 60) on rgb(255,255,255))
**[Minor] 44px 미만 터치 타겟 9건**:
  - `button.hub-channel-item.active > span.hub-channel-notify.mode-mention` "" — 19×13px
  - `div.hub-channels-head > button.hub-channels-add` "＋" — 27×19px
  - `div.hub-m-back > button` "" — 40×28px
  - `form.hub-todo-add > button` "추가" — 53×34px
  - `div.hub-recap-next.suggest > button.hub-recap-next-btn` "겹치는 시간 찾기" — 122×23px
  - `section.hub-section.pipe-card > button.pipe-cta` "일정 잡기" — 98×31px
  - `div.hub-channels-list > button.hub-channel-item.active` "#일반" — 108×30px
  - `section.hub-section.pa-ros > div.hub-section-title.clickable` "참가자 3이김박" — 160×22px
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
**대비 위반 4건** (tablet):
  - [Minor] `button.notif-bell > span.notif-count` "3" — 3.91:1 (기준 4.5:1, 10px w600, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `div.chat-date > span` "오늘" — 3.98:1 (기준 4.5:1, 11px w600, rgb(118, 118, 118) on rgb(238,240,242))
  - [Minor] `div.hub-channels-head > span` "채널" — 4.16:1 (기준 4.5:1, 12.5px w700, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.hub-channels-head > button.hub-channels-add` "＋" — 4.16:1 (기준 4.5:1, 15px w400, rgb(118, 118, 118) on rgb(244,245,247))
시각적 1순위 유일: 24px w900 "그룹 입장"
(배경 이미지/그라데이션 때문에 대비 미계산 7개 노드)

### laptop — 텍스트 노드 71개 스캔
**대비 위반 4건** (laptop):
  - [Minor] `button.notif-bell > span.notif-count` "3" — 3.91:1 (기준 4.5:1, 10px w600, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `div.chat-date > span` "오늘" — 3.98:1 (기준 4.5:1, 11px w600, rgb(118, 118, 118) on rgb(238,240,242))
  - [Minor] `div.hub-channels-head > span` "채널" — 4.16:1 (기준 4.5:1, 12.5px w700, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.hub-channels-head > button.hub-channels-add` "＋" — 4.16:1 (기준 4.5:1, 15px w400, rgb(118, 118, 118) on rgb(244,245,247))
시각적 1순위 유일: 24px w900 "그룹 입장"
(배경 이미지/그라데이션 때문에 대비 미계산 7개 노드)

### desktop — 텍스트 노드 71개 스캔
**대비 위반 4건** (desktop):
  - [Minor] `button.notif-bell > span.notif-count` "3" — 3.91:1 (기준 4.5:1, 10px w600, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `div.chat-date > span` "오늘" — 3.98:1 (기준 4.5:1, 11px w600, rgb(118, 118, 118) on rgb(238,240,242))
  - [Minor] `div.hub-channels-head > span` "채널" — 4.16:1 (기준 4.5:1, 12.5px w700, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.hub-channels-head > button.hub-channels-add` "＋" — 4.16:1 (기준 4.5:1, 15px w400, rgb(118, 118, 118) on rgb(244,245,247))
시각적 1순위 유일: 24px w900 "그룹 입장"
(배경 이미지/그라데이션 때문에 대비 미계산 7개 노드)

## schedule-week
### mobile — 텍스트 노드 123개 스캔
**대비 위반 10건** (mobile):
  - [Major] `div.msched-event > span.msched-event-time` "오전 9:00~오후 12:00" — 2.06:1 (기준 4.5:1, 12px w600, rgb(33, 200, 24) on rgb(244,245,247))
  - [Minor] `div.msched-week-gutter > span.msched-nowline-time.week` "01 : 09" — 3.41:1 (기준 4.5:1, 10px w800, rgb(255, 255, 255) on rgb(255,69,58))
  - [Minor] `div.nowbar-pill > span.nb-pill-count` "3" — 3.91:1 (기준 4.5:1, 11px w800, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `div.hub-recap-foot > span.hub-recap-src` "규칙 정리" — 4.16:1 (기준 4.5:1, 11px w600, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.hub-decision-row > span.hub-decision-ack.done` "확인함" — 4.16:1 (기준 4.5:1, 12px w700, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.hub-decision-row > span.hub-decision-stat` "확인 0 / 3" — 4.16:1 (기준 4.5:1, 10.5px w700, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.hub-agenda-row > span.hub-agenda-num` "1" — 4.16:1 (기준 4.5:1, 12px w800, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.msched-event > span.msched-event-author` "이주호" — 4.16:1 (기준 4.5:1, 11px w600, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `span.hub-roster-stack > span.avatar.avatar-initial` "이" — 4.42:1 (기준 4.5:1, 13px w700, rgb(161, 98, 7) on rgb(254,243,199))
  - [Minor] `div.hub-cta-btns > button.hub-join.lg` "통화 참여" — 4.45:1 (기준 4.5:1, 15px w600, rgb(15, 138, 60) on rgb(255,255,255))
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
  - `section.hub-section.pa-ros > div.hub-section-title.clickable` "참가자 3이김박" — 160×22px
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
**대비 위반 11건** (tablet):
  - [Major] `div.msched-event > span.msched-event-time` "오전 9:00~오후 12:00" — 2.06:1 (기준 4.5:1, 12px w600, rgb(33, 200, 24) on rgb(244,245,247))
  - [Minor] `div.msched-week-gutter > span.msched-nowline-time.week` "01 : 09" — 3.41:1 (기준 4.5:1, 10px w800, rgb(255, 255, 255) on rgb(255,69,58))
  - [Minor] `button.notif-bell > span.notif-count` "3" — 3.91:1 (기준 4.5:1, 10px w600, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `span.msched-se-group > span.msched-se-label` "시작" — 4.16:1 (기준 4.5:1, 11.5px w700, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.msched-add-remind.msched-se > span.msched-times-sep` "~" — 4.16:1 (기준 4.5:1, 10px w600, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `span.msched-se-group > span.msched-se-label` "종료" — 4.16:1 (기준 4.5:1, 11.5px w700, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.msched-add-remind > span.msched-people-label` "알림" — 4.16:1 (기준 4.5:1, 12px w600, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.msched-add-remind > span.msched-people-label` "반복" — 4.16:1 (기준 4.5:1, 12px w600, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.msched-add-remind > span.msched-people-label` "색" — 4.16:1 (기준 4.5:1, 12px w600, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.msched-add-people > span.msched-people-label` "관련자" — 4.16:1 (기준 4.5:1, 12px w600, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `form.msched-add > p.msched-add-hint` "추가하면 참가자 전원에게 알림" — 4.16:1 (기준 4.5:1, 12px w400, rgb(118, 118, 118) on rgb(244,245,247))
시각적 1순위 유일: 24px w900 "그룹 입장"
(배경 이미지/그라데이션 때문에 대비 미계산 7개 노드)

### laptop — 텍스트 노드 115개 스캔
**대비 위반 12건** (laptop):
  - [Major] `div.msched-event > span.msched-event-time` "오전 9:00~오후 12:00" — 2.06:1 (기준 4.5:1, 12px w600, rgb(33, 200, 24) on rgb(244,245,247))
  - [Minor] `div.msched-week-gutter > span.msched-nowline-time.week` "01 : 10" — 3.41:1 (기준 4.5:1, 10px w800, rgb(255, 255, 255) on rgb(255,69,58))
  - [Minor] `button.notif-bell > span.notif-count` "3" — 3.91:1 (기준 4.5:1, 10px w600, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `div.msched-event > span.msched-event-author` "이주호" — 4.16:1 (기준 4.5:1, 11px w600, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `span.msched-se-group > span.msched-se-label` "시작" — 4.16:1 (기준 4.5:1, 11.5px w700, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.msched-add-remind.msched-se > span.msched-times-sep` "~" — 4.16:1 (기준 4.5:1, 10px w600, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `span.msched-se-group > span.msched-se-label` "종료" — 4.16:1 (기준 4.5:1, 11.5px w700, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.msched-add-remind > span.msched-people-label` "알림" — 4.16:1 (기준 4.5:1, 12px w600, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.msched-add-remind > span.msched-people-label` "반복" — 4.16:1 (기준 4.5:1, 12px w600, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.msched-add-remind > span.msched-people-label` "색" — 4.16:1 (기준 4.5:1, 12px w600, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.msched-add-people > span.msched-people-label` "관련자" — 4.16:1 (기준 4.5:1, 12px w600, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `form.msched-add > p.msched-add-hint` "추가하면 참가자 전원에게 알림" — 4.16:1 (기준 4.5:1, 12px w400, rgb(118, 118, 118) on rgb(244,245,247))
시각적 1순위 유일: 24px w900 "그룹 입장"
(배경 이미지/그라데이션 때문에 대비 미계산 7개 노드)

### desktop — 텍스트 노드 115개 스캔
**대비 위반 12건** (desktop):
  - [Major] `div.msched-event > span.msched-event-time` "오전 9:00~오후 12:00" — 2.06:1 (기준 4.5:1, 12px w600, rgb(33, 200, 24) on rgb(244,245,247))
  - [Minor] `div.msched-week-gutter > span.msched-nowline-time.week` "01 : 10" — 3.41:1 (기준 4.5:1, 10px w800, rgb(255, 255, 255) on rgb(255,69,58))
  - [Minor] `button.notif-bell > span.notif-count` "3" — 3.91:1 (기준 4.5:1, 10px w600, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `div.msched-event > span.msched-event-author` "이주호" — 4.16:1 (기준 4.5:1, 11px w600, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `span.msched-se-group > span.msched-se-label` "시작" — 4.16:1 (기준 4.5:1, 13.5px w700, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.msched-add-remind.msched-se > span.msched-times-sep` "~" — 4.16:1 (기준 4.5:1, 10px w600, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `span.msched-se-group > span.msched-se-label` "종료" — 4.16:1 (기준 4.5:1, 13.5px w700, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.msched-add-remind > span.msched-people-label` "알림" — 4.16:1 (기준 4.5:1, 12px w600, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.msched-add-remind > span.msched-people-label` "반복" — 4.16:1 (기준 4.5:1, 12px w600, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.msched-add-remind > span.msched-people-label` "색" — 4.16:1 (기준 4.5:1, 12px w600, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.msched-add-people > span.msched-people-label` "관련자" — 4.16:1 (기준 4.5:1, 12px w600, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `form.msched-add > p.msched-add-hint` "추가하면 참가자 전원에게 알림" — 4.16:1 (기준 4.5:1, 12px w400, rgb(118, 118, 118) on rgb(244,245,247))
시각적 1순위 유일: 24px w900 "그룹 입장"
(배경 이미지/그라데이션 때문에 대비 미계산 7개 노드)

## ledger
### mobile — 텍스트 노드 105개 스캔
**대비 위반 9건** (mobile):
  - [Minor] `div.nowbar-pill > span.nb-pill-count` "3" — 3.91:1 (기준 4.5:1, 11px w800, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `div.ledger-decision > span.ledger-critical` "작업 전 확인 필수" — 3.91:1 (기준 4.5:1, 11px w800, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `div.ledger-item.critical > button.ledger-ack.critical` "확인" — 3.91:1 (기준 4.5:1, 12px w700, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `div.hub-recap-foot > span.hub-recap-src` "규칙 정리" — 4.16:1 (기준 4.5:1, 11px w600, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.hub-decision-row > span.hub-decision-ack.done` "확인함" — 4.16:1 (기준 4.5:1, 12px w700, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.hub-decision-row > span.hub-decision-stat` "확인 0 / 3" — 4.16:1 (기준 4.5:1, 10.5px w700, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.hub-agenda-row > span.hub-agenda-num` "1" — 4.16:1 (기준 4.5:1, 12px w800, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `span.hub-roster-stack > span.avatar.avatar-initial` "이" — 4.42:1 (기준 4.5:1, 13px w700, rgb(161, 98, 7) on rgb(254,243,199))
  - [Minor] `div.hub-cta-btns > button.hub-join.lg` "통화 참여" — 4.45:1 (기준 4.5:1, 15px w600, rgb(15, 138, 60) on rgb(255,255,255))
**[Minor] 44px 미만 터치 타겟 15건**:
  - `span.ledger-more-wrap > button.ledger-more-btn` "⋯" — 24×17px
  - `span.ledger-more-wrap > button.ledger-more-btn` "⋯" — 24×17px
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
  - `section.hub-section.pa-ros > div.hub-section-title.clickable` "참가자 3이김박" — 160×22px
  - `section.hub-section.pipe-card > button.pipe-more` "회의 정리 다시 보기" — 130×31px
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

### tablet — 텍스트 노드 71개 스캔
**대비 위반 3건** (tablet):
  - [Minor] `button.notif-bell > span.notif-count` "3" — 3.91:1 (기준 4.5:1, 10px w600, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `div.ledger-decision > span.ledger-critical` "작업 전 확인 필수" — 3.91:1 (기준 4.5:1, 11px w800, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `div.ledger-item.critical > button.ledger-ack.critical` "확인" — 3.91:1 (기준 4.5:1, 12px w700, rgb(255, 255, 255) on rgb(229,72,77))
시각적 1순위 유일: 24px w900 "그룹 입장"
(배경 이미지/그라데이션 때문에 대비 미계산 7개 노드)

### laptop — 텍스트 노드 71개 스캔
**대비 위반 3건** (laptop):
  - [Minor] `button.notif-bell > span.notif-count` "3" — 3.91:1 (기준 4.5:1, 10px w600, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `div.ledger-decision > span.ledger-critical` "작업 전 확인 필수" — 3.91:1 (기준 4.5:1, 11px w800, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `div.ledger-item.critical > button.ledger-ack.critical` "확인" — 3.91:1 (기준 4.5:1, 12px w700, rgb(255, 255, 255) on rgb(229,72,77))
시각적 1순위 유일: 24px w900 "그룹 입장"
(배경 이미지/그라데이션 때문에 대비 미계산 7개 노드)

### desktop — 텍스트 노드 71개 스캔
**대비 위반 3건** (desktop):
  - [Minor] `button.notif-bell > span.notif-count` "3" — 3.91:1 (기준 4.5:1, 10px w600, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `div.ledger-decision > span.ledger-critical` "작업 전 확인 필수" — 3.91:1 (기준 4.5:1, 11px w800, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `div.ledger-item.critical > button.ledger-ack.critical` "확인" — 3.91:1 (기준 4.5:1, 12px w700, rgb(255, 255, 255) on rgb(229,72,77))
시각적 1순위 유일: 24px w900 "그룹 입장"
(배경 이미지/그라데이션 때문에 대비 미계산 7개 노드)

## files
### mobile — 텍스트 노드 98개 스캔
**대비 위반 9건** (mobile):
  - [Minor] `div.cf-mack > button.cf-mack-banner` "확인 필요 1 건 — 열람 서명이 남" — 3.43:1 (기준 4.5:1, 13.5px w700, rgb(229, 72, 77) on rgb(253,236,236))
  - [Minor] `div.nowbar-pill > span.nb-pill-count` "3" — 3.91:1 (기준 4.5:1, 11px w800, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `button.cf-mack-row > span.cf-ack-cell` "0 / 3" — 3.91:1 (기준 4.5:1, 12.5px w600, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div.hub-recap-foot > span.hub-recap-src` "규칙 정리" — 4.16:1 (기준 4.5:1, 11px w600, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.hub-decision-row > span.hub-decision-ack.done` "확인함" — 4.16:1 (기준 4.5:1, 12px w700, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.hub-decision-row > span.hub-decision-stat` "확인 0 / 3" — 4.16:1 (기준 4.5:1, 10.5px w700, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.hub-agenda-row > span.hub-agenda-num` "1" — 4.16:1 (기준 4.5:1, 12px w800, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `span.hub-roster-stack > span.avatar.avatar-initial` "이" — 4.42:1 (기준 4.5:1, 13px w700, rgb(161, 98, 7) on rgb(254,243,199))
  - [Minor] `div.hub-cta-btns > button.hub-join.lg` "통화 참여" — 4.45:1 (기준 4.5:1, 15px w600, rgb(15, 138, 60) on rgb(255,255,255))
**[Minor] 44px 미만 터치 타겟 16건**:
  - `div.cf-head > button.cf-add` "" — 26×20px
  - `div.hub-m-back > button` "" — 40×28px
  - `form.hub-todo-add > button` "추가" — 53×34px
  - `div.hub-recap-next.suggest > button.hub-recap-next-btn` "겹치는 시간 찾기" — 122×23px
  - `section.hub-section.pipe-card > button.pipe-cta` "일정 잡기" — 98×31px
  - `section.hub-section.pa-ros > div.hub-section-title.clickable` "참가자 3이김박" — 160×22px
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
**대비 위반 7건** (tablet):
  - [Minor] `div.cf-ack-head > b.due` "0/3" — 3.59:1 (기준 4.5:1, 12.5px w900, rgb(229, 72, 77) on rgb(244,245,247))
  - [Minor] `button.notif-bell > span.notif-count` "3" — 3.91:1 (기준 4.5:1, 10px w600, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `span.cf-ack-pend > span` "이주호" — 4.16:1 (기준 4.5:1, 12px w400, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `span.cf-ack-pend > span` "박민수" — 4.16:1 (기준 4.5:1, 12px w400, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `span.cf-ack-pend > span` "김소희" — 4.16:1 (기준 4.5:1, 12px w400, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.cf-ack > div.cf-ack-auto` "서명이 이틀째 없으면 AI가 자동으로" — 4.16:1 (기준 4.5:1, 11px w400, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `span.cf-ack-pend > span.avatar.avatar-initial` "이" — 4.42:1 (기준 4.5:1, 12px w700, rgb(161, 98, 7) on rgb(254,243,199))
시각적 1순위 유일: 24px w900 "그룹 입장"
(배경 이미지/그라데이션 때문에 대비 미계산 7개 노드)

### laptop — 텍스트 노드 97개 스캔
**대비 위반 7건** (laptop):
  - [Minor] `div.cf-ack-head > b.due` "0/3" — 3.59:1 (기준 4.5:1, 12.5px w900, rgb(229, 72, 77) on rgb(244,245,247))
  - [Minor] `button.notif-bell > span.notif-count` "3" — 3.91:1 (기준 4.5:1, 10px w600, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `span.cf-ack-pend > span` "이주호" — 4.16:1 (기준 4.5:1, 12px w400, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `span.cf-ack-pend > span` "박민수" — 4.16:1 (기준 4.5:1, 12px w400, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `span.cf-ack-pend > span` "김소희" — 4.16:1 (기준 4.5:1, 12px w400, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.cf-ack > div.cf-ack-auto` "서명이 이틀째 없으면 AI가 자동으로" — 4.16:1 (기준 4.5:1, 11px w400, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `span.cf-ack-pend > span.avatar.avatar-initial` "이" — 4.42:1 (기준 4.5:1, 12px w700, rgb(161, 98, 7) on rgb(254,243,199))
시각적 1순위 유일: 24px w900 "그룹 입장"
(배경 이미지/그라데이션 때문에 대비 미계산 7개 노드)

### desktop — 텍스트 노드 97개 스캔
**대비 위반 7건** (desktop):
  - [Minor] `div.cf-ack-head > b.due` "0/3" — 3.59:1 (기준 4.5:1, 12.5px w900, rgb(229, 72, 77) on rgb(244,245,247))
  - [Minor] `button.notif-bell > span.notif-count` "3" — 3.91:1 (기준 4.5:1, 10px w600, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `span.cf-ack-pend > span` "이주호" — 4.16:1 (기준 4.5:1, 12px w400, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `span.cf-ack-pend > span` "박민수" — 4.16:1 (기준 4.5:1, 12px w400, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `span.cf-ack-pend > span` "김소희" — 4.16:1 (기준 4.5:1, 12px w400, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.cf-ack > div.cf-ack-auto` "서명이 이틀째 없으면 AI가 자동으로" — 4.16:1 (기준 4.5:1, 11px w400, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `span.cf-ack-pend > span.avatar.avatar-initial` "이" — 4.42:1 (기준 4.5:1, 12px w700, rgb(161, 98, 7) on rgb(254,243,199))
시각적 1순위 유일: 24px w900 "그룹 입장"
(배경 이미지/그라데이션 때문에 대비 미계산 7개 노드)

## hub-settings
### mobile — 텍스트 노드 120개 스캔
**대비 위반 9건** (mobile):
  - [Minor] `div.nowbar-pill > span.nb-pill-count` "3" — 3.91:1 (기준 4.5:1, 11px w800, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `section.hub-set-card.danger-zone > button.hub-danger-btn` "이 회의 삭제하기" — 3.91:1 (기준 4.5:1, 14px w600, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div.hub-recap-foot > span.hub-recap-src` "규칙 정리" — 4.16:1 (기준 4.5:1, 11px w600, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.hub-decision-row > span.hub-decision-ack.done` "확인함" — 4.16:1 (기준 4.5:1, 12px w700, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.hub-decision-row > span.hub-decision-stat` "확인 0 / 3" — 4.16:1 (기준 4.5:1, 10.5px w700, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.hub-agenda-row > span.hub-agenda-num` "1" — 4.16:1 (기준 4.5:1, 12px w800, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `span.hub-roster-stack > span.avatar.avatar-initial` "이" — 4.42:1 (기준 4.5:1, 13px w700, rgb(161, 98, 7) on rgb(254,243,199))
  - [Minor] `div.hub-set-person > span.avatar.avatar-initial` "이" — 4.42:1 (기준 4.5:1, 16px w700, rgb(161, 98, 7) on rgb(254,243,199))
  - [Minor] `div.hub-cta-btns > button.hub-join.lg` "통화 참여" — 4.45:1 (기준 4.5:1, 15px w600, rgb(15, 138, 60) on rgb(255,255,255))
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
  - `div.hub-invite-row > button.hub-set-btn` "코드 6LELKW" — 120×29px
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
**대비 위반 3건** (tablet):
  - [Minor] `button.notif-bell > span.notif-count` "3" — 3.91:1 (기준 4.5:1, 10px w600, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `section.hub-set-card.danger-zone > button.hub-danger-btn` "이 회의 삭제하기" — 3.91:1 (기준 4.5:1, 14px w600, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div.hub-set-person > span.avatar.avatar-initial` "이" — 4.42:1 (기준 4.5:1, 16px w700, rgb(161, 98, 7) on rgb(254,243,199))
시각적 1순위 유일: 24px w900 "그룹 입장"
(배경 이미지/그라데이션 때문에 대비 미계산 7개 노드)

### laptop — 텍스트 노드 86개 스캔
**대비 위반 3건** (laptop):
  - [Minor] `button.notif-bell > span.notif-count` "3" — 3.91:1 (기준 4.5:1, 10px w600, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `section.hub-set-card.danger-zone > button.hub-danger-btn` "이 회의 삭제하기" — 3.91:1 (기준 4.5:1, 14px w600, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div.hub-set-person > span.avatar.avatar-initial` "이" — 4.42:1 (기준 4.5:1, 16px w700, rgb(161, 98, 7) on rgb(254,243,199))
시각적 1순위 유일: 24px w900 "그룹 입장"
(배경 이미지/그라데이션 때문에 대비 미계산 7개 노드)

### desktop — 텍스트 노드 86개 스캔
**대비 위반 3건** (desktop):
  - [Minor] `button.notif-bell > span.notif-count` "3" — 3.91:1 (기준 4.5:1, 10px w600, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `section.hub-set-card.danger-zone > button.hub-danger-btn` "이 회의 삭제하기" — 3.91:1 (기준 4.5:1, 14px w600, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div.hub-set-person > span.avatar.avatar-initial` "이" — 4.42:1 (기준 4.5:1, 16px w700, rgb(161, 98, 7) on rgb(254,243,199))
시각적 1순위 유일: 24px w900 "그룹 입장"
(배경 이미지/그라데이션 때문에 대비 미계산 7개 노드)

## home-org
### mobile — 텍스트 노드 92개 스캔
**대비 위반 11건** (mobile):
  - [Minor] `div > div` "토" — 3.81:1 (기준 4.5:1, 11px w600, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div > button` "5" — 3.81:1 (기준 4.5:1, 12.5px w400, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div > button` "12" — 3.81:1 (기준 4.5:1, 12.5px w400, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div > button` "19" — 3.81:1 (기준 4.5:1, 12.5px w400, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div > button` "26" — 3.81:1 (기준 4.5:1, 12.5px w400, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div.nowbar-pill > span.nb-pill-count` "3" — 3.91:1 (기준 4.5:1, 11px w800, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `div > div` "일" — 3.91:1 (기준 4.5:1, 11px w600, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div > button` "6" — 3.91:1 (기준 4.5:1, 12.5px w400, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div > button` "13" — 3.91:1 (기준 4.5:1, 12.5px w400, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div > button` "20" — 3.91:1 (기준 4.5:1, 12.5px w400, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div > button` "27" — 3.91:1 (기준 4.5:1, 12.5px w400, rgb(229, 72, 77) on rgb(255,255,255))
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
**대비 위반 11건** (tablet):
  - [Minor] `div > div` "토" — 3.81:1 (기준 4.5:1, 11px w600, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div > button` "5" — 3.81:1 (기준 4.5:1, 12.5px w400, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div > button` "12" — 3.81:1 (기준 4.5:1, 12.5px w400, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div > button` "19" — 3.81:1 (기준 4.5:1, 12.5px w400, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div > button` "26" — 3.81:1 (기준 4.5:1, 12.5px w400, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `button.notif-bell > span.notif-count` "3" — 3.91:1 (기준 4.5:1, 10px w600, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `div > div` "일" — 3.91:1 (기준 4.5:1, 11px w600, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div > button` "6" — 3.91:1 (기준 4.5:1, 12.5px w400, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div > button` "13" — 3.91:1 (기준 4.5:1, 12.5px w400, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div > button` "20" — 3.91:1 (기준 4.5:1, 12.5px w400, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div > button` "27" — 3.91:1 (기준 4.5:1, 12.5px w400, rgb(229, 72, 77) on rgb(255,255,255))
시각적 1순위 유일: 24px w900 "그룹 입장"
(배경 이미지/그라데이션 때문에 대비 미계산 14개 노드)

### laptop — 텍스트 노드 107개 스캔
**대비 위반 11건** (laptop):
  - [Minor] `div > div` "토" — 3.81:1 (기준 4.5:1, 11px w600, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div > button` "5" — 3.81:1 (기준 4.5:1, 12.5px w400, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div > button` "12" — 3.81:1 (기준 4.5:1, 12.5px w400, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div > button` "19" — 3.81:1 (기준 4.5:1, 12.5px w400, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div > button` "26" — 3.81:1 (기준 4.5:1, 12.5px w400, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `button.notif-bell > span.notif-count` "3" — 3.91:1 (기준 4.5:1, 10px w600, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `div > div` "일" — 3.91:1 (기준 4.5:1, 11px w600, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div > button` "6" — 3.91:1 (기준 4.5:1, 12.5px w400, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div > button` "13" — 3.91:1 (기준 4.5:1, 12.5px w400, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div > button` "20" — 3.91:1 (기준 4.5:1, 12.5px w400, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div > button` "27" — 3.91:1 (기준 4.5:1, 12.5px w400, rgb(229, 72, 77) on rgb(255,255,255))
**[Cosmetic] 시각적 1순위 동률 3개** (26px w900): "0건", "0건", "0건"
(배경 이미지/그라데이션 때문에 대비 미계산 14개 노드)

### desktop — 텍스트 노드 107개 스캔
**대비 위반 11건** (desktop):
  - [Minor] `div > div` "토" — 3.81:1 (기준 4.5:1, 11px w600, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div > button` "5" — 3.81:1 (기준 4.5:1, 12.5px w400, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div > button` "12" — 3.81:1 (기준 4.5:1, 12.5px w400, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div > button` "19" — 3.81:1 (기준 4.5:1, 12.5px w400, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `div > button` "26" — 3.81:1 (기준 4.5:1, 12.5px w400, rgb(59, 124, 255) on rgb(255,255,255))
  - [Minor] `button.notif-bell > span.notif-count` "3" — 3.91:1 (기준 4.5:1, 10px w600, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `div > div` "일" — 3.91:1 (기준 4.5:1, 11px w600, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div > button` "6" — 3.91:1 (기준 4.5:1, 12.5px w400, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div > button` "13" — 3.91:1 (기준 4.5:1, 12.5px w400, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div > button` "20" — 3.91:1 (기준 4.5:1, 12.5px w400, rgb(229, 72, 77) on rgb(255,255,255))
  - [Minor] `div > button` "27" — 3.91:1 (기준 4.5:1, 12.5px w400, rgb(229, 72, 77) on rgb(255,255,255))
**[Cosmetic] 시각적 1순위 동률 3개** (26px w900): "0건", "0건", "0건"
(배경 이미지/그라데이션 때문에 대비 미계산 14개 노드)

## orgchart
### mobile — 텍스트 노드 61개 스캔
**대비 위반 7건** (mobile):
  - [Minor] `div.nowbar-pill > span.nb-pill-count` "3" — 3.91:1 (기준 4.5:1, 11px w800, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `div.orgchart-pos > span.org-tier.field` "현장" — 4.12:1 (기준 4.5:1, 10.5px w700, rgb(180, 83, 9) on rgb(244,231,209))
  - [Minor] `div.orgchart-pos > span.org-tier.field` "현장" — 4.12:1 (기준 4.5:1, 10.5px w700, rgb(180, 83, 9) on rgb(244,231,209))
  - [Minor] `span.orgchart-invite > button.orgchart-editmode` "관리 모드" — 4.16:1 (기준 4.5:1, 13px w600, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.orgchart-pos > span.org-tier.relay` "중간관리" — 4.19:1 (기준 4.5:1, 10.5px w700, rgb(147, 51, 234) on rgb(233,223,247))
  - [Minor] `span.orgchart-invite > button.orgchart-code` "가입코드" — 4.21:1 (기준 4.5:1, 13px w600, rgb(118, 118, 118) on rgb(234,251,232))
  - [Minor] `span.orgchart-invite > button.orgchart-code` "초대 링크" — 4.21:1 (기준 4.5:1, 13px w600, rgb(118, 118, 118) on rgb(234,251,232))
**[Minor] 44px 미만 터치 타겟 7건**:
  - `div.orgchart-page.orgchart-embed > button.orgchart-back` "홈" — 31×33px
  - `div > button` "ESG · 원격근무 사회적 가치 보기" — 215×16px
  - `span.orgchart-invite > button.orgchart-code` "초대 링크" — 100×38px
  - `span.orgchart-invite > button.orgchart-editmode` "관리 모드" — 100×38px
  - `span.orgchart-invite > button.orgchart-manage` "역할 관리" — 102×38px
  - `span.orgchart-invite > button.orgchart-code` "가입코드 JAEH-2X6C" — 170×38px
  - `main.dashboard > button.m-orgbar` "런타임 제조" — 390×24px
**[Cosmetic] 모바일 16px 미만 본문 1건**:
  - `span.marquee.countdown > span.marquee-inner.on` "'주간 품질 회의'에 일정 추가 — " — 14px
시각적 1순위 유일: 24px w900 "런타임 제조"
(배경 이미지/그라데이션 때문에 대비 미계산 5개 노드)

### tablet — 텍스트 노드 75개 스캔
**대비 위반 7건** (tablet):
  - [Minor] `button.notif-bell > span.notif-count` "3" — 3.91:1 (기준 4.5:1, 10px w600, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `div.orgchart-pos > span.org-tier.field` "현장" — 4.12:1 (기준 4.5:1, 10.5px w700, rgb(180, 83, 9) on rgb(244,231,209))
  - [Minor] `div.orgchart-pos > span.org-tier.field` "현장" — 4.12:1 (기준 4.5:1, 10.5px w700, rgb(180, 83, 9) on rgb(244,231,209))
  - [Minor] `span.orgchart-invite > button.orgchart-editmode` "관리 모드" — 4.16:1 (기준 4.5:1, 13px w600, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.orgchart-pos > span.org-tier.relay` "중간관리" — 4.19:1 (기준 4.5:1, 10.5px w700, rgb(147, 51, 234) on rgb(233,223,247))
  - [Minor] `span.orgchart-invite > button.orgchart-code` "가입코드" — 4.21:1 (기준 4.5:1, 13px w600, rgb(118, 118, 118) on rgb(234,251,232))
  - [Minor] `span.orgchart-invite > button.orgchart-code` "초대 링크" — 4.21:1 (기준 4.5:1, 13px w600, rgb(118, 118, 118) on rgb(234,251,232))
**[Cosmetic] 시각적 1순위 동률 2개** (24px w900): "그룹 입장", "런타임 제조"
(배경 이미지/그라데이션 때문에 대비 미계산 5개 노드)

### laptop — 텍스트 노드 75개 스캔
**대비 위반 7건** (laptop):
  - [Minor] `button.notif-bell > span.notif-count` "3" — 3.91:1 (기준 4.5:1, 10px w600, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `div.orgchart-pos > span.org-tier.field` "현장" — 4.12:1 (기준 4.5:1, 10.5px w700, rgb(180, 83, 9) on rgb(244,231,209))
  - [Minor] `div.orgchart-pos > span.org-tier.field` "현장" — 4.12:1 (기준 4.5:1, 10.5px w700, rgb(180, 83, 9) on rgb(244,231,209))
  - [Minor] `span.orgchart-invite > button.orgchart-editmode` "관리 모드" — 4.16:1 (기준 4.5:1, 13px w600, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.orgchart-pos > span.org-tier.relay` "중간관리" — 4.19:1 (기준 4.5:1, 10.5px w700, rgb(147, 51, 234) on rgb(233,223,247))
  - [Minor] `span.orgchart-invite > button.orgchart-code` "가입코드" — 4.21:1 (기준 4.5:1, 13px w600, rgb(118, 118, 118) on rgb(234,251,232))
  - [Minor] `span.orgchart-invite > button.orgchart-code` "초대 링크" — 4.21:1 (기준 4.5:1, 13px w600, rgb(118, 118, 118) on rgb(234,251,232))
**[Cosmetic] 시각적 1순위 동률 2개** (24px w900): "그룹 입장", "런타임 제조"
(배경 이미지/그라데이션 때문에 대비 미계산 5개 노드)

### desktop — 텍스트 노드 75개 스캔
**대비 위반 7건** (desktop):
  - [Minor] `button.notif-bell > span.notif-count` "3" — 3.91:1 (기준 4.5:1, 10px w600, rgb(255, 255, 255) on rgb(229,72,77))
  - [Minor] `div.orgchart-pos > span.org-tier.field` "현장" — 4.12:1 (기준 4.5:1, 10.5px w700, rgb(180, 83, 9) on rgb(244,231,209))
  - [Minor] `div.orgchart-pos > span.org-tier.field` "현장" — 4.12:1 (기준 4.5:1, 10.5px w700, rgb(180, 83, 9) on rgb(244,231,209))
  - [Minor] `span.orgchart-invite > button.orgchart-editmode` "관리 모드" — 4.16:1 (기준 4.5:1, 13px w600, rgb(118, 118, 118) on rgb(244,245,247))
  - [Minor] `div.orgchart-pos > span.org-tier.relay` "중간관리" — 4.19:1 (기준 4.5:1, 10.5px w700, rgb(147, 51, 234) on rgb(233,223,247))
  - [Minor] `span.orgchart-invite > button.orgchart-code` "가입코드" — 4.21:1 (기준 4.5:1, 13px w600, rgb(118, 118, 118) on rgb(234,251,232))
  - [Minor] `span.orgchart-invite > button.orgchart-code` "초대 링크" — 4.21:1 (기준 4.5:1, 13px w600, rgb(118, 118, 118) on rgb(234,251,232))
**[Cosmetic] 시각적 1순위 동률 2개** (24px w900): "그룹 입장", "런타임 제조"
(배경 이미지/그라데이션 때문에 대비 미계산 5개 노드)

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
