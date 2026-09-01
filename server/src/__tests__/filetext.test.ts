import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import { createApp } from '../app.js';
import db from '../db.js';
import { extractUploadedFileText } from '../filetext.js';
import { buildHwp, buildCfb, hwpParaText, hwpRecord, hwpFileHeader, HWPTAG_PARA_HEADER } from './helpers/cfb.js';

/*
 * filetext.ts — 업로드 파일(blob) 본문 추출(RAG 색인용).
 * 평문(txt·md…) / zip+XML(hwpx·docx·xlsx·pptx) / 한글 hwp(CFB 바이너리, 섹션 inflate) / 비지원·손상·암호 = null.
 * 픽스처는 전부 테스트 안에서 조립한다 (helpers/cfb.ts, JSZip).
 */
const app = createApp();
const BLOB_DIR = path.join(process.env.DATA_DIR!, 'uploads-files');
let meetingId = 0;
let userId = 0;

beforeAll(async () => {
  const r = await request(app).post('/api/auth/register').send({ username: 'ft_user', password: 'password123' });
  userId = r.body.user.id;
  const m = await request(app).post('/api/meetings').set('Authorization', `Bearer ${r.body.token}`).send({ title: 'ft 그룹' });
  meetingId = (db.prepare('SELECT id FROM meetings WHERE code = ?').get(m.body.code) as { id: number }).id;
  fs.mkdirSync(BLOB_DIR, { recursive: true });
});

let seq = 0;
/** blob을 DATA_DIR/uploads-files에 쓰고 collab_files(type='file') 행을 만든다 → fileId */
function seedBlob(name: string, data: Buffer | null, opts: { type?: string; blobPath?: string | null } = {}): number {
  const blobPath = opts.blobPath === undefined ? `ft-${++seq}` : opts.blobPath;
  if (data && blobPath) fs.writeFileSync(path.join(BLOB_DIR, blobPath), data);
  return db
    .prepare('INSERT INTO collab_files (meeting_id, name, type, created_by, blob_path, size) VALUES (?, ?, ?, ?, ?, ?)')
    .run(meetingId, name, opts.type ?? 'file', userId, blobPath, data?.length ?? 0).lastInsertRowid as number;
}

async function zipOf(entries: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [k, v] of Object.entries(entries)) zip.file(k, v);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('평문류', () => {
  it('txt·md·csv 등은 utf8 그대로, 40,000자에서 자른다', async () => {
    expect(await extractUploadedFileText(seedBlob('메모.txt', Buffer.from('한글 메모\n둘째 줄')))).toBe('한글 메모\n둘째 줄');
    expect(await extractUploadedFileText(seedBlob('README.MD', Buffer.from('# 제목')))).toBe('# 제목');
    const long = 'a'.repeat(50_000);
    expect((await extractUploadedFileText(seedBlob('big.log', Buffer.from(long))))!.length).toBe(40_000);
  });

  it('바이너리를 .txt로 올린 경우(널·대체문자 다수)는 null', async () => {
    const bin = Buffer.alloc(300);
    for (let i = 0; i < bin.length; i++) bin[i] = i % 2 ? 0 : 0xff;
    expect(await extractUploadedFileText(seedBlob('fake.txt', bin))).toBeNull();
  });

  it('행 없음 · 편집 문서(type≠file) · blob_path 없음 · 파일 사라짐 · 비지원 확장자(pdf) · 30MB 초과는 null', async () => {
    expect(await extractUploadedFileText(999_999)).toBeNull();
    expect(await extractUploadedFileText(seedBlob('문서.txt', Buffer.from('x'), { type: 'doc' }))).toBeNull();
    expect(await extractUploadedFileText(seedBlob('없음.txt', null, { blobPath: null }))).toBeNull();
    expect(await extractUploadedFileText(seedBlob('유령.txt', null, { blobPath: 'ft-ghost' }))).toBeNull();
    expect(await extractUploadedFileText(seedBlob('제안서.pdf', Buffer.from('%PDF-1.4 hello')))).toBeNull();
    const huge = seedBlob('huge.txt', Buffer.from('x'));
    const p = path.join(BLOB_DIR, (db.prepare('SELECT blob_path FROM collab_files WHERE id = ?').get(huge) as { blob_path: string }).blob_path);
    fs.truncateSync(p, 30 * 1024 * 1024 + 1);
    expect(await extractUploadedFileText(huge)).toBeNull();
    fs.unlinkSync(p);
  });
});

describe('zip+XML류', () => {
  it('docx — word/document.xml의 <w:t> 텍스트 노드만, 엔티티 복원', async () => {
    const docx = await zipOf({
      '[Content_Types].xml': '<Types/>',
      'word/document.xml':
        '<w:document><w:body><w:p><w:r><w:t xml:space="preserve">검사 온도 </w:t></w:r><w:r><w:t>65도 &lt;상향&gt; &amp; 적용</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>   </w:t></w:r><w:r><w:t>&quot;다음&quot; &apos;배치&apos;</w:t></w:r></w:p></w:body></w:document>',
    });
    expect(await extractUploadedFileText(seedBlob('절차서.docx', docx))).toBe('검사 온도  65도 <상향> & 적용 "다음" \'배치\'');
    // 본문 파트가 없으면 null
    expect(await extractUploadedFileText(seedBlob('빈.docx', await zipOf({ 'word/styles.xml': '<x/>' })))).toBeNull();
  });

  it('xlsx — 공유 문자열 / pptx — 슬라이드 순서대로', async () => {
    const xlsx = await zipOf({ 'xl/sharedStrings.xml': '<sst><si><t>품목</t></si><si><t xml:space="preserve">방열판 A</t></si></sst>' });
    expect(await extractUploadedFileText(seedBlob('재고.xlsx', xlsx))).toBe('품목 방열판 A');
    expect(await extractUploadedFileText(seedBlob('빈.xlsx', await zipOf({ 'xl/workbook.xml': '<x/>' })))).toBeNull();

    const pptx = await zipOf({
      'ppt/slides/slide1.xml': '<p:sld><a:t>첫 장</a:t><a:t>부제</a:t></p:sld>',
      'ppt/slides/slide2.xml': '<p:sld><a:t>둘째 장</a:t></p:sld>',
      'ppt/slideLayouts/slideLayout1.xml': '<a:t>레이아웃</a:t>',
    });
    expect(await extractUploadedFileText(seedBlob('발표.pptx', pptx))).toBe('첫 장 부제\n둘째 장');
    expect(await extractUploadedFileText(seedBlob('빈.pptx', await zipOf({ 'ppt/presentation.xml': '<x/>' })))).toBeNull();
  });

  it('hwpx — PrvText.txt(utf16le, 40자 초과)가 있으면 그것, 아니면 Contents/section*.xml의 <hp:t>', async () => {
    const prv = '﻿' + '미리보기 평문입니다. '.repeat(5);
    const withPrv = await zipOf({
      'Preview/PrvText.txt': Buffer.from(prv, 'utf16le'),
      'Contents/section0.xml': '<hs:sec><hp:t>본문</hp:t></hs:sec>',
    });
    expect(await extractUploadedFileText(seedBlob('공문.hwpx', withPrv))).toBe(prv.slice(1));

    const shortPrv = await zipOf({
      'Preview/PrvText.txt': Buffer.from('﻿짧음', 'utf16le'),
      'Contents/section1.xml': '<hs:sec><hp:t>둘째 절</hp:t></hs:sec>',
      'Contents/section0.xml': '<hs:sec><hp:p><hp:run><hp:t charPrIDRef="0">첫째 절 &amp; 검토</hp:t></hp:run><hp:t> </hp:t></hp:p></hs:sec>',
    });
    const text = await extractUploadedFileText(seedBlob('보고서.hwpx', shortPrv));
    expect(text!.split('\n').sort()).toEqual(['둘째 절', '첫째 절 & 검토']);
    expect(await extractUploadedFileText(seedBlob('빈.hwpx', await zipOf({ 'mimetype': 'application/hwp+zip' })))).toBeNull();
  });

  it('zip이 아닌 손상 파일은 추출 실패 로그 후 null', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await extractUploadedFileText(seedBlob('깨짐.docx', Buffer.from('not a zip at all')))).toBeNull();
    expect(err).toHaveBeenCalledWith('[filetext] 추출 실패:', '깨짐.docx', expect.any(String));
    err.mockRestore();
  });
});

describe('한글 hwp 5.x (CFB)', () => {
  const A = 'A'.charCodeAt(0);
  /** 제어문자 섞인 문단 — 탭(9, 8워드)·인라인 컨트롤(11, 8워드)·줄바꿈(10)·문단끝(13) */
  const ctrlPara = [A, A + 1, 9, 0, 0, 0, 0, 0, 0, 0, A + 2, 11, 1, 2, 3, 4, 5, 6, 7, A + 3, 10, A + 4, 13];

  it('압축(raw deflate) 섹션 — 문단 텍스트만 뽑고, 미니 스트림·확장 크기 레코드·다중 섹션·PrvText(대용량 일반 체인) 처리', async () => {
    const longPara = '가나다라마바사아자차카타파하'.repeat(200); // 5600B → size 0xfff 확장 헤더
    const sec0 = Buffer.concat([
      hwpRecord(HWPTAG_PARA_HEADER, Buffer.alloc(22)),
      hwpParaText('제1조 목적'),
      hwpRecord(HWPTAG_PARA_HEADER, Buffer.alloc(22), 1),
      hwpParaText(ctrlPara),
      hwpParaText('   '), // 공백만 → 제외
      hwpParaText(longPara),
    ]);
    const sec1 = hwpParaText('제2절 별첨');
    const hwp = buildHwp({ sections: [sec0, sec1], prv: '미리보기 '.repeat(600) });
    expect(hwp.length).toBeGreaterThan(4096 + 512 * 4);
    const text = await extractUploadedFileText(seedBlob('규정.hwp', hwp));
    expect(text).toBe(['제1조 목적', 'AB CD\nE', longPara, '제2절 별첨'].join('\n'));
  });

  it('섹션 10개 이상은 숫자 순으로 정렬한다 (Section10이 Section2보다 뒤)', async () => {
    const sections = Array.from({ length: 11 }, (_, i) => hwpParaText(`절${i}`));
    const text = await extractUploadedFileText(seedBlob('긴규정.hwp', buildHwp({ sections })));
    expect(text!.split('\n')).toEqual(sections.map((_, i) => `절${i}`));
  });

  it('비압축 섹션 / zlib 래핑 압축(deflate-raw 실패 → deflate 재시도)도 읽는다', async () => {
    expect(await extractUploadedFileText(seedBlob('평문.hwp', buildHwp({ sections: [hwpParaText('비압축 본문')], compress: 'none' })))).toBe('비압축 본문');
    expect(await extractUploadedFileText(seedBlob('zlib.hwp', buildHwp({ sections: [hwpParaText('zlib 본문')], compress: 'zlib' })))).toBe('zlib 본문');
  });

  it('배포용 문서(flags bit2)는 섹션을 안 읽고 PrvText로 폴백, 미리보기도 없으면 null', async () => {
    const prv = '배포용 미리보기 텍스트 '.repeat(300); // 4096B 초과 → 일반 FAT 체인 여러 섹터
    expect(await extractUploadedFileText(seedBlob('배포.hwp', buildHwp({ sections: [hwpParaText('숨은 본문')], distribute: true, prv })))).toBe(prv);
    expect(await extractUploadedFileText(seedBlob('배포2.hwp', buildHwp({ sections: [hwpParaText('숨은 본문')], distribute: true })))).toBeNull();
    // 섹션이 깨져도(inflate 불가) 미리보기(짧음 → 미니 스트림)로
    const broken = buildHwp({ extra: [{ path: 'BodyText/Section0', data: Buffer.from('not deflate!!') }], prv: '짧은 미리보기' });
    expect(await extractUploadedFileText(seedBlob('깨진섹션.hwp', broken))).toBe('짧은 미리보기');
  });

  it('암호 문서 · 매직 불일치 · FileHeader 없음 · 루트 타입 이상 · 섹터 시프트 이상 · 서명 불일치 · 512B 미만은 null', async () => {
    const sec = [hwpParaText('본문')];
    expect(await extractUploadedFileText(seedBlob('암호.hwp', buildHwp({ sections: sec, password: true })))).toBeNull();
    expect(await extractUploadedFileText(seedBlob('매직.hwp', buildHwp({ sections: sec, magic: 'NOT A HWP FILE!!!' })))).toBeNull();
    expect(await extractUploadedFileText(seedBlob('헤더없음.hwp', buildHwp({ sections: sec, withHeader: false })))).toBeNull();
    expect(await extractUploadedFileText(seedBlob('루트.hwp', buildHwp({ sections: sec, cfb: { rootType: 2 } })))).toBeNull();
    expect(await extractUploadedFileText(seedBlob('시프트.hwp', buildHwp({ sections: sec, cfb: { sectorShift: 3 } })))).toBeNull();
    const notCfb = Buffer.alloc(1024, 1);
    expect(await extractUploadedFileText(seedBlob('가짜.hwp', notCfb))).toBeNull();
    expect(await extractUploadedFileText(seedBlob('짧음.hwp', Buffer.from('HWP?')))).toBeNull();
  });

  it('미니 컷오프 0(전부 일반 체인) · 빈 문단만 있는 문서는 null · 레코드 크기가 섹션을 넘으면 중단', async () => {
    const hwp = buildHwp({ sections: [hwpParaText('일반 체인 본문')], compress: 'none', cfb: { miniCutoff: 0 } });
    expect(await extractUploadedFileText(seedBlob('컷오프.hwp', hwp))).toBe('일반 체인 본문');
    const truncated = hwpRecord(67, Buffer.from('ab')).subarray(0, 5); // size=2인데 데이터 1바이트
    const empty = buildHwp({ sections: [Buffer.concat([hwpParaText([13]), truncated])], compress: 'none' });
    expect(await extractUploadedFileText(seedBlob('빈문단.hwp', empty))).toBeNull();
  });

  it('CFB 작성기 자체 검증 — FileHeader가 미니 스트림에 정확히 들어간다 (buildCfb 회귀 방어)', () => {
    const buf = buildCfb([{ path: 'FileHeader', data: hwpFileHeader(1) }, { path: 'BodyText/Section0', data: zlib.deflateRawSync(hwpParaText('x')) }]);
    expect(buf.readUInt32LE(0)).toBe(0xe011cfd0);
    expect(buf.length % 512).toBe(0);
    // 디렉터리: Root, FileHeader, BodyText, Section0 순
    const dirOff = (buf.readUInt32LE(48) + 1) * 512;
    const nameAt = (i: number) => buf.subarray(dirOff + i * 128, dirOff + i * 128 + buf.readUInt16LE(dirOff + i * 128 + 64) - 2).toString('utf16le');
    expect([0, 1, 2, 3].map(nameAt)).toEqual(['Root Entry', 'FileHeader', 'BodyText', 'Section0']);
    expect(buf[dirOff + 2 * 128 + 66]).toBe(1); // storage
  });
});
