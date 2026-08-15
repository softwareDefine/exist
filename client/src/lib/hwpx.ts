/* ── 한글(hwpx / OWPML) 파서 — CollabFiles 인앱 미리보기의 순수 로직.
 *
 * 강건화 포인트:
 *  1) 섹션 발견: Contents/section0.xml 하드코딩 대신
 *     META-INF/container.xml → *.hpf(spine) → section*.xml 글롭 → 본문 XML 전수 탐색 순.
 *  2) 네임스페이스 변형: hp:t / t / 임의 prefix 전부 localName 기준으로 파싱.
 *  3) 요소 커버리지: p(문단)·run·t·tbl/tr/tc(표)·tab·br/lineBreak — 어느 깊이에 있어도 수용.
 *  4) 인코딩: BOM(UTF-8/16LE/16BE)·BOM 없는 UTF-16·XML 선언의 encoding 속성 감지.
 *     엔티티: XML 5종 외의 HTML 엔티티(&nbsp; 등)로 파스가 깨지면 치환 후 재시도.
 *  5) 최후 폴백: 구조 파싱이 비면 Contents XML의 텍스트 노드(그마저 없으면 PrvText.txt)를
 *     서식 없는 문단으로 이어붙인다. 그래도 비면 []를 돌려 기존 안내 문구가 뜬다.
 *
 * 서식 보존(v2): header.xml의 charPr(굵게·기울임·밑줄·크기·색)·paraPr(정렬)·
 * borderFill(셀 배경)을 id 맵으로 읽고 본문의 charPrIDRef/paraPrIDRef로 매핑한다.
 * 표는 셀 병합(cellSpan)·상대 폭(cellSz)·셀 안 다중 문단을 유지하고,
 * hp:pic → binaryItemIDRef → BinData 바이트로 삽입 이미지를 낸다(블롭 URL은 렌더 책임).
 * 헤더·서식 파싱이 어떤 이유로든 실패해도 서식 없는 기존 결과로 조용히 강등된다.
 *
 * DOM 의존은 전역 DOMParser·TextDecoder뿐 — Node에서 @xmldom/xmldom을 주입하면 단위 테스트 가능. */

export type HwpxAlign = 'left' | 'center' | 'right' | 'justify';

/** 문단 안의 서식 조각 — 서식이 하나도 없으면 스타일 필드가 전부 비어 있다 */
export interface HwpxRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  sizePt?: number; // 글자 크기(pt) — charPr height(1/100pt)에서 환산
  color?: string; // '#RRGGBB' — 검정(기본색)은 생략해 테마 변수를 따르게 한다
}

export interface HwpxCell {
  blocks: HwpxBlock[]; // 셀 안 다중 문단·중첩 표·이미지
  colSpan?: number;
  rowSpan?: number;
  bg?: string; // '#RRGGBB' — 문서가 지정한 셀 배경만 (추측 배경 금지)
}

export type HwpxBlock =
  | { kind: 'p'; text: string; runs?: HwpxRun[]; align?: HwpxAlign }
  | { kind: 'table'; rows: HwpxCell[][]; colWidths?: number[] }
  | { kind: 'img'; data: Uint8Array; mime: string; widthPt?: number };

/* 기존 상한 유지 + 방어적 가드 */
const MAX_SECTIONS = 20;
const MAX_BLOCKS = 3000;
const MAX_PLAIN_CHARS = 200_000; // 폴백 텍스트 상한 (TextPreview와 동일)
const MAX_ENTRY_BYTES = 30 * 1024 * 1024; // 비정상적으로 큰 단일 엔트리는 건너뜀
const MAX_IMG_BYTES = 5 * 1024 * 1024; // 이미지 장당 상한
const MAX_IMG_TOTAL = 20 * 1024 * 1024; // 이미지 총합 상한

/* ── 저수준 헬퍼: 어떤 DOM 구현에서도 도는 최소 API(childNodes·nodeType·localName)만 사용 ── */

/** prefix·대소문자를 지운 localName — 'hp:t'든 't'든 'HP:T'든 't' */
function ln(node: Node): string {
  const el = node as Element;
  const raw = el.localName || el.nodeName || '';
  const i = raw.indexOf(':');
  return (i >= 0 ? raw.slice(i + 1) : raw).toLowerCase();
}

function childEls(node: Node): Element[] {
  const out: Element[] = [];
  const kids = node.childNodes;
  for (let i = 0; i < kids.length; i++) if (kids[i].nodeType === 1) out.push(kids[i] as Element);
  return out;
}

function forEachEl(root: Node, fn: (el: Element) => void) {
  for (const c of childEls(root)) {
    fn(c);
    forEachEl(c, fn);
  }
}

/** 속성도 prefix 무시하고 localName으로 찾는다 (opf:href 같은 변형 수용) */
function attrOf(el: Element, name: string): string | null {
  const direct = el.getAttribute?.(name);
  if (direct != null && direct !== '') return direct;
  const attrs = el.attributes;
  if (attrs) {
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i];
      const an = a.localName || a.name || '';
      const j = an.indexOf(':');
      if ((j >= 0 ? an.slice(j + 1) : an).toLowerCase() === name.toLowerCase()) return a.value;
    }
  }
  return null;
}

function intAttr(el: Element, name: string): number | null {
  const v = attrOf(el, name);
  if (v == null) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/* ── 인코딩 ── */

/** BOM·UTF-16 휴리스틱·XML 선언의 encoding 속성까지 감지해 디코딩 */
export function decodeBytes(bytes: Uint8Array): string {
  const dec = (label: string, body: Uint8Array): string | null => {
    try {
      return new TextDecoder(label).decode(body);
    } catch {
      return null;
    }
  };
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return dec('utf-8', bytes.subarray(3)) ?? '';
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
    return dec('utf-16le', bytes.subarray(2)) ?? '';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff)
    return dec('utf-16be', bytes.subarray(2)) ?? '';
  // BOM 없는 UTF-16 XML: '<'(0x3C) 뒤에 0x00이 오는 패턴
  if (bytes.length >= 2 && bytes[0] === 0x3c && bytes[1] === 0x00) return dec('utf-16le', bytes) ?? '';
  if (bytes.length >= 2 && bytes[0] === 0x00 && bytes[1] === 0x3c) return dec('utf-16be', bytes) ?? '';
  const utf8 = dec('utf-8', bytes) ?? '';
  // XML 선언이 다른 인코딩을 주장하면 그걸로 재디코딩 (예: euc-kr 변형)
  const m = /^<\?xml[^>]*encoding=["']([\w.-]+)["']/i.exec(utf8);
  if (m && !/^utf-?8$/i.test(m[1])) {
    const re = dec(m[1].toLowerCase(), bytes);
    if (re != null) return re;
  }
  return utf8;
}

/* ── XML 파싱 (엔티티 강건화 포함) ── */

const HTML_ENTITIES: Record<string, string> = {
  nbsp: ' ', middot: '·', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®',
};

/** XML 5종 밖의 named 엔티티를 문자로 치환하고, 헐벗은 &를 이스케이프 — 파스 실패 시 재시도용 */
function sanitizeEntities(xml: string): string {
  return xml
    .replace(/&([a-zA-Z][a-zA-Z0-9]{1,31});/g, (m, name: string) => {
      const lower = name.toLowerCase();
      if (lower === 'amp' || lower === 'lt' || lower === 'gt' || lower === 'quot' || lower === 'apos') return m;
      return HTML_ENTITIES[lower] ?? '';
    })
    .replace(/&(?!#?[a-zA-Z0-9]+;)/g, '&amp;');
}

function parseXmlSafe(xml: string): Document | null {
  const tryParse = (s: string): Document | null => {
    try {
      const doc = new DOMParser().parseFromString(s, 'application/xml');
      if (!doc || !doc.documentElement) return null;
      // 브라우저 DOMParser는 실패 시 parsererror 문서를 돌려준다
      if (ln(doc.documentElement) === 'parsererror') return null;
      if (doc.getElementsByTagName('parsererror').length > 0) return null;
      return doc;
    } catch {
      return null;
    }
  };
  // XML 5종 밖의 named 엔티티가 보이면 선제 치환 — 구현체에 따라 파스 실패(브라우저) 또는
  // 리터럴 잔존(xmldom)으로 갈리는 지점이라, 어느 쪽이든 결과가 같게 만든다
  const hasForeignEntity = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)[a-zA-Z][a-zA-Z0-9]{0,31};/.test(xml);
  return tryParse(hasForeignEntity ? sanitizeEntities(xml) : xml) ?? tryParse(sanitizeEntities(xml));
}

/* ── 서식 컨텍스트 (header.xml) ── */

type CharStyle = Pick<HwpxRun, 'bold' | 'italic' | 'underline' | 'strike' | 'sizePt' | 'color'>;

interface ParseCtx {
  char: Map<string, CharStyle>; // charPr id → 런 서식
  paraAlign: Map<string, HwpxAlign>; // paraPr id → 정렬
  cellBg: Map<string, string>; // borderFill id → 셀 배경색
  binLookup?: (idRef: string) => { data: Uint8Array; mime: string } | null;
}

function emptyCtx(): ParseCtx {
  return { char: new Map(), paraAlign: new Map(), cellBg: new Map() };
}

/** '#RRGGBB'만 통과 — 'none'·이상값은 버린다 */
function normColor(v: string | null): string | null {
  if (!v) return null;
  const s = v.trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toUpperCase() : null;
}

const ALIGN_MAP: Record<string, HwpxAlign> = {
  left: 'left', center: 'center', right: 'right',
  justify: 'justify', distribute: 'justify', distribute_space: 'justify',
};

/** header.xml의 charPr / paraPr / borderFill을 id 맵으로 흡수 */
function parseHeaderInto(ctx: ParseCtx, doc: Document) {
  forEachEl(doc, (el) => {
    const name = ln(el);
    if (name === 'charpr') {
      const id = attrOf(el, 'id');
      if (id == null) return;
      const st: CharStyle = {};
      const h = intAttr(el, 'height'); // 1/100pt 단위
      if (h != null && h >= 100 && h <= 50000) st.sizePt = h / 100;
      const col = normColor(attrOf(el, 'textColor'));
      // 검정은 문서 기본색 — 생략해서 뷰어 테마 색(var(--text))을 따르게 한다
      if (col && col !== '#000000') st.color = col;
      for (const c of childEls(el)) {
        const cn = ln(c);
        if (cn === 'bold') st.bold = true;
        else if (cn === 'italic') st.italic = true;
        else if (cn === 'underline') {
          if ((attrOf(c, 'type') ?? '').toUpperCase() !== 'NONE') st.underline = true;
        } else if (cn === 'strikeout') {
          if ((attrOf(c, 'type') ?? '').toUpperCase() !== 'NONE') st.strike = true;
        }
      }
      ctx.char.set(id, st);
    } else if (name === 'parapr') {
      const id = attrOf(el, 'id');
      if (id == null) return;
      for (const c of childEls(el)) {
        if (ln(c) !== 'align') continue;
        const a = ALIGN_MAP[(attrOf(c, 'horizontal') ?? '').toLowerCase()];
        if (a && a !== 'left') ctx.paraAlign.set(id, a);
        break;
      }
    } else if (name === 'borderfill') {
      const id = attrOf(el, 'id');
      if (id == null) return;
      // fillBrush > winBrush faceColor — 지정된 단색 배경만 (없으면 스타일 없음)
      forEachEl(el, (c) => {
        if (ln(c) !== 'winbrush') return;
        const face = normColor(attrOf(c, 'faceColor'));
        if (face && !ctx.cellBg.has(id)) ctx.cellBg.set(id, face);
      });
    }
  });
}

/* ── 본문 추출 ── */

/** t 요소 내부 텍스트 — 안에 끼어드는 tab·lineBreak 마커까지 문자로 */
function textOfT(t: Node): string {
  let out = '';
  const kids = t.childNodes;
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i];
    if (n.nodeType === 3 || n.nodeType === 4) out += n.nodeValue ?? '';
    else if (n.nodeType === 1) {
      const name = ln(n);
      if (name === 'tab') out += '\t';
      else if (name === 'br' || name === 'linebreak') out += '\n';
      else out += textOfT(n);
    }
  }
  return out;
}

/** el 아래 모든 t 텍스트 수집 (폴백 경로용) */
function collectT(el: Node, out: string[]) {
  for (const c of childEls(el)) {
    if (ln(c) === 't') out.push(textOfT(c));
    else collectT(c, out);
  }
}

/** 두 런의 스타일이 같으면 이어붙일 수 있다 */
function sameStyle(a: CharStyle, b: CharStyle): boolean {
  return (
    !a.bold === !b.bold && !a.italic === !b.italic && !a.underline === !b.underline &&
    !a.strike === !b.strike && a.sizePt === b.sizePt && a.color === b.color
  );
}

function hasStyle(s: CharStyle): boolean {
  return !!(s.bold || s.italic || s.underline || s.strike || s.sizePt != null || s.color);
}

/** hp:pic 서브트리에서 binaryItemIDRef를 찾아 이미지 블록 생성 (렌더 불가 포맷·용량 초과는 조용히 생략) */
function imageBlock(pic: Element, ctx: ParseCtx): HwpxBlock | null {
  const lookup = ctx.binLookup;
  if (!lookup) return null;
  let idRef: string | null = attrOf(pic, 'binaryItemIDRef');
  let widthPt: number | undefined;
  forEachEl(pic, (c) => {
    if (idRef == null) {
      const v = attrOf(c, 'binaryItemIDRef');
      if (v) idRef = v;
    }
    if (widthPt == null && ln(c) === 'sz') {
      const w = intAttr(c, 'width'); // 1/100pt(HWPUNIT) 단위
      if (w != null && w > 0) widthPt = w / 100;
    }
  });
  if (!idRef) return null;
  const bin = lookup(idRef);
  if (!bin) return null;
  return widthPt != null
    ? { kind: 'img', data: bin.data, mime: bin.mime, widthPt }
    : { kind: 'img', data: bin.data, mime: bin.mime };
}

/** 표 → 셀 블록 행렬. 중첩 표의 tr이 바깥 표 행으로 새지 않게 tbl 경계에서 하강을 멈춘다 */
function tableBlock(tbl: Element, ctx: ParseCtx): HwpxBlock | null {
  const rows: HwpxCell[][] = [];
  // 열 폭: colSpan 없는 셀의 cellAddr(colAddr)→cellSz(width). 전 열이 모이면 상대 비율로 쓴다
  const colW = new Map<number, number>();
  let maxCol = -1;

  const cellOf = (tc: Element): HwpxCell => {
    const cell: HwpxCell = { blocks: [] };
    const bfRef = attrOf(tc, 'borderFillIDRef');
    if (bfRef) {
      const bg = ctx.cellBg.get(bfRef);
      if (bg) cell.bg = bg;
    }
    let colAddr: number | null = null;
    let width: number | null = null;
    for (const c of childEls(tc)) {
      const name = ln(c);
      if (name === 'cellspan') {
        const cs = intAttr(c, 'colSpan');
        const rs = intAttr(c, 'rowSpan');
        if (cs != null && cs > 1) cell.colSpan = cs;
        if (rs != null && rs > 1) cell.rowSpan = rs;
      } else if (name === 'celladdr') colAddr = intAttr(c, 'colAddr');
      else if (name === 'cellsz') width = intAttr(c, 'width');
      else if (name === 'cellmargin') continue;
      else walkBody(c, cell.blocks, ctx); // subList 등 — 셀 안 다중 문단·중첩 표·이미지
    }
    if (colAddr != null && colAddr >= 0) {
      maxCol = Math.max(maxCol, colAddr + (cell.colSpan ?? 1) - 1);
      if (!cell.colSpan && width != null && width > 0 && !colW.has(colAddr)) colW.set(colAddr, width);
    }
    return cell;
  };

  const findTr = (el: Node) => {
    for (const c of childEls(el)) {
      const name = ln(c);
      if (name === 'tbl') continue;
      if (name === 'tr') {
        const row: HwpxCell[] = [];
        for (const tc of childEls(c)) if (ln(tc) === 'tc') row.push(cellOf(tc));
        if (row.length > 0) rows.push(row);
      } else findTr(c);
    }
  };
  findTr(tbl);
  if (rows.length === 0) return null;

  const block: { kind: 'table'; rows: HwpxCell[][]; colWidths?: number[] } = { kind: 'table', rows };
  // 모든 열의 폭이 확보됐을 때만 colWidths — 부분 정보로 어긋난 비율을 만들지 않는다
  if (maxCol >= 0 && colW.size === maxCol + 1) {
    const widths: number[] = [];
    for (let i = 0; i <= maxCol; i++) widths.push(colW.get(i) ?? 0);
    if (widths.every((w) => w > 0)) block.colWidths = widths;
  }
  return block;
}

/** 문단 하나 → 런 블록(+안에 든 표·이미지 블록). run 유무·깊이와 무관하게 t를 찾는다 */
/** 개체의 플로팅 여부 — treatAsChar="0"이면 텍스트 흐름 밖(문단 기준 오프셋 배치).
 * 한/글은 앵커 줄 텍스트를 먼저 그리고 플로팅 개체를 오프셋 위치에 놓으므로,
 * 선형 렌더에선 "문단 텍스트 → 플로팅 개체" 순서가 원본 화면과 일치한다 */
function isFloating(objEl: Element): boolean {
  for (const c of childEls(objEl)) {
    if (ln(c) === 'pos') return attrOf(c, 'treatAsChar') === '0';
  }
  return false; // pos 없으면 글자취급으로 본다 (등장 위치 유지)
}

function walkPara(p: Element, blocks: HwpxBlock[], ctx: ParseCtx) {
  const runs: HwpxRun[] = [];
  // 플로팅 개체(표·그림)는 모아뒀다 문단 텍스트 뒤에 — XML 직렬화 순서(개체 먼저)와
  // 화면 순서(제목 먼저)가 다른 문서 대응 (예: 표지 제목 문단에 표가 앵커된 신청서)
  const floated: HwpxBlock[] = [];
  const append = (text: string, st: CharStyle) => {
    if (!text) return;
    const last = runs[runs.length - 1];
    if (last && sameStyle(last, st)) last.text += text;
    else runs.push({ text, ...st });
  };
  const flush = () => {
    // 뒤 공백 정리 (기존 replace(/\s+$/) 동작 유지) — 빈 꼬리 런은 버린다
    while (runs.length > 0) {
      const last = runs[runs.length - 1];
      last.text = last.text.replace(/\s+$/, '');
      if (last.text) break;
      runs.pop();
    }
    const text = runs.map((r) => r.text).join('');
    if (text.trim()) {
      const alignRef = attrOf(p, 'paraPrIDRef');
      const align = alignRef != null ? ctx.paraAlign.get(alignRef) : undefined;
      const styled = runs.some(hasStyle);
      const block: { kind: 'p'; text: string; runs?: HwpxRun[]; align?: HwpxAlign } = { kind: 'p', text };
      if (styled) block.runs = [...runs];
      if (align) block.align = align;
      blocks.push(block);
    }
    runs.length = 0;
  };
  const walk = (el: Node, st: CharStyle) => {
    for (const c of childEls(el)) {
      const name = ln(c);
      if (name === 't') append(textOfT(c), st);
      else if (name === 'tab') append('\t', st);
      else if (name === 'br' || name === 'linebreak') append('\n', st);
      else if (name === 'tbl') {
        const t = tableBlock(c, ctx);
        if (t) {
          if (isFloating(c)) floated.push(t);
          else {
            flush();
            blocks.push(t);
          }
        }
      } else if (name === 'pic') {
        const img = imageBlock(c, ctx);
        if (img) {
          if (isFloating(c)) floated.push(img);
          else {
            flush();
            blocks.push(img);
          }
        }
      } else if (name === 'lineseg' || name === 'linesegarray' || name === 'secpr') {
        continue; // 레이아웃 메타 — 본문 텍스트 없음
      } else if (name === 'run') {
        const idRef = attrOf(c, 'charPrIDRef');
        const next = idRef != null ? ctx.char.get(idRef) : undefined;
        walk(c, next ?? st); // 런 서식 매핑 — 헤더가 없으면 물려받은 스타일 유지
      } else walk(c, st); // 개체(그리기 등) — 내부의 t를 계속 찾는다
    }
  };
  walk(p, {});
  flush();
  blocks.push(...floated); // 플로팅 개체는 앵커 문단 텍스트 뒤에
}

/** node 아래의 문단·표를 순서대로 추출 — 섹션 루트·표 셀(subList) 공용 */
function walkBody(node: Node, blocks: HwpxBlock[], ctx: ParseCtx) {
  for (const c of childEls(node)) {
    if (blocks.length > MAX_BLOCKS) return;
    const name = ln(c);
    if (name === 'p') walkPara(c, blocks, ctx);
    else if (name === 'tbl') {
      const t = tableBlock(c, ctx);
      if (t) blocks.push(t);
    } else walkBody(c, blocks, ctx);
  }
}

/** 섹션 문서 전체에서 문단·표를 순서대로 추출 (루트가 몇 겹이든 하강) */
export function extractBlocksFromDoc(doc: Document, blocks: HwpxBlock[], ctx: ParseCtx = emptyCtx()) {
  walkBody(doc, blocks, ctx);
}

/* ── 섹션 파일 발견 ── */

function normName(n: string): string {
  return n.replace(/\\/g, '/').replace(/^\.?\//, '');
}

function resolvePath(dir: string, href: string): string {
  const parts = (dir + normName(href)).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

/** hpf(manifest)의 item id → href 맵 — 섹션 spine·이미지(BinData) 해석 공용 */
function readManifests(
  names: string[],
  textOf: (name: string) => string | null,
): { hpfPath: string; items: Map<string, string>; spineIds: string[] }[] {
  const hpfPaths: string[] = [];
  const containerXml = textOf('META-INF/container.xml');
  if (containerXml) {
    const doc = parseXmlSafe(containerXml);
    if (doc)
      forEachEl(doc, (el) => {
        if (ln(el) === 'rootfile') {
          const p = attrOf(el, 'full-path');
          const mt = attrOf(el, 'media-type') ?? '';
          // container엔 PrvText.txt 같은 rootfile도 나열된다 — spine(.hpf/package)만
          if (p && (/\.hpf$/i.test(p) || /package/i.test(mt))) hpfPaths.push(normName(p));
        }
      });
  }
  for (const n of names) if (/\.hpf$/i.test(n) && !hpfPaths.includes(n)) hpfPaths.push(n);

  const out: { hpfPath: string; items: Map<string, string>; spineIds: string[] }[] = [];
  for (const hpfPath of hpfPaths) {
    const hpfXml = textOf(hpfPath);
    if (!hpfXml) continue;
    const doc = parseXmlSafe(hpfXml);
    if (!doc) continue;
    const items = new Map<string, string>(); // id → href
    const spineIds: string[] = [];
    forEachEl(doc, (el) => {
      const name = ln(el);
      if (name === 'item') {
        const id = attrOf(el, 'id');
        const href = attrOf(el, 'href');
        if (id && href) items.set(id, href);
      } else if (name === 'itemref') {
        const idref = attrOf(el, 'idref');
        if (idref) spineIds.push(idref);
      }
    });
    out.push({ hpfPath, items, spineIds });
  }
  return out;
}

/** container.xml → *.hpf(spine) 순으로 본문 XML 경로를 알아낸다 */
function sectionsFromSpine(
  manifests: { hpfPath: string; items: Map<string, string>; spineIds: string[] }[],
  realNameOf: (name: string) => string | undefined,
): string[] {
  const out: string[] = [];
  for (const { hpfPath, items, spineIds } of manifests) {
    const dir = hpfPath.includes('/') ? hpfPath.slice(0, hpfPath.lastIndexOf('/') + 1) : '';
    for (const id of spineIds) {
      const href = items.get(id);
      if (!href || !/\.xml$/i.test(href)) continue;
      // hpf 기준 상대경로와 zip 루트 기준 둘 다 시도
      for (const cand of [resolvePath(dir, href), normName(href)]) {
        const real = realNameOf(cand);
        if (real) {
          if (!out.includes(real)) out.push(real);
          break;
        }
      }
    }
  }
  return out;
}

/* ── 최후 폴백: 서식 없는 텍스트 ── */

function decodeEntitiesText(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (_m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    const lower = body.toLowerCase();
    const base: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    return base[lower] ?? HTML_ENTITIES[lower] ?? '';
  });
}

/** DOM으로도 못 여는 XML에서 태그만 벗겨 텍스트 회수 */
function stripTags(xml: string): string {
  const noTags = xml
    .replace(/<\?[\s\S]*?\?>/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, '\n');
  return decodeEntitiesText(noTags);
}

function collectTextNodes(n: Node, out: string[]) {
  const kids = n.childNodes;
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (c.nodeType === 3 || c.nodeType === 4) {
      const v = (c.nodeValue ?? '').trim();
      if (v) out.push(v);
    } else if (c.nodeType === 1) collectTextNodes(c, out);
  }
}

/* ── 이미지(BinData) 해석 ── */

/** 브라우저 <img>가 그릴 수 있는 포맷만 — wmf/emf/tif 등은 깨진 아이콘 대신 조용히 생략 */
function mimeOfImage(path: string): string | null {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  const ext = m ? m[1].toLowerCase() : '';
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'bmp': return 'image/bmp';
    case 'webp': return 'image/webp';
    case 'svg': return 'image/svg+xml';
    default: return null;
  }
}

/* ── 진입점 ── */

/**
 * hwpx zip 엔트리(이름 → 바이트)를 받아 미리보기 블록을 돌려준다.
 * 어떤 방법으로도 텍스트를 못 찾으면 [] — 호출부가 기존 안내 문구를 보여준다.
 */
export function parseHwpx(files: Record<string, Uint8Array>): HwpxBlock[] {
  const byName = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(files)) {
    if (v && v.length > 0 && v.length <= MAX_ENTRY_BYTES) byName.set(normName(k), v);
  }
  const lowerIndex = new Map<string, string>();
  for (const k of byName.keys()) lowerIndex.set(k.toLowerCase(), k);
  const realNameOf = (name: string) => lowerIndex.get(normName(name).toLowerCase());
  const textCache = new Map<string, string | null>();
  const textOf = (name: string): string | null => {
    const real = realNameOf(name);
    if (!real) return null;
    if (!textCache.has(real)) {
      const bytes = byName.get(real);
      textCache.set(real, bytes ? decodeBytes(bytes) : null);
    }
    return textCache.get(real) ?? null;
  };
  const docCache = new Map<string, Document | null>();
  const docOf = (name: string): Document | null => {
    const real = realNameOf(name);
    if (!real) return null;
    if (!docCache.has(real)) {
      const xml = textOf(real);
      docCache.set(real, xml ? parseXmlSafe(xml) : null);
    }
    return docCache.get(real) ?? null;
  };

  const allNames = [...byName.keys()];
  const xmlNames = allNames.filter((n) => /\.xml$/i.test(n));
  // 메타·설정류 제외 — 본문일 가능성이 있는 XML만
  const contentish = (n: string) =>
    !/^meta-inf\//i.test(n) && !/(^|\/)(settings|version|manifest|container)\.xml$/i.test(n);
  // Contents/ 우선, 이후 숫자 인식 정렬
  const contentsFirst = (a: string, b: string) => {
    const ac = /^contents\//i.test(a) ? 0 : 1;
    const bc = /^contents\//i.test(b) ? 0 : 1;
    return ac - bc || a.localeCompare(b, undefined, { numeric: true });
  };

  const manifests = readManifests(allNames, textOf);

  // 1) spine 기준 발견
  let sectionNames = sectionsFromSpine(manifests, realNameOf);
  // 2) 폴백: section*.xml 글롭 (경로·대소문자 무관)
  if (sectionNames.length === 0) {
    sectionNames = xmlNames
      .filter((n) => /(^|\/)section\d*\.xml$/i.test(n))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }
  // 3) 폴백: 문단(p)과 텍스트(t)를 실제로 가진 XML 전수 탐색
  if (sectionNames.length === 0) {
    for (const n of xmlNames.filter(contentish).sort(contentsFirst)) {
      const doc = docOf(n);
      if (!doc) continue;
      let hasP = false;
      let hasT = false;
      forEachEl(doc, (el) => {
        const name = ln(el);
        if (name === 'p') hasP = true;
        else if (name === 't' && textOfT(el).trim()) hasT = true;
      });
      if (hasP && hasT) sectionNames.push(n);
    }
  }

  // 서식 컨텍스트 — 실패해도 서식 없이 계속 (기존 렌더가 퇴화하면 안 됨)
  const ctx = emptyCtx();
  try {
    // header.xml 발견: 글롭 → charPr를 가진 XML 전수 탐색
    let headerName = xmlNames.find((n) => /(^|\/)header\.xml$/i.test(n));
    if (!headerName) {
      headerName = xmlNames.filter(contentish).find((n) => {
        const doc = docOf(n);
        if (!doc) return false;
        let hasCharPr = false;
        forEachEl(doc, (el) => {
          if (ln(el) === 'charpr') hasCharPr = true;
        });
        return hasCharPr;
      });
    }
    if (headerName) {
      const doc = docOf(headerName);
      if (doc) parseHeaderInto(ctx, doc);
    }
  } catch {
    ctx.char.clear();
    ctx.paraAlign.clear();
    ctx.cellBg.clear();
  }

  // 이미지 해석기 — manifest id→href 우선, BinData/* 파일명(stem) 매칭 폴백. 용량 가드 포함
  try {
    const binCache = new Map<string, { data: Uint8Array; mime: string } | null>();
    let imgTotal = 0;
    ctx.binLookup = (idRef: string) => {
      if (binCache.has(idRef)) return binCache.get(idRef) ?? null;
      let real: string | undefined;
      for (const { hpfPath, items } of manifests) {
        const href = items.get(idRef);
        if (!href) continue;
        const dir = hpfPath.includes('/') ? hpfPath.slice(0, hpfPath.lastIndexOf('/') + 1) : '';
        real = realNameOf(resolvePath(dir, href)) ?? realNameOf(href);
        if (real) break;
      }
      if (!real) {
        const lower = idRef.toLowerCase();
        for (const n of allNames) {
          if (!/(^|\/)bindata\//i.test(n)) continue;
          const base = n.slice(n.lastIndexOf('/') + 1).toLowerCase();
          if (base === lower || base.replace(/\.[^.]+$/, '') === lower) {
            real = n;
            break;
          }
        }
      }
      let resolved: { data: Uint8Array; mime: string } | null = null;
      if (real) {
        const bytes = byName.get(real);
        const mime = mimeOfImage(real);
        if (bytes && mime && bytes.length <= MAX_IMG_BYTES && imgTotal + bytes.length <= MAX_IMG_TOTAL) {
          imgTotal += bytes.length;
          resolved = { data: bytes, mime };
        }
      }
      binCache.set(idRef, resolved);
      return resolved;
    };
  } catch {
    ctx.binLookup = undefined;
  }

  // 구조 파싱 — 서식 파싱이 던지면 블록을 비워 아래 서식 없는 텍스트 폴백으로 강등
  let blocks: HwpxBlock[] = [];
  try {
    for (const name of sectionNames.slice(0, MAX_SECTIONS)) {
      const doc = docOf(name);
      if (!doc) continue;
      extractBlocksFromDoc(doc, blocks, ctx);
      if (blocks.length > MAX_BLOCKS) break;
    }
  } catch {
    blocks = [];
  }
  if (blocks.length > 0) return blocks.slice(0, MAX_BLOCKS);

  // 4) 최후 폴백 — 서식 없는 텍스트 모드
  let acc = '';
  const push = (s: string) => {
    if (acc.length < MAX_PLAIN_CHARS && s.trim()) acc += s.replace(/\s+$/, '') + '\n';
  };
  for (const name of xmlNames.filter(contentish).sort(contentsFirst)) {
    if (acc.length >= MAX_PLAIN_CHARS) break;
    const doc = docOf(name);
    if (doc) {
      const ts: string[] = [];
      collectT(doc, ts);
      if (ts.some((t) => t.trim())) push(ts.filter((t) => t.trim()).join('\n'));
      else {
        const texts: string[] = [];
        collectTextNodes(doc, texts);
        push(texts.join('\n'));
      }
    } else {
      const raw = textOf(name);
      if (raw) push(stripTags(raw));
    }
  }
  // 그래도 비면 한/글이 넣어두는 미리보기 텍스트(PrvText.txt)라도
  if (!acc.trim()) {
    for (const n of allNames) {
      if (/prvtext\.txt$/i.test(n)) {
        const bytes = byName.get(n);
        if (bytes) acc = decodeBytes(bytes);
        break;
      }
    }
  }
  return acc
    .slice(0, MAX_PLAIN_CHARS)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_BLOCKS)
    .map((text) => ({ kind: 'p' as const, text }));
}
