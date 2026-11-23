/**
 * Scrub secrets out of a Playwright trace zip. A trace records every value typed into the page, so a
 * credential read from `valueEnv` would sit in it in plain text: "masked in every output" includes
 * the trace. Rewrites the zip with every text entry's secret occurrences replaced by •••; images
 * are left as they are. Dependency-free: stored and deflated entries, no zip64 (traces are small).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';

const BINARY = /\.(png|jpe?g|webp|gif|woff2?|ttf|ico|zip)$/i;

function readEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : method === 0 ? Buffer.from(raw) : null;
    if (!data) throw new Error(`unsupported compression ${method} for ${name}`);
    entries.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, comp);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** The text of every entry of a zip (for tests and checks). */
export function zipTexts(path) {
  return readEntries(readFileSync(path)).filter((e) => !BINARY.test(e.name)).map((e) => ({ name: e.name, text: e.data.toString('utf8') }));
}

/** Replace every secret in the zip's text entries with •••. Returns how many entries changed. */
export function scrubZip(path, secrets) {
  const list = [...secrets].filter(Boolean);
  if (list.length === 0) return 0;
  const entries = readEntries(readFileSync(path));
  let changed = 0;
  for (const e of entries) {
    if (BINARY.test(e.name)) continue;
    let text = e.data.toString('utf8');
    const before = text;
    for (const s of list) {
      text = text.split(s).join('•••');
      // JSON-escaped forms, for values with quotes or backslashes.
      const escaped = JSON.stringify(s).slice(1, -1);
      if (escaped !== s) text = text.split(escaped).join('•••');
    }
    if (text !== before) { e.data = Buffer.from(text, 'utf8'); changed++; }
  }
  if (changed) writeFileSync(path, writeZip(entries));
  return changed;
}
