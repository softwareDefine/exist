import { describe, it, expect } from 'vitest';
import { decodeBytes, parseHwpx, extractBlocksFromDoc, type HwpxBlock } from '../hwpx';

const enc = (s: string) => new TextEncoder().encode(s);
const utf16le = (s: string, bom = true) => {
  const out: number[] = bom ? [0xff, 0xfe] : [];
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    out.push(c & 0xff, c >> 8);
  }
  return new Uint8Array(out);
};

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/>
    <rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/>
  </rootfiles>
</container>`;

const HPF = `<?xml version="1.0" encoding="UTF-8"?>
<opf:package xmlns:opf="http://www.idpf.org/2007/opf/" version="">
  <opf:manifest>
    <opf:item id="header" href="header.xml" media-type="application/xml"/>
    <opf:item id="section0" href="section0.xml" media-type="application/xml"/>
    <opf:item id="image1" href="BinData/image1.png" media-type="image/png"/>
  </opf:manifest>
  <opf:spine>
    <opf:itemref idref="header" linear="yes"/>
    <opf:itemref idref="section0" linear="yes"/>
  </opf:spine>
</opf:package>`;

const HEADER = `<?xml version="1.0" encoding="UTF-8"?>
<hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" version="1.4">
  <hh:refList>
    <hh:borderFills>
      <hh:borderFill id="2"><hh:fillBrush><hh:winBrush faceColor="#FFEE00" hatchColor="#000000"/></hh:fillBrush></hh:borderFill>
    </hh:borderFills>
    <hh:charProperties>
      <hh:charPr id="0" height="1000" textColor="#000000"/>
      <hh:charPr id="1" height="1600" textColor="#ff0000"><hh:bold/><hh:italic/><hh:underline type="BOTTOM"/><hh:strikeout type="NONE"/></hh:charPr>
    </hh:charProperties>
    <hh:paraProperties>
      <hh:paraPr id="0"><hh:align horizontal="LEFT"/></hh:paraPr>
      <hh:paraPr id="1"><hh:align horizontal="CENTER"/></hh:paraPr>
    </hh:paraProperties>
  </hh:refList>
</hh:head>`;

const SECTION = `<?xml version="1.0" encoding="UTF-8"?>
<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core">
  <hp:p paraPrIDRef="1"><hp:run charPrIDRef="1"><hp:t>제목</hp:t></hp:run><hp:run charPrIDRef="0"><hp:t> 본문</hp:t></hp:run><hp:linesegarray><hp:lineseg/></hp:linesegarray></hp:p>
  <hp:p paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t>둘째<hp:tab/>줄</hp:t></hp:run></hp:p>
  <hp:p><hp:run>
    <hp:tbl><hp:pos treatAsChar="1"/>
      <hp:tr>
        <hp:tc borderFillIDRef="2"><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="3000" height="1000"/><hp:cellMargin/><hp:subList><hp:p><hp:run><hp:t>A1</hp:t></hp:run></hp:p></hp:subList></hp:tc>
        <hp:tc><hp:cellAddr colAddr="1" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="2"/><hp:cellSz width="6000" height="1000"/><hp:subList><hp:p><hp:run><hp:t>B1</hp:t></hp:run></hp:p></hp:subList></hp:tc>
      </hp:tr>
    </hp:tbl>
  </hp:run></hp:p>
  <hp:p><hp:run><hp:t>그림 앞</hp:t><hp:pic><hp:pos treatAsChar="0"/><hp:sz width="12000" height="8000"/><hc:img binaryItemIDRef="image1"/></hp:pic></hp:run></hp:p>
  <hp:p><hp:run><hp:t>   </hp:t></hp:run></hp:p>
</hs:sec>`;

function fullDoc() {
  return {
    'META-INF/container.xml': enc(CONTAINER),
    'Contents/content.hpf': enc(HPF),
    'Contents/header.xml': enc(HEADER),
    'Contents/section0.xml': enc(SECTION),
    'BinData/image1.png': new Uint8Array([1, 2, 3]),
    'Preview/PrvText.txt': enc('미리보기'),
  };
}

describe('decodeBytes', () => {
  it('UTF-8 BOM / UTF-16 BOM / BOM 없는 UTF-16', () => {
    expect(decodeBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...enc('가')]))).toBe('가');
    expect(decodeBytes(utf16le('<a/>'))).toBe('<a/>');
    expect(decodeBytes(utf16le('<a/>', false))).toBe('<a/>');
    const be = new Uint8Array([0xfe, 0xff, 0x00, 0x3c, 0x00, 0x61]);
    expect(decodeBytes(be)).toBe('<a');
    expect(decodeBytes(new Uint8Array([0x00, 0x3c, 0x00, 0x61]))).toBe('<a');
  });

  it('XML 선언의 encoding을 따른다 (utf-8이 아니면 재디코딩)', () => {
    const latin = new Uint8Array([...enc('<?xml version="1.0" encoding="iso-8859-1"?><a>'), 0xe9, ...enc('</a>')]);
    expect(decodeBytes(latin)).toContain('é');
    expect(decodeBytes(enc('<?xml version="1.0" encoding="UTF-8"?><a>x</a>'))).toContain('<a>x</a>');
  });
});

describe('parseHwpx', () => {
  it('spine 기준 섹션 발견 + 서식·표·이미지 보존', () => {
    const blocks = parseHwpx(fullDoc());
    expect(blocks.map((b) => b.kind)).toEqual(['p', 'p', 'table', 'p', 'img']);

    const p0 = blocks[0] as Extract<HwpxBlock, { kind: 'p' }>;
    expect(p0.text).toBe('제목 본문');
    expect(p0.align).toBe('center');
    expect(p0.runs).toEqual([
      { text: '제목', bold: true, italic: true, underline: true, sizePt: 16, color: '#FF0000' },
      { text: ' 본문', sizePt: 10 },
    ]);

    const p1 = blocks[1] as Extract<HwpxBlock, { kind: 'p' }>;
    expect(p1.text).toBe('둘째\t줄');
    expect(p1.align).toBeUndefined();

    const t = blocks[2] as Extract<HwpxBlock, { kind: 'table' }>;
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]).toHaveLength(2);
    expect(t.rows[0][0].bg).toBe('#FFEE00');
    expect(t.rows[0][0].blocks).toEqual([{ kind: 'p', text: 'A1' }]);
    expect(t.rows[0][1].rowSpan).toBe(2);
    expect(t.rows[0][1].colSpan).toBeUndefined();
    expect(t.colWidths).toEqual([3000, 6000]);

    expect((blocks[3] as Extract<HwpxBlock, { kind: 'p' }>).text).toBe('그림 앞');
    const img = blocks[4] as Extract<HwpxBlock, { kind: 'img' }>;
    expect(img.mime).toBe('image/png');
    expect(img.widthPt).toBe(120);
    expect([...img.data]).toEqual([1, 2, 3]);
  });

  it('렌더 불가 이미지 포맷(wmf)은 조용히 생략', () => {
    const files = fullDoc();
    files['Contents/content.hpf'] = enc(HPF.replace('BinData/image1.png', 'BinData/image1.wmf'));
    delete (files as Record<string, unknown>)['BinData/image1.png'];
    (files as Record<string, Uint8Array>)['BinData/image1.wmf'] = new Uint8Array([9]);
    const blocks = parseHwpx(files);
    expect(blocks.some((b) => b.kind === 'img')).toBe(false);
  });

  it('container/hpf 없이 section*.xml 글롭 폴백 (숫자 정렬) + HTML 엔티티 강건화', () => {
    const files = {
      'Contents/section10.xml': enc('<sec xmlns:hp="x"><hp:p><hp:run><hp:t>열째</hp:t></hp:run></hp:p></sec>'),
      'Contents/section2.xml': enc('<sec><p><run><t>a&nbsp;b&hellip;</t></run></p></sec>'),
    };
    const blocks = parseHwpx(files) as Extract<HwpxBlock, { kind: 'p' }>[];
    expect(blocks.map((b) => b.text)).toEqual(['a b…', '열째']);
  });

  it('섹션 파일명이 특이해도 p+t를 가진 XML을 본문으로 찾는다', () => {
    const blocks = parseHwpx({
      'Contents/settings.xml': enc('<s><p><t>설정</t></p></s>'),
      'Contents/body.xml': enc('<doc><p><t>hello</t><br/><t>world</t></p></doc>'),
    }) as Extract<HwpxBlock, { kind: 'p' }>[];
    expect(blocks).toEqual([{ kind: 'p', text: 'hello\nworld' }]);
  });

  it('구조 없는 XML은 텍스트 노드 폴백, 깨진 XML은 태그 벗기기 폴백', () => {
    expect(parseHwpx({ 'Contents/weird.xml': enc('<x><y>text only</y><z>둘</z></x>') })).toEqual([
      { kind: 'p', text: 'text only' },
      { kind: 'p', text: '둘' },
    ]);
    expect(parseHwpx({ 'Contents/section0.xml': enc('<hp:p><hp:t>x &amp; y</hp:t>') })).toEqual([
      { kind: 'p', text: 'x & y' },
    ]);
  });

  it('XML이 하나도 없으면 PrvText.txt, 그마저 없으면 []', () => {
    expect(parseHwpx({ 'Preview/PrvText.txt': enc('첫 줄\r\n둘째 줄\n') })).toEqual([
      { kind: 'p', text: '첫 줄' },
      { kind: 'p', text: '둘째 줄' },
    ]);
    expect(parseHwpx({})).toEqual([]);
    expect(parseHwpx({ 'a.bin': new Uint8Array(0) })).toEqual([]);
  });

  it('extractBlocksFromDoc — 헤더 없이도 텍스트 추출 (서식 없음)', () => {
    const doc = new DOMParser().parseFromString('<sec><p><run><t>plain</t></run></p></sec>', 'application/xml');
    const out: HwpxBlock[] = [];
    extractBlocksFromDoc(doc, out);
    expect(out).toEqual([{ kind: 'p', text: 'plain' }]);
  });
});
