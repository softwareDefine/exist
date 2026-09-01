import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import JSZip from 'jszip';
import * as Y from 'yjs';
import { createApp } from '../app.js';
import { readYdocSnapshot } from '../ydoc.js';
import {
  parseCsv,
  parseXlsx,
  parseDocx,
  buildSheetYdoc,
  buildDocYdoc,
  buildDocYdocFromMarkdown,
} from '../importFile.js';

/*
 * importFile.ts — 업로드 임포트: csv/xlsx → 협업 시트, txt·md/docx → 협업 문서.
 * 파서 단위 + 업로드 라우트(files.ts finishUpload) 경유 E2E.
 */
const app = createApp();

async function zipOf(entries: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [k, v] of Object.entries(entries)) zip.file(k, v);
  return zip.generateAsync({ type: 'nodebuffer' });
}

const WORKBOOK =
  '<workbook xmlns:r="r"><sheets>' +
  '<sheet name="재고 &amp; 목록" sheetId="1" r:id="rId1"/>' +
  '<sheet r:id="rId2" sheetId="2"/>' + // 이름 없음 → 시트2
  '<sheet name="유령" sheetId="3" r:id="rId9"/>' + // 대상 파트 없음 → 건너뜀
  '</sheets></workbook>';
const RELS =
  '<Relationships>' +
  '<Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId2" Type="ws" Target="/xl/worksheets/sheet2.xml"/>' +
  '</Relationships>';
const SST = '<sst><si><t>품목</t></si><si><r><t>방열판</t></r><r><t xml:space="preserve"> A</t></r></si></sst>';
const SHEET1 =
  '<worksheet><sheetData>' +
  '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>수량</t></is></c><c r="AA1"><v>9</v></c><c><v>1</v></c></row>' +
  '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>3</v></c><c r="C2" s="1"/><c r="D2" t="str"><f>SUM</f><v>&lt;3 &#44032;</v></c></row>' +
  '<row r="61"><c r="A61"><v>넘침</v></c></row>' +
  '</sheetData></worksheet>';
const SHEET2 = '<x:worksheet><x:sheetData><x:c r="A1"><x:v>2</x:v></x:c></x:sheetData></x:worksheet>';

function xlsxFixture() {
  return zipOf({
    'xl/workbook.xml': WORKBOOK,
    'xl/_rels/workbook.xml.rels': RELS,
    'xl/sharedStrings.xml': SST,
    'xl/worksheets/sheet1.xml': SHEET1,
    'xl/worksheets/sheet2.xml': SHEET2,
  });
}

describe('parseCsv', () => {
  it('BOM·따옴표 이스케이프·셀 안 개행·CRLF·끝 개행', () => {
    const rows = parseCsv('﻿이름,비고\r\n"콤마,포함","따옴표 ""안""\n두 줄"\r\n총계,\n');
    expect(rows).toEqual([
      ['이름', '비고'],
      ['콤마,포함', '따옴표 "안"\n두 줄'],
      ['총계', ''],
    ]);
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('a')).toEqual([['a']]);
  });
});

describe('parseXlsx', () => {
  it('공유 문자열·인라인·수식 계산값·엔티티, 26열/60행 초과와 참조 없는 셀은 버림, rels로 시트 파트 해석, 이름 없으면 시트N', async () => {
    const sheets = await parseXlsx(await xlsxFixture());
    expect(sheets.map((s) => s.name)).toEqual(['재고 & 목록', '시트2']);
    const g = sheets[0].grid;
    expect(g[0]).toEqual(['품목', '수량']);
    expect(g[1][0]).toBe('방열판 A');
    expect(g[1][1]).toBe('3');
    expect(g[1][2]).toBeUndefined();
    expect(g[1][3]).toBe('<3 가');
    expect(g.length).toBe(2);
    expect(sheets[1].grid).toEqual([['2']]);
  });

  it('워크북 없음 / 시트 파트가 하나도 없으면 에러', async () => {
    await expect(parseXlsx(await zipOf({ 'xl/styles.xml': '<x/>' }))).rejects.toThrow('워크북 없음');
    await expect(parseXlsx(await zipOf({ 'xl/workbook.xml': '<workbook><sheets><sheet name="a" r:id="rId1"/></sheets></workbook>' }))).rejects.toThrow('시트 없음');
  });
});

describe('parseDocx', () => {
  it('문단별 텍스트, 앞뒤 빈 문단 제거, 자기닫힘 문단은 빈 줄로 유지, 엔티티 복원', async () => {
    const xml =
      '<w:document><w:body>' +
      '<w:p/><w:p><w:r><w:t> </w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>제1조</w:t></w:r><w:r><w:t xml:space="preserve"> 목적 &amp; 범위 &#44032;</w:t></w:r></w:p>' +
      '<w:p/>' +
      '<w:p><w:r><w:t>제2조</w:t></w:r></w:p>' +
      '<w:p/>' +
      '</w:body></w:document>';
    expect(await parseDocx(await zipOf({ 'word/document.xml': xml }))).toEqual(['제1조 목적 & 범위 가', '', '제2조']);
    await expect(parseDocx(await zipOf({ 'word/styles.xml': '<x/>' }))).rejects.toThrow('본문 없음');
    await expect(parseDocx(await zipOf({ 'word/document.xml': '<w:document><w:p/><w:p><w:t>  </w:t></w:p></w:document>' }))).rejects.toThrow('내용 없음');
  });
});

describe('Y.Doc 구성', () => {
  it('buildSheetYdoc — 시트 메타 + A1 키 셀, 60행×26열로 자르고 빈 값은 건너뜀, 이름 없으면 시트N', () => {
    const doc = new Y.Doc();
    const bigGrid: string[][] = Array.from({ length: 70 }, (_, r) => Array.from({ length: 30 }, (_, c) => (c === 1 && r % 2 ? '' : `${r}-${c}`)));
    buildSheetYdoc(doc, [{ name: '재고', grid: [['a', '', 'c'], []] }, { name: '', grid: bigGrid }]);
    const meta = [...doc.getMap<{ name: string; ord: number; cellsKey: string }>('sheets').values()].sort((a, b) => a.ord - b.ord);
    expect(meta.map((m) => [m.name, m.ord])).toEqual([['재고', 1], ['시트2', 2]]);
    const cells1 = doc.getMap(meta[0].cellsKey);
    expect([...cells1.entries()]).toEqual([['A1', 'a'], ['C1', 'c']]);
    const cells2 = doc.getMap(meta[1].cellsKey);
    expect(cells2.get('Z60')).toBe('59-25');
    expect(cells2.has('A61')).toBe(false);
    expect(cells2.get('B2')).toBeUndefined(); // 빈 값(r=1 홀수, c=1)
    expect(cells2.get('B1')).toBe('0-1');
    expect(cells2.size).toBe(60 * 26 - 30);
    doc.destroy();
  });

  it('buildDocYdoc — docs 메타 + paragraph 노드 (빈 문단은 텍스트 없이)', () => {
    const doc = new Y.Doc();
    buildDocYdoc(doc, '', ['첫 줄', '', '셋째']);
    const [id, meta] = [...doc.getMap<{ name: string; ord: number }>('docs').entries()][0];
    expect(meta).toEqual({ name: '문서 1', ord: 1 });
    const frag = doc.getXmlFragment(`doc:${id}`);
    expect(frag.length).toBe(3);
    expect(frag.toString()).toBe('<paragraph>첫 줄</paragraph><paragraph></paragraph><paragraph>셋째</paragraph>');
    doc.destroy();
  });

  it('buildDocYdocFromMarkdown — #/## 제목(level 1·2), -/* 목록 묶음, 빈 줄로 목록 끊김, 굵게·코드 기호 제거, 빈 문서는 빈 문단 하나', () => {
    const doc = new Y.Doc();
    const md = '﻿# 제목\n본문 **굵게** 와 `코드`\n\n- 하나\n* 둘\n\n- 셋\n### 소제목\n- 넷';
    buildDocYdocFromMarkdown(doc, '회의록', md);
    const [id, meta] = [...doc.getMap<{ name: string; ord: number }>('docs').entries()][0];
    expect(meta.name).toBe('회의록');
    const frag = doc.getXmlFragment(`doc:${id}`);
    const nodes = frag.toArray() as Y.XmlElement[];
    expect(nodes.map((n) => n.nodeName)).toEqual(['heading', 'paragraph', 'bulletList', 'bulletList', 'heading', 'bulletList']);
    expect(nodes[0].getAttribute('level')).toBe(1 as unknown as string);
    expect(nodes[0].toString()).toBe('<heading level="1">제목</heading>');
    expect(nodes[1].toString()).toBe('<paragraph>본문 굵게 와 코드</paragraph>');
    // Yjs toString은 태그명을 소문자로 직렬화한다 (nodeName은 원형 유지)
    expect(nodes[2].toString()).toBe('<bulletlist><listitem><paragraph>하나</paragraph></listitem><listitem><paragraph>둘</paragraph></listitem></bulletlist>');
    expect(nodes[3].toString()).toBe('<bulletlist><listitem><paragraph>셋</paragraph></listitem></bulletlist>');
    expect(nodes[4].getAttribute('level')).toBe(2 as unknown as string);
    expect(nodes[5].toString()).toBe('<bulletlist><listitem><paragraph>넷</paragraph></listitem></bulletlist>');
    doc.destroy();

    const empty = new Y.Doc();
    buildDocYdocFromMarkdown(empty, '', '');
    const [eid] = [...empty.getMap('docs').keys()];
    expect(empty.getXmlFragment(`doc:${eid}`).toString()).toBe('<paragraph></paragraph>');
    empty.destroy();
  });
});

describe('업로드 라우트 임포트 (files.ts finishUpload)', () => {
  let token = '';
  let code = '';
  beforeAll(async () => {
    const r = await request(app).post('/api/auth/register').send({ username: 'imp_host', password: 'password123' });
    token = r.body.token;
    const m = await request(app).post('/api/meetings').set('Authorization', `Bearer ${token}`).send({ title: 'imp 그룹' });
    code = m.body.code;
  });
  const upload = (name: string, body: Buffer, mime: string) =>
    request(app)
      .post(`/api/meetings/${code}/files/upload?name=${encodeURIComponent(name)}`)
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', mime)
      .send(body);

  it('xlsx → 시트(여러 시트), docx → 문서, md → 문서(마크다운 구조), 같은 이름은 " (2)"', async () => {
    const x = await upload('재고.xlsx', await xlsxFixture(), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(x.status).toBe(200);
    expect(x.body).toMatchObject({ type: 'sheet', imported: true, name: '재고' });
    const xd = readYdocSnapshot(`file-${x.body.id}`)!;
    const sheets = [...xd.getMap<{ name: string; ord: number; cellsKey: string }>('sheets').values()].sort((a, b) => a.ord - b.ord);
    expect(sheets.map((s) => s.name)).toEqual(['재고 & 목록', '시트2']);
    expect(xd.getMap(sheets[0].cellsKey).get('A2')).toBe('방열판 A');
    xd.destroy();
    const prev = await request(app).get(`/api/meetings/${code}/files/${x.body.id}/preview`).set('Authorization', `Bearer ${token}`);
    expect(prev.body.items).toEqual(['재고 & 목록', '시트2']);

    const docx = await zipOf({ 'word/document.xml': '<w:document><w:p><w:t>제1조</w:t></w:p><w:p><w:t>제2조</w:t></w:p></w:document>' });
    const d = await upload('절차서.docx', docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(d.body).toMatchObject({ type: 'doc', imported: true, name: '절차서' });
    const dd = readYdocSnapshot(`file-${d.body.id}`)!;
    const [did] = [...dd.getMap('docs').keys()];
    expect(dd.getXmlFragment(`doc:${did}`).toString()).toBe('<paragraph>제1조</paragraph><paragraph>제2조</paragraph>');
    dd.destroy();

    const md = await upload('회의록.md', Buffer.from('# 안건\n- 하나\n- 둘'), 'text/markdown');
    expect(md.body).toMatchObject({ type: 'doc', imported: true, name: '회의록' });
    const mdoc = readYdocSnapshot(`file-${md.body.id}`)!;
    const [mid] = [...mdoc.getMap('docs').keys()];
    expect(mdoc.getXmlFragment(`doc:${mid}`).toString()).toBe(
      '<heading level="1">안건</heading><bulletlist><listitem><paragraph>하나</paragraph></listitem><listitem><paragraph>둘</paragraph></listitem></bulletlist>',
    );
    mdoc.destroy();
    const md2 = await upload('회의록.md', Buffer.from('둘째'), 'text/markdown');
    expect(md2.body.name).toBe('회의록 (2)');
  });

  it('파싱 실패(zip 아닌 xlsx, 빈 docx)는 변환 없이 일반 파일(blob)로 보관', async () => {
    const bad = await upload('깨짐.xlsx', Buffer.from('this is not a zip'), 'application/octet-stream');
    expect(bad.status).toBe(200);
    expect(bad.body).toMatchObject({ type: 'file', name: '깨짐.xlsx', size: 17 });
    const emptyDocx = await upload('빈.docx', await zipOf({ 'word/document.xml': '<w:document><w:p/></w:document>' }), 'application/octet-stream');
    expect(emptyDocx.body.type).toBe('file');
  });
});
