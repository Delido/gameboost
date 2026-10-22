// Generates the app icon (gradient rounded square with lightning bolt) as PNG + ICO, no dependencies.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, px) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
// Lightning bolt polygon in unit coordinates
const BOLT = [[0.58, 0.14], [0.27, 0.56], [0.48, 0.56], [0.40, 0.86], [0.73, 0.42], [0.52, 0.42], [0.62, 0.14]];
function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inRounded(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r), cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const SS = 4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const u = (x + (sx + 0.5) / SS) / size, v = (y + (sy + 0.5) / SS) / size;
      if (!inRounded(u, v, 0.22)) continue;
      const t = (u + v) / 2; // gradient violet -> cyan
      let cr = 124 + (0 - 124) * t, cg = 92 + (212 - 92) * t, cb = 255 + (255 - 255) * t;
      if (inPoly(u, v, BOLT)) { cr = 255; cg = 255; cb = 255; }
      else if (inPoly(u + 0.02, v - 0.02, BOLT)) { cr *= 0.6; cg *= 0.6; cb *= 0.7; } // subtle shadow
      r += cr; g += cg; b += cb; a += 255;
    }
    const n = SS * SS, i = (y * size + x) * 4, cov = a / n / 255;
    px[i] = cov ? r / (a / 255) : 0; px[i + 1] = cov ? g / (a / 255) : 0; px[i + 2] = cov ? b / (a / 255) : 0; px[i + 3] = a / n;
  }
  return png(size, px);
}
const root = new URL("../", import.meta.url);
const p512 = render(512), p256 = render(256);
mkdirSync(new URL("raycast/assets/", root), { recursive: true });
writeFileSync(new URL("raycast/assets/icon.png", root), p512);
writeFileSync(new URL("ui/icon.png", root), p256);
// ICO with embedded PNG (supported since Windows Vista)
const hdr = Buffer.alloc(22);
hdr.writeUInt16LE(0, 0); hdr.writeUInt16LE(1, 2); hdr.writeUInt16LE(1, 4);
hdr[6] = 0; hdr[7] = 0; hdr.writeUInt16LE(1, 10); hdr.writeUInt16LE(32, 12); hdr.writeUInt32LE(p256.length, 14); hdr.writeUInt32LE(22, 18);
writeFileSync(new URL("ui/icon.ico", root), Buffer.concat([hdr, p256]));
console.log("Icons erstellt.");
