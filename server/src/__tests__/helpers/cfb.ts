import zlib from 'node:zlib';

/*
 * 테스트용 최소 CFB(OLE2 복합 문서) 작성기 + 한글 hwp 5.x 픽스처 생성 — filetext.ts의 hwp 파서 검증용.
 * 실제 .hwp 파일을 저장소에 넣지 않고 바이트를 조립한다.
 *   - 섹터 512B / 미니 섹터 64B / 미니 스트림 컷오프 4096B (MS-CFB 기본값)
 *   - 컷오프 미만 스트림은 루트 엔트리의 미니 스트림에, 이상은 일반 FAT 체인에 들어간다
 *   - DIFAT 확장 섹터는 만들지 않는다 (FAT 109섹터 이하 = 7MB 이하)
 */

const SECTOR = 512;
const MINI = 64;
const FREE = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;

export interface CfbStream {
  /** 'FileHeader' | 'BodyText/Section0' 처럼 '/'로 구분한 경로 */
  path: string;
  data: Buffer;
}

interface Ent {
  name: string;
  type: number; // 1 storage, 2 stream, 5 root
  left: number;
  right: number;
  child: number;
  start: number;
  size: number;
  data?: Buffer;
}

export function buildCfb(
  streams: CfbStream[],
  opts: { miniCutoff?: number; rootType?: number; sectorShift?: number } = {},
): Buffer {
  const cutoff = opts.miniCutoff ?? 4096;
  const ents: Ent[] = [{ name: 'Root Entry', type: 5, left: FREE, right: FREE, child: FREE, start: ENDOFCHAIN, size: 0 }];
  const dirIds = new Map<string, number>([['', 0]]);
  const lastChild = new Map<number, number>(); // parentId → 마지막 자식 id (right 체인용)
  const link = (parent: number, id: number) => {
    const prev = lastChild.get(parent);
    if (prev == null) ents[parent].child = id;
    else ents[prev].right = id;
    lastChild.set(parent, id);
  };
  const ensureDir = (p: string): number => {
    if (dirIds.has(p)) return dirIds.get(p)!;
    const idx = p.lastIndexOf('/');
    const parent = ensureDir(idx < 0 ? '' : p.slice(0, idx));
    const id = ents.push({ name: p.slice(idx + 1), type: 1, left: FREE, right: FREE, child: FREE, start: 0, size: 0 }) - 1;
    dirIds.set(p, id);
    link(parent, id);
    return id;
  };
  for (const s of streams) {
    const idx = s.path.lastIndexOf('/');
    const parent = ensureDir(idx < 0 ? '' : s.path.slice(0, idx));
    const id = ents.push({ name: s.path.slice(idx + 1), type: 2, left: FREE, right: FREE, child: FREE, start: ENDOFCHAIN, size: s.data.length, data: s.data }) - 1;
    link(parent, id);
  }

  // 미니 스트림 컨테이너 + 미니 FAT
  const miniChunks: Buffer[] = [];
  const miniFat: number[] = [];
  let miniSec = 0;
  for (const e of ents) {
    if (e.type !== 2 || !e.data || e.size >= cutoff) continue;
    const n = Math.max(1, Math.ceil(e.size / MINI));
    e.start = e.size === 0 ? ENDOFCHAIN : miniSec;
    for (let i = 0; i < n; i++) {
      miniFat.push(i === n - 1 ? ENDOFCHAIN : miniSec + i + 1);
      const chunk = Buffer.alloc(MINI);
      e.data.copy(chunk, 0, i * MINI, Math.min(e.size, (i + 1) * MINI));
      miniChunks.push(chunk);
    }
    miniSec += n;
  }
  const miniContainer = Buffer.concat(miniChunks);
  const miniFatBuf = Buffer.alloc(Math.ceil((miniFat.length * 4) / SECTOR) * SECTOR, 0xff);
  miniFat.forEach((v, i) => miniFatBuf.writeUInt32LE(v, i * 4));

  // 일반 섹터 배치: [FAT][DIR][miniFAT][mini container][big streams]
  const dirBuf = Buffer.alloc(Math.ceil((ents.length * 128) / SECTOR) * SECTOR);
  const dirSectors = dirBuf.length / SECTOR;
  const miniFatSectors = miniFat.length ? miniFatBuf.length / SECTOR : 0;
  const miniContSectors = Math.ceil(miniContainer.length / SECTOR);
  const big = ents.filter((e) => e.type === 2 && e.data && e.size >= cutoff);
  const bigSectors = big.map((e) => Math.ceil(e.size / SECTOR));
  const payloadSectors = dirSectors + miniFatSectors + miniContSectors + bigSectors.reduce((a, b) => a + b, 0);
  let fatSectors = 1;
  while (Math.ceil((fatSectors + payloadSectors) / (SECTOR / 4)) > fatSectors) fatSectors++;
  const total = fatSectors + payloadSectors;
  const fat = new Array<number>(fatSectors * (SECTOR / 4)).fill(FREE);
  let cursor = 0;
  const chain = (n: number): number => {
    const start = cursor;
    for (let i = 0; i < n; i++) fat[cursor + i] = i === n - 1 ? ENDOFCHAIN : cursor + i + 1;
    cursor += n;
    return n ? start : ENDOFCHAIN;
  };
  for (let i = 0; i < fatSectors; i++) fat[i] = FATSECT;
  cursor = fatSectors;
  const dirStart = chain(dirSectors);
  const miniFatStart = chain(miniFatSectors);
  const miniContStart = chain(miniContSectors);
  ents[0].start = miniContStart;
  ents[0].size = miniContainer.length;
  ents[0].type = opts.rootType ?? 5;
  const body: Buffer[] = [];
  big.forEach((e, i) => {
    e.start = chain(bigSectors[i]);
    const padded = Buffer.alloc(bigSectors[i] * SECTOR);
    e.data!.copy(padded);
    body.push(padded);
  });

  ents.forEach((e, i) => {
    const b = dirBuf.subarray(i * 128, (i + 1) * 128);
    const name = Buffer.from(e.name, 'utf16le');
    name.copy(b, 0, 0, Math.min(name.length, 62));
    b.writeUInt16LE(Math.min(name.length, 62) + 2, 64);
    b[66] = e.type;
    b[67] = 1;
    b.writeUInt32LE(e.left, 68);
    b.writeUInt32LE(e.right, 72);
    b.writeUInt32LE(e.child, 76);
    b.writeUInt32LE(e.start, 116);
    b.writeUInt32LE(e.size, 120);
  });

  const header = Buffer.alloc(SECTOR);
  header.writeUInt32LE(0xe011cfd0, 0);
  header.writeUInt32LE(0xe11ab1a1, 4);
  header.writeUInt16LE(0x3e, 24);
  header.writeUInt16LE(3, 26);
  header.writeUInt16LE(0xfffe, 28);
  header.writeUInt16LE(opts.sectorShift ?? 9, 30);
  header.writeUInt16LE(6, 32);
  header.writeUInt32LE(fatSectors, 44);
  header.writeUInt32LE(dirStart, 48);
  header.writeUInt32LE(cutoff, 56);
  header.writeUInt32LE(miniFatStart, 60);
  header.writeUInt32LE(miniFatSectors, 64);
  header.writeUInt32LE(ENDOFCHAIN, 68);
  header.writeUInt32LE(0, 72);
  for (let i = 0; i < 109; i++) header.writeUInt32LE(i < fatSectors ? i : FREE, 76 + i * 4);

  const fatBuf = Buffer.alloc(fatSectors * SECTOR);
  fat.forEach((v, i) => fatBuf.writeUInt32LE(v, i * 4));
  const out = Buffer.concat([
    header,
    fatBuf,
    dirBuf,
    miniFatSectors ? miniFatBuf : Buffer.alloc(0),
    Buffer.concat([miniContainer, Buffer.alloc(miniContSectors * SECTOR - miniContainer.length)]),
    ...body,
  ]);
  if (out.length !== (total + 1) * SECTOR) throw new Error(`cfb layout mismatch ${out.length} vs ${(total + 1) * SECTOR}`);
  return out;
}

/* ── hwp 5.x 조각 ── */

/** FileHeader 스트림(256B) — flags bit0 압축 · bit1 암호 · bit2 배포용 */
export function hwpFileHeader(flags: number, magic = 'HWP Document File'): Buffer {
  const b = Buffer.alloc(256);
  b.write(magic, 0, 'latin1');
  b.writeUInt32LE(0x05000300, 32);
  b.writeUInt32LE(flags, 36);
  return b;
}

/** 레코드 헤더 — tag(10) | level(10) | size(12), size 0xfff면 뒤 4바이트가 실제 크기 */
export function hwpRecord(tag: number, data: Buffer, level = 0): Buffer {
  const small = data.length < 0xfff;
  const h = Buffer.alloc(small ? 4 : 8);
  h.writeUInt32LE(((tag & 0x3ff) | ((level & 0x3ff) << 10) | ((small ? data.length : 0xfff) << 20)) >>> 0, 0);
  if (!small) h.writeUInt32LE(data.length, 4);
  return Buffer.concat([h, data]);
}

/** PARA_TEXT(67) 레코드 — 문자열 또는 UTF-16 코드 유닛 배열(제어문자 포함) */
export function hwpParaText(units: string | number[]): Buffer {
  const arr = typeof units === 'string' ? [...units].map((c) => c.charCodeAt(0)) : units;
  const b = Buffer.alloc(arr.length * 2);
  arr.forEach((u, i) => b.writeUInt16LE(u, i * 2));
  return hwpRecord(67, b);
}

export const HWPTAG_PARA_HEADER = 66;

/** 한글 문서 조립 — 섹션 레코드들과 옵션(압축 방식·플래그·미리보기) */
export function buildHwp(p: {
  sections?: Buffer[];
  compress?: 'raw' | 'zlib' | 'none';
  password?: boolean;
  distribute?: boolean;
  prv?: string | null;
  magic?: string;
  withHeader?: boolean;
  extra?: CfbStream[];
  cfb?: Parameters<typeof buildCfb>[1];
}): Buffer {
  const compress = p.compress ?? 'raw';
  const flags = (compress !== 'none' ? 1 : 0) | (p.password ? 2 : 0) | (p.distribute ? 4 : 0);
  const streams: CfbStream[] = [];
  if (p.withHeader !== false) streams.push({ path: 'FileHeader', data: hwpFileHeader(flags, p.magic) });
  (p.sections ?? []).forEach((sec, i) => {
    const data = compress === 'raw' ? zlib.deflateRawSync(sec) : compress === 'zlib' ? zlib.deflateSync(sec) : sec;
    streams.push({ path: `BodyText/Section${i}`, data });
  });
  if (p.prv != null) streams.push({ path: 'PrvText', data: Buffer.concat([Buffer.from('﻿', 'utf16le'), Buffer.from(p.prv, 'utf16le')]) });
  streams.push(...(p.extra ?? []));
  return buildCfb(streams, p.cfb);
}
