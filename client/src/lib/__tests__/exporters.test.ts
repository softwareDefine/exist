import { describe, it, expect, vi, beforeEach } from 'vitest';
import JSZip from 'jszip';
import { exportDocx } from '../docx';
import { exportPptx } from '../pptx';
import { looksLikeHwp, parseHwp } from '../hwp';

/* zip 생성을 가로채 내용물을 검사 — 실제 다운로드(a.click)는 막는다 */
let lastZip: JSZip | null = null;
let clicked: HTMLAnchorElement[] = [];
beforeEach(() => {
  lastZip = null;
  clicked = [];
  vi.spyOn(JSZip.prototype, 'generateAsync').mockImplementation(async function (this: JSZip) {
    lastZip = this;
    return new Blob(['zip']) as never;
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this);
  });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

const fileText = (path: string) => lastZip!.file(path)!.async('string');

describe('exportDocx', () => {
  it('ProseMirror JSON → document.xml 문단·서식·목록·표', async () => {
    await exportDocx('보고서', {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1, textAlign: 'center' }, content: [{ type: 'text', text: '제목' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '굵게', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' 기울임', marks: [{ type: 'italic' }, { type: 'underline' }, { type: 'strike' }] },
            { type: 'text', text: ' 색', marks: [{ type: 'textStyle', attrs: { color: '#ff0000' } }] },
            { type: 'hardBreak' },
            { type: 'mention', attrs: { id: 'kim', label: '김대리' } },
            { type: 'text', text: ' <&> ' },
          ],
        },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '항목' }] }] }] },
        {
          type: 'orderedList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '하나' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '둘' }] }] },
          ],
        },
        { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '완료' }] }] }] },
        { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: '인용' }] }] },
        { type: 'codeBlock', content: [{ type: 'text', text: 'a\nb' }] },
        {
          type: 'table',
          content: [{ type: 'tableRow', content: [
            { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'c1' }] }] },
            { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'c2' }] }] },
          ] }],
        },
        { type: 'image', attrs: { src: 'x.png' } },
        { type: 'horizontalRule' },
        { type: 'unknownWrapper', content: [{ type: 'paragraph', content: [{ type: 'text', text: '중첩' }] }] },
      ],
    });
    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toBe('보고서.docx');
    expect(lastZip).not.toBeNull();
    expect(Object.keys(lastZip!.files).filter((n) => !n.endsWith('/')).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'word/document.xml']);
    const xml = await fileText('word/document.xml');
    expect(xml).toContain('<w:jc w:val="center"/>');
    expect(xml).toContain('<w:sz w:val="44"/>');
    expect(xml).toContain('<w:b/>');
    expect(xml).toContain('<w:i/><w:u w:val="single"/><w:strike/>');
    expect(xml).toContain('<w:color w:val="FF0000"/>');
    expect(xml).toContain('<w:br/>');
    expect(xml).toContain('@김대리');
    expect(xml).toContain('&lt;&amp;&gt;');
    expect(xml).toContain('• </w:t>');
    expect(xml).toContain('1. </w:t>');
    expect(xml).toContain('2. </w:t>');
    expect(xml).toContain('☑ </w:t>');
    expect(xml).toContain('<w:ind w:left="480"/>');
    expect(xml).toContain('Consolas');
    expect(xml).toContain('c1  |  c2');
    expect(xml).toContain('[이미지]');
    expect(xml).toContain('────');
    expect(xml).toContain('중첩');
  });

  it('빈 문서도 문단 하나는 넣는다', async () => {
    await exportDocx('빈', { type: 'doc', content: [] });
    const xml = await fileText('word/document.xml');
    expect(xml).toContain('<w:p>');
    expect(xml).toContain('<w:sectPr>');
  });
});

describe('exportPptx', () => {
  it('텍스트·도형·선·이미지 → 슬라이드 파트 구성', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('ok.png')
          ? { ok: true, blob: async () => ({ type: 'image/png', arrayBuffer: async () => new ArrayBuffer(4) }) }
          : { ok: false },
      ),
    );
    await exportPptx(
      '발표',
      [
        {
          bg: '#112233',
          els: [
            { x: 10, y: 10, w: 50, h: 10, text: '제목\n둘째', size: 40, bold: true, italic: true, underline: true, strike: true, align: 'center', color: '#ff0000', font: '"Noto Sans KR", sans-serif', rot: 15 },
            { type: 'shape', shape: 'ellipse', x: 0, y: 0, w: 20, h: 20, fill: '#00ff00', stroke: '#0000ff', text: '안' },
            { type: 'shape', shape: 'arrow', x: 0, y: 50, w: 40, h: 10, stroke: '#123456' },
            { type: 'shape', shape: 'line', x: 0, y: 60, w: 40, h: 10 },
            { type: 'shape', shape: 'triangle', x: 0, y: 0, w: 5, h: 5 },
            { type: 'image', src: '/api/uploads/ok.png', x: 0, y: 0, w: 30, h: 30 },
            { type: 'image', src: '/api/uploads/missing.png', x: 0, y: 0, w: 30, h: 30 },
          ],
        },
        { els: [] },
      ],
      'tok',
    );
    expect(clicked[0].download).toBe('발표.pptx');
    const names = Object.keys(lastZip!.files);
    expect(names).toEqual(
      expect.arrayContaining([
        'ppt/presentation.xml',
        'ppt/slides/slide1.xml',
        'ppt/slides/slide2.xml',
        'ppt/slides/_rels/slide1.xml.rels',
        'ppt/media/image1.png',
        'ppt/slideMasters/slideMaster1.xml',
        'ppt/theme/theme1.xml',
      ]),
    );
    expect(names).not.toContain('ppt/media/image2.png');
    const s1 = await fileText('ppt/slides/slide1.xml');
    expect(s1).toContain('<a:srgbClr val="112233"/>');
    expect(s1).toContain('sz="3000" b="1" i="1" u="sng" strike="sngStrike"');
    expect(s1).toContain('algn="ctr"');
    expect(s1).toContain('typeface="Noto Sans KR"');
    expect(s1).toContain('rot="900000"');
    expect(s1).toContain('prst="ellipse"');
    expect(s1).toContain('prst="triangle"');
    expect(s1).toContain('<a:tailEnd type="triangle"');
    expect(s1).toContain('<p:pic>');
    expect(s1).toContain('r:embed="rId2"');
    expect((s1.match(/<p:cxnSp>/g) ?? []).length).toBe(2);
    const pres = await fileText('ppt/presentation.xml');
    expect(pres).toContain('<p:sldId id="256" r:id="rId2"/>');
    expect(pres).toContain('<p:sldId id="257" r:id="rId3"/>');
    expect(fetch).toHaveBeenCalledWith('/api/uploads/ok.png', { headers: { Authorization: 'Bearer tok' } });
  });
});

describe('hwp (구형 바이너리)', () => {
  it('looksLikeHwp — CFB 시그니처만 본다', () => {
    expect(looksLikeHwp(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]))).toBe(true);
    expect(looksLikeHwp(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0, 0, 0]))).toBe(false);
    expect(looksLikeHwp(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).toBe(false);
  });

  it('parseHwp — 깨진 입력은 [] (throw 없음)', async () => {
    await expect(parseHwp(new Uint8Array(0))).resolves.toEqual([]);
    await expect(parseHwp(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]))).resolves.toEqual([]);
    await expect(parseHwp(new Uint8Array(1024))).resolves.toEqual([]);
  });
});
