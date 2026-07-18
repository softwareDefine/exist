import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { ruleBasedRecap, runRecapForMeeting } from '../recap.js';
import db from '../db.js';

/*
 * P1 검증 — 회의 통화 종료 → 결정·할 일 추출 → 참석/불참 라우팅 → 배달.
 * OPENAI_API_KEY 없는 테스트 환경이므로 추출은 규칙 폴백 경로를 탄다
 * (AI 경로는 같은 인터페이스로 갈아끼우는 구조라 폴백 검증이 곧 파이프라인 검증).
 */
const app = createApp();

async function registerUser(username: string, password = 'password123') {
  const r = await request(app).post('/api/auth/register').send({ username, password });
  return r.body as { token: string };
}

function userId(username: string): number {
  return (db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number }).id;
}

describe('ruleBasedRecap — 규칙 기반 추출 (단위)', () => {
  it('결정 키워드를 decisions로 뽑는다', () => {
    const r = ruleBasedRecap(
      [
        { from: 'juho', text: '안녕하세요' },
        { from: 'juho', text: '출시일은 8월 말로 확정합니다' },
        { from: 'sohee', text: '네 그렇게 하기로 해요' },
      ],
      ['juho', 'sohee'],
    );
    expect(r.source).toBe('rule');
    expect(r.decisions.length).toBe(2);
    expect(r.summary).toContain('확정');
  });

  it('@멘션이 참여자와 일치하면 할 일 담당자로 배정한다', () => {
    const r = ruleBasedRecap(
      [
        { from: 'juho', text: '@sohee 데모 영상 콘티 금요일까지 부탁해요' },
        { from: 'sohee', text: '네, 제가 시나리오 초안도 쓸게요' },
        { from: 'juho', text: '@없는사람 이건 매칭 안 됨 해주세요' },
      ],
      ['juho', 'sohee'],
    );
    expect(r.actions.length).toBe(3);
    expect(r.actions[0].assignee).toBe('sohee'); // @멘션 매칭
    expect(r.actions[1].assignee).toBe('sohee'); // "제가 ...쓸게요" → 화자
    expect(r.actions[2].assignee).toBeNull(); // 참여자 아님
  });

  it('결정이 없으면 요약에 논의 건수를 담는다', () => {
    const r = ruleBasedRecap(
      [
        { from: 'a', text: '그냥 잡담' },
        { from: 'b', text: '네네' },
      ],
      ['a', 'b'],
    );
    expect(r.decisions).toHaveLength(0);
    expect(r.summary).toContain('2건');
  });
});

describe('runRecapForMeeting — 파이프라인 (통합)', () => {
  async function setupMeeting() {
    const host = await registerUser('recap_host');
    const absent = await registerUser('recap_absent');
    const m = await request(app)
      .post('/api/meetings')
      .set('Authorization', `Bearer ${host.token}`)
      .send({ title: '본사 기획 회의' });
    const code = m.body.code as string;
    // 불참자도 회의에는 등록돼 있어야 한다 (배달 대상)
    await request(app)
      .post('/api/meetings/join')
      .set('Authorization', `Bearer ${absent.token}`)
      .send({ code });
    const meetingId = (
      db.prepare('SELECT id FROM meetings WHERE code = ?').get(code) as { id: number }
    ).id;
    return { host, absent, code, meetingId };
  }

  function insertChat(meetingId: number, username: string, text: string) {
    db.prepare('INSERT INTO messages (meeting_id, user_id, text) VALUES (?, ?, ?)').run(
      meetingId,
      userId(username),
      text,
    );
  }

  it('통화 종료 → recap 저장 + 참석/불참 구분 배달 + 할 일 자동 배정', async () => {
    const { host, absent, code, meetingId } = await setupMeeting();
    insertChat(meetingId, 'recap_host', '오송 라인 점검 일정은 다음 주 화요일로 확정합니다');
    insertChat(meetingId, 'recap_host', '@recap_absent 점검 체크리스트 월요일까지 부탁해요');

    // 통화에는 host만 들어왔다 나감 (absent는 불참)
    const recapId = await runRecapForMeeting(code, [userId('recap_host')]);
    expect(recapId).not.toBeNull();

    // 저장 검증
    const row = db
      .prepare('SELECT summary, decisions, actions, attendees, source FROM meeting_recaps WHERE id = ?')
      .get(recapId) as { summary: string; decisions: string; actions: string; attendees: string; source: string };
    expect(row.source).toBe('rule');
    expect(JSON.parse(row.decisions).length).toBeGreaterThan(0);
    expect(JSON.parse(row.attendees)).toEqual(['recap_host']);

    // 라우팅 검증 — 불참자에겐 "놓친 통화" 문구 + 배정 안내
    const absentNoti = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${absent.token}`);
    const recapNoti = absentNoti.body.items.find((n: { kind: string }) => n.kind === 'recap');
    expect(recapNoti).toBeTruthy();
    expect(recapNoti.text).toContain('놓친');
    expect(recapNoti.text).toContain('내 할 일 1개 배정됨');
    expect(recapNoti.meeting.code).toBe(code);

    // 참석자(host)에겐 "통화 정리" 문구
    const hostNoti = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${host.token}`);
    const hostRecap = hostNoti.body.items.find((n: { kind: string }) => n.kind === 'recap');
    expect(hostRecap.text).toContain('통화 정리');
    expect(hostRecap.text).not.toContain('놓친');

    // 할 일 자동 생성 — @멘션된 불참자에게
    const todos = db
      .prepare('SELECT title FROM todos WHERE user_id = ? AND meeting_id = ?')
      .all(userId('recap_absent'), meetingId) as { title: string }[];
    expect(todos).toHaveLength(1);
    expect(todos[0].title).toContain('체크리스트');
  });

  it('메시지가 거의 없으면 조용히 스킵한다', async () => {
    const host = await registerUser('recap_quiet');
    const m = await request(app)
      .post('/api/meetings')
      .set('Authorization', `Bearer ${host.token}`)
      .send({ title: '조용한 회의' });
    const recapId = await runRecapForMeeting(m.body.code, [userId('recap_quiet')]);
    expect(recapId).toBeNull();
  });

  it('두 번째 recap은 첫 recap 이후 메시지만 본다 (창 분리)', async () => {
    const { code, meetingId } = await setupMeeting2();
    insertChat2(meetingId, 'recap_h2', '1차 회의는 A안으로 확정');
    insertChat2(meetingId, 'recap_h2', 'A안 세부 정리 부탁해요');
    const first = await runRecapForMeeting(code, [userId('recap_h2')]);
    expect(first).not.toBeNull();

    // 새 메시지 없이 또 종료 → 스킵
    const second = await runRecapForMeeting(code, [userId('recap_h2')]);
    expect(second).toBeNull();
  });

  async function setupMeeting2() {
    const host = await registerUser('recap_h2');
    const m = await request(app)
      .post('/api/meetings')
      .set('Authorization', `Bearer ${host.token}`)
      .send({ title: '창 분리 회의' });
    const meetingId = (
      db.prepare('SELECT id FROM meetings WHERE code = ?').get(m.body.code) as { id: number }
    ).id;
    return { host, code: m.body.code as string, meetingId };
  }

  function insertChat2(meetingId: number, username: string, text: string) {
    db.prepare('INSERT INTO messages (meeting_id, user_id, text) VALUES (?, ?, ?)').run(
      meetingId,
      userId(username),
      text,
    );
  }

  it('recap API — 참가자만 조회 가능 (403)', async () => {
    const { host, code, meetingId } = await setupMeeting2b();
    insertChat2(meetingId, 'recap_h3', 'B안으로 결정했습니다');
    insertChat2(meetingId, 'recap_h3', '자료 정리 해주세요');
    await runRecapForMeeting(code, [userId('recap_h3')]);

    const ok = await request(app)
      .get(`/api/meetings/${code}/recaps`)
      .set('Authorization', `Bearer ${host.token}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toHaveLength(1);
    expect(ok.body[0].decisions.length).toBeGreaterThan(0);

    const stranger = await registerUser('recap_stranger');
    const no = await request(app)
      .get(`/api/meetings/${code}/recaps`)
      .set('Authorization', `Bearer ${stranger.token}`);
    expect(no.status).toBe(403);
  });

  async function setupMeeting2b() {
    const host = await registerUser('recap_h3');
    const m = await request(app)
      .post('/api/meetings')
      .set('Authorization', `Bearer ${host.token}`)
      .send({ title: '권한 회의' });
    const meetingId = (
      db.prepare('SELECT id FROM meetings WHERE code = ?').get(m.body.code) as { id: number }
    ).id;
    return { host, code: m.body.code as string, meetingId };
  }

  it('통화 음성 전사도 recap 재료가 된다 (채팅 없이 음성만으로 결정 추출)', async () => {
    const host = await registerUser('recap_voice');
    const m = await request(app)
      .post('/api/meetings')
      .set('Authorization', `Bearer ${host.token}`)
      .send({ title: '음성 회의' });
    const mid = (
      db.prepare('SELECT id FROM meetings WHERE code = ?').get(m.body.code) as { id: number }
    ).id;
    const uid = userId('recap_voice');
    db.prepare('INSERT INTO call_transcripts (meeting_id, user_id, text) VALUES (?, ?, ?)').run(
      mid,
      uid,
      '점검 일정은 다음 주 화요일로 확정합니다',
    );
    db.prepare('INSERT INTO call_transcripts (meeting_id, user_id, text) VALUES (?, ?, ?)').run(
      mid,
      uid,
      '제가 체크리스트 정리할게요',
    );

    const recapId = await runRecapForMeeting(m.body.code, [uid]);
    expect(recapId).not.toBeNull();
    const row = db
      .prepare('SELECT decisions, actions FROM meeting_recaps WHERE id = ?')
      .get(recapId) as { decisions: string; actions: string };
    expect(JSON.parse(row.decisions).length).toBe(1);
    // 음성 화자의 "제가 …게요" 자기 배정도 동작 (화자명이 순수 username이라)
    const actions = JSON.parse(row.actions) as { assignee: string | null }[];
    expect(actions[0].assignee).toBe('recap_voice');
  });

  it('recap·chat_reads가 있어도 회의 삭제가 된다 (FK 강제 환경 회귀 — 라이브 QA 발견 버그)', async () => {
    db.pragma('foreign_keys = ON'); // 라이브 DB가 FK를 강제하는 상황 재현
    try {
      const host = await registerUser('recap_del');
      const m = await request(app)
        .post('/api/meetings')
        .set('Authorization', `Bearer ${host.token}`)
        .send({ title: '삭제될 회의' });
      const mid = (
        db.prepare('SELECT id FROM meetings WHERE code = ?').get(m.body.code) as { id: number }
      ).id;
      db.prepare('INSERT INTO messages (meeting_id, user_id, text) VALUES (?, ?, ?)').run(
        mid,
        userId('recap_del'),
        'A안으로 확정합니다',
      );
      db.prepare('INSERT INTO messages (meeting_id, user_id, text) VALUES (?, ?, ?)').run(
        mid,
        userId('recap_del'),
        '정리 부탁해요',
      );
      await runRecapForMeeting(m.body.code, [userId('recap_del')]);
      db.prepare(
        'INSERT INTO chat_reads (user_id, meeting_id, last_read) VALUES (?, ?, 0)',
      ).run(userId('recap_del'), mid);

      const del = await request(app)
        .delete(`/api/meetings/${m.body.code}`)
        .set('Authorization', `Bearer ${host.token}`);
      expect(del.status).toBe(200);
      expect(db.prepare('SELECT COUNT(*) AS n FROM meeting_recaps WHERE meeting_id = ?').get(mid)).toEqual({ n: 0 });
    } finally {
      db.pragma('foreign_keys = OFF');
    }
  });
});
