// PNG アイコン生成スクリプト（canvas不要・純粋なNode.jsのみ）
// 単色の紫背景 + 🐾 テキストをSVGで表現し、それをPNGバイトに変換する
// ここでは最小限のPNGバイナリを生成する

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  const table = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeData = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeData));
  return Buffer.concat([len, typeData, crc]);
}

function generatePNG(size) {
  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // 各行のピクセルデータ（紫色 #7c3aed）
  const r = 0x7c, g = 0x3a, b = 0xed;

  // 丸角の計算（radius = size * 0.22）
  const radius = Math.round(size * 0.22);

  const rawRows = [];
  for (let y = 0; y < size; y++) {
    const row = [0]; // filter byte
    for (let x = 0; x < size; x++) {
      // 丸角マスク判定
      let inside = true;
      if (x < radius && y < radius) {
        const dx = radius - x - 1, dy = radius - y - 1;
        inside = dx*dx + dy*dy <= radius*radius;
      } else if (x >= size - radius && y < radius) {
        const dx = x - (size - radius), dy = radius - y - 1;
        inside = dx*dx + dy*dy <= radius*radius;
      } else if (x < radius && y >= size - radius) {
        const dx = radius - x - 1, dy = y - (size - radius);
        inside = dx*dx + dy*dy <= radius*radius;
      } else if (x >= size - radius && y >= size - radius) {
        const dx = x - (size - radius), dy = y - (size - radius);
        inside = dx*dx + dy*dy <= radius*radius;
      }

      if (inside) {
        row.push(r, g, b);
      } else {
        row.push(0x0d, 0x0d, 0x1a); // 背景色
      }
    }
    rawRows.push(Buffer.from(row));
  }

  const rawData = Buffer.concat(rawRows);
  const compressed = zlib.deflateSync(rawData, { level: 6 });

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, 'public', 'icons');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

for (const size of [192, 512]) {
  const png = generatePNG(size);
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), png);
  console.log(`Generated icon-${size}.png (${png.length} bytes)`);
}
