/* ── 한글(구형 .hwp 5.x / 바이너리) 파서 — CollabFiles 인앱 미리보기의 순수 로직.
 *
 * hwpx(zip+XML)와 달리 hwp는 OLE 복합문서(CFB) 컨테이너다:
 *   FileHeader(플래그) + BodyText/Section0..N(raw deflate 압축된 레코드 스트림) + PrvText(미리보기).
 * 여기서는 "본문 텍스트를 문단 단위로" 뽑는 것까지만 책임진다 —
 * 서식(굵게·색)·표 구조·이미지는 미지원(표 셀 텍스트는 읽기 순서대로 문단으로 나온다).
 * 결과 타입은 hwpx 파서와 같은 HwpxBlock[]이라 렌더러(HwpxBlocks)를 그대로 쓴다.
 *
 * 강건화 포인트:
 *  1) CFB: DIFAT 연장 섹터·미니FAT(4096B 미만 스트림)·체인 순환 가드까지 정식 구현.
 *  2) 암호 문서는 즉시 실패(빈 배열 → 기존 안내 문구), 배포용(distribute) 문서는
 *     ViewText가 난독화라 본문 대신 PrvText로 강등.
 *  3) 압축 해제: 표준은 raw deflate — 실패 시 zlib 래핑(deflate)으로 재시도,
 *     스트림 꼬리가 깨져도 그때까지 읽은 바이트는 살린다.
 *  4) 본문 파싱이 비면 PrvText(UTF-16LE) 폴백. 그래도 비면 []를 돌려 안내 문구가 뜬다.
 *
 * 전역 의존은 DecompressionStream·TextDecoder뿐 — Node(≥18)에서도 그대로 단위 테스트 가능. */

import type { HwpxBlock } from './hwpx';

const MAX_BLOCKS = 3000; // hwpx 파서와 동일 상한
const MAX_STREAM_BYTES = 64 * 1024 * 1024; // 비정상 스트림 가드
const FREE = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;

/* ── CFB(OLE 복합문서) 최소 리더 ── */

interface DirEntry {
  name: string;
  type: number; // 1=storage 2=stream 5=root
  left: number;
  right: number;
  child: number;
  start: number;
  size: number;
}

interface Cfb {
  entries: Map<string, DirEntry>; // 'BodyText/Section0' 같은 전체 경로 → 엔트리
  read(e: DirEntry): Uint8Array;
}

function parseCfb(bytes: Uint8Array): Cfb {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (off: number) => dv.getUint32(off, true);
  const u16 = (off: number) => dv.getUint16(off, true);
  // 시그니처 D0 CF 11 E0 A1 B1 1A E1
  if (bytes.length < 512 || u32(0) !== 0xe011cfd0 || u32(4) !== 0xe11ab1a1)
    throw new Error('CFB 아님');

  const sectorShift = u16(30); // 보통 9(512B), v4는 12(4096B)
  if (sectorShift < 7 || sectorShift > 20) throw new Error('섹터 크기 이상');
  const sectorSize = 1 << sectorShift;
  const miniSectorSize = 1 << u16(32); // 보통 64
  const miniCutoff = u32(56); // 보통 4096
  const entriesPerSector = sectorSize / 4;
  const sectorAt = (sec: number) => {
    const off = (sec + 1) << sectorShift;
    if (off < 0 || off + sectorSize > bytes.length) throw new Error('섹터 범위 밖');
    return off;
  };

  // FAT: 헤더 DIFAT 109개 + 연장 DIFAT 섹터들
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) {
    const s = u32(76 + i * 4);
    if (s < 0xfffffffc) fatSectors.push(s);
  }
  let difat = u32(68);
  for (let guard = 0; difat !== ENDOFCHAIN && difat !== FREE && guard < 4096; guard++) {
    const off = sectorAt(difat);
    for (let i = 0; i < entriesPerSector - 1; i++) {
      const s = dv.getUint32(off + i * 4, true);
      if (s < 0xfffffffc) fatSectors.push(s);
    }
    difat = dv.getUint32(off + (entriesPerSector - 1) * 4, true);
  }
  const fat: number[] = [];
  for (const fs of fatSectors) {
    const off = sectorAt(fs);
    for (let i = 0; i < entriesPerSector; i++) fat.push(dv.getUint32(off + i * 4, true));
  }

  /** FAT 체인을 따라 스트림 전체 바이트를 모은다 (순환·폭주 가드) */
  const readChain = (start: number, size: number): Uint8Array => {
    if (size > MAX_STREAM_BYTES) throw new Error('스트림 과대');
    const out = new Uint8Array(size);
    let sec = start;
    let done = 0;
    for (let guard = 0; done < size && sec !== ENDOFCHAIN && sec !== FREE; guard++) {
      if (guard > fat.length + 16) throw new Error('FAT 체인 순환');
      const off = sectorAt(sec);
      const n = Math.min(sectorSize, size - done);
      out.set(bytes.subarray(off, off + n), done);
      done += n;
      sec = fat[sec] ?? ENDOFCHAIN;
    }
    return out;
  };

  // 디렉터리 엔트리(128B) 수집
  const raw: DirEntry[] = [];
  let dirSec = u32(48);
  for (let guard = 0; dirSec !== ENDOFCHAIN && dirSec !== FREE && guard < 65536; guard++) {
    const off = sectorAt(dirSec);
    for (let e = 0; e + 128 <= sectorSize; e += 128) {
      const base = off + e;
      const nameLen = dv.getUint16(base + 64, true); // 널 종료 포함 바이트 수
      const type = bytes[base + 66];
      let name = '';
      for (let i = 0; i + 2 <= Math.min(nameLen, 64) - 2; i += 2)
        name += String.fromCharCode(dv.getUint16(base + i, true));
      raw.push({
        name,
        type,
        left: dv.getUint32(base + 68, true),
        right: dv.getUint32(base + 72, true),
        child: dv.getUint32(base + 76, true),
        start: dv.getUint32(base + 116, true),
        size: dv.getUint32(base + 120, true), // 상위 32비트는 무시 — hwp 스트림엔 충분
      });
    }
    dirSec = fat[dirSec] ?? ENDOFCHAIN;
  }
  const root = raw[0];
  if (!root || root.type !== 5) throw new Error('루트 엔트리 없음');

  // 미니 스트림(루트의 데이터)과 미니FAT — 4096B 미만 스트림이 여기 산다
  const miniStream = root.size > 0 ? readChain(root.start, root.size) : new Uint8Array(0);
  const miniFat: number[] = [];
  {
    const first = u32(60);
    const count = u32(64);
    if (first !== ENDOFCHAIN && first !== FREE && count > 0) {
      const mf = readChain(first, Math.min(count * sectorSize, MAX_STREAM_BYTES));
      const mdv = new DataView(mf.buffer, mf.byteOffset, mf.byteLength);
      for (let i = 0; i + 4 <= mf.length; i += 4) miniFat.push(mdv.getUint32(i, true));
    }
  }
  const readMiniChain = (start: number, size: number): Uint8Array => {
    const out = new Uint8Array(size);
    let sec = start;
    let done = 0;
    for (let guard = 0; done < size && sec !== ENDOFCHAIN && sec !== FREE; guard++) {
      if (guard > miniFat.length + 16) throw new Error('미니FAT 체인 순환');
      const off = sec * miniSectorSize;
      const n = Math.min(miniSectorSize, size - done);
      out.set(miniStream.subarray(off, off + n), done);
      done += n;
      sec = miniFat[sec] ?? ENDOFCHAIN;
    }
    return out;
  };

  // 좌·우 형제/자식 트리를 걸어 전체 경로를 만든다 — BodyText/Section0 과 ViewText/Section0 구분용
  const entries = new Map<string, DirEntry>();
  const walk = (id: number, prefix: string, guard: Set<number>) => {
    if (id === FREE || id >= raw.length || guard.has(id)) return;
    guard.add(id);
    const e = raw[id];
    walk(e.left, prefix, guard);
    walk(e.right, prefix, guard);
    const path = prefix + e.name;
    if (!entries.has(path)) entries.set(path, e);
    if (e.type === 1 && e.child !== FREE) walk(e.child, path + '/', guard);
  };
  walk(root.child, '', new Set());

  return {
    entries,
    read: (e) => (e.size < miniCutoff && e !== root ? readMiniChain(e.start, e.size) : readChain(e.start, e.size)),
  };
}

/* ── 압축 해제 — 표준은 raw deflate. 꼬리가 깨진 스트림도 읽은 데까지는 살린다 ── */

async function inflateWith(format: 'deflate-raw' | 'deflate', data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream(format);
  const writer = ds.writable.getWriter();
  // write/close 의 거부는 reader 쪽 에러로도 나타난다 — 미처리 rejection만 막는다
  writer.write(new Uint8Array(data)).catch(() => {});
  writer.close().catch(() => {});
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.length;
        if (total > MAX_STREAM_BYTES) throw new Error('해제 결과 과대');
      }
    }
  } catch (e) {
    if (chunks.length === 0) throw e; // 하나도 못 읽었으면 진짜 실패
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  try {
    const out = await inflateWith('deflate-raw', data);
    if (out.length > 0) return out;
  } catch {
    /* 아래 zlib 래핑 재시도 */
  }
  return inflateWith('deflate', data);
}

/* ── 레코드 스트림 → 문단 텍스트 ──
 * 레코드 헤더(u32): tagID 10비트 / level 10비트 / size 12비트(0xFFF면 다음 u32가 실제 크기).
 * HWPTAG_PARA_TEXT(=67) 페이로드가 문단 하나의 UTF-16LE 텍스트다. */

const HWPTAG_PARA_TEXT = 67;
// 제어 문자: 8워드(현재 워드 포함)를 차지하는 인라인·확장 컨트롤
const CTRL_8WORDS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);

function decodeParaText(dv: DataView, start: number, size: number): string {
  let out = '';
  let i = 0;
  const words = Math.floor(size / 2);
  while (i < words) {
    const c = dv.getUint16(start + i * 2, true);
    if (c === 9) {
      out += '\t';
      i += 8;
    } else if (CTRL_8WORDS.has(c)) {
      i += 8; // 표·그림·필드 앵커 등 — 텍스트 아님
    } else if (c === 10) {
      out += '\n';
      i += 1;
    } else if (c < 32) {
      i += 1; // 문단 끝(13) 등 1워드 제어
    } else {
      out += String.fromCharCode(c);
      i += 1;
    }
  }
  return out;
}

function parseSectionRecords(section: Uint8Array, blocks: HwpxBlock[]) {
  const dv = new DataView(section.buffer, section.byteOffset, section.byteLength);
  let pos = 0;
  while (pos + 4 <= section.length && blocks.length < MAX_BLOCKS) {
    const h = dv.getUint32(pos, true);
    const tag = h & 0x3ff;
    let size = (h >>> 20) & 0xfff;
    pos += 4;
    if (size === 0xfff) {
      if (pos + 4 > section.length) break;
      size = dv.getUint32(pos, true);
      pos += 4;
    }
    if (size > section.length - pos) break; // 손상 스트림 — 여기까지만
    if (tag === HWPTAG_PARA_TEXT) blocks.push({ kind: 'p', text: decodeParaText(dv, pos, size) });
    pos += size;
  }
}

/* ── 공개 API ── */

/** hwp 바이트가 맞는지 빠른 판별 — CFB 시그니처(D0 CF 11 E0)만 본다 */
export function looksLikeHwp(bytes: Uint8Array): boolean {
  return bytes.length > 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
}

/**
 * 구형 .hwp(5.x) 바이트를 받아 미리보기 블록을 돌려준다 — 문단 텍스트만.
 * 암호 문서·완파 손상이면 [] (호출부의 기존 안내 문구가 뜬다).
 */
export async function parseHwp(bytes: Uint8Array): Promise<HwpxBlock[]> {
  let cfb: Cfb;
  try {
    cfb = parseCfb(bytes);
  } catch {
    return [];
  }

  const header = cfb.entries.get('FileHeader');
  if (!header) return [];
  let flags = 0;
  try {
    const hb = cfb.read(header);
    // 시그니처 "HWP Document File" 확인 — 다른 OLE 문서(doc·xls)를 잘못 파싱하지 않게
    const sig = String.fromCharCode(...hb.subarray(0, 17));
    if (sig !== 'HWP Document File') return [];
    flags = new DataView(hb.buffer, hb.byteOffset, hb.byteLength).getUint32(36, true);
  } catch {
    return [];
  }
  const compressed = (flags & 1) !== 0;
  const encrypted = (flags & 2) !== 0;
  const distribute = (flags & 4) !== 0;
  if (encrypted) return []; // 암호는 내용 접근 불가

  const blocks: HwpxBlock[] = [];
  if (!distribute) {
    // BodyText/Section{n} 을 번호순으로 — 배포용 문서의 ViewText는 난독화라 건드리지 않는다
    const sections = [...cfb.entries.entries()]
      .filter(([path]) => /^BodyText\/Section\d+$/.test(path))
      .sort(([a], [b]) => parseInt(a.slice(17), 10) - parseInt(b.slice(17), 10));
    for (const [, entry] of sections) {
      if (blocks.length >= MAX_BLOCKS) break;
      try {
        const rawSec = cfb.read(entry);
        const sec = compressed ? await inflate(rawSec) : rawSec;
        parseSectionRecords(sec, blocks);
      } catch {
        /* 섹션 하나가 깨져도 나머지는 계속 */
      }
    }
  }

  // 본문이 비면(배포용 포함) PrvText(UTF-16LE 미리보기 텍스트)로 강등
  if (blocks.every((b) => b.kind !== 'p' || !b.text.trim())) {
    const prv = cfb.entries.get('PrvText');
    if (prv) {
      try {
        const text = new TextDecoder('utf-16le').decode(cfb.read(prv)).replace(/^﻿/, '');
        if (text.trim())
          return text.split(/\r\n|\r|\n/).slice(0, MAX_BLOCKS).map((line) => ({ kind: 'p', text: line }));
      } catch {
        /* 폴백도 실패 — 빈 결과로 */
      }
    }
    return [];
  }
  return blocks;
}
