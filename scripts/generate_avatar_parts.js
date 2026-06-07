// scripts/generate_avatar_parts.js
// グレースケールPNGアバターパーツ生成スクリプト（canvas使用）

const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

const W = 32, H = 64;
const BASE = path.join(__dirname, '../public/assets/avatar');
let generated = 0;

function ensure(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function save(filePath, canvas) {
  fs.writeFileSync(filePath, canvas.toBuffer('image/png'));
  console.log(`  ✓ ${path.relative(path.join(__dirname, '..'), filePath)}`);
  generated++;
}

function newCanvas() {
  const c = createCanvas(W, H);
  // 全体を透過クリア
  c.getContext('2d').clearRect(0, 0, W, H);
  return c;
}

// ─── body_default ─────────────────────────────────────────────────────────────
function makeBody() {
  ensure(path.join(BASE, 'body'));
  const c = newCanvas();
  const ctx = c.getContext('2d');

  // 頭（円）
  ctx.fillStyle = 'rgba(180,180,180,1)';
  ctx.beginPath();
  ctx.arc(16, 8, 7, 0, Math.PI * 2);
  ctx.fill();

  // 首
  ctx.fillRect(13, 15, 6, 4);

  // 胴体
  ctx.fillStyle = 'rgba(160,160,160,1)';
  ctx.fillRect(8, 19, 16, 18);

  // 腕（左右）
  ctx.fillStyle = 'rgba(170,170,170,1)';
  ctx.fillRect(2, 19, 6, 14);   // 左腕
  ctx.fillRect(24, 19, 6, 14);  // 右腕

  // 脚（左右）
  ctx.fillStyle = 'rgba(150,150,150,1)';
  ctx.fillRect(9, 37, 6, 20);   // 左脚
  ctx.fillRect(17, 37, 6, 20);  // 右脚

  // 手
  ctx.fillStyle = 'rgba(180,180,180,1)';
  ctx.beginPath(); ctx.arc(5, 34, 3, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc(27, 34, 3, 0, Math.PI*2); ctx.fill();

  // 足
  ctx.fillStyle = 'rgba(130,130,130,1)';
  ctx.fillRect(7, 57, 9, 5);
  ctx.fillRect(16, 57, 9, 5);

  save(path.join(BASE, 'body', 'body_default.png'), c);
}

// ─── eyes ─────────────────────────────────────────────────────────────────────
const eyeDefs = [
  // 01: 丸目
  (ctx) => {
    ctx.fillStyle = 'rgba(60,60,60,1)';
    ctx.beginPath(); ctx.arc(11, 11, 2.5, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(21, 11, 2.5, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = 'rgba(220,220,220,1)';
    ctx.beginPath(); ctx.arc(12, 10, 1, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(22, 10, 1, 0, Math.PI*2); ctx.fill();
  },
  // 02: 細目（横長楕円）
  (ctx) => {
    ctx.fillStyle = 'rgba(60,60,60,1)';
    ctx.beginPath(); ctx.ellipse(11, 11, 3.5, 1.5, 0, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(21, 11, 3.5, 1.5, 0, 0, Math.PI*2); ctx.fill();
  },
  // 03: つり目（外側上がり）
  (ctx) => {
    ctx.fillStyle = 'rgba(60,60,60,1)';
    ctx.save();
    ctx.translate(11, 11); ctx.rotate(-0.3);
    ctx.beginPath(); ctx.ellipse(0, 0, 3, 1.8, 0, 0, Math.PI*2); ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.translate(21, 11); ctx.rotate(0.3);
    ctx.beginPath(); ctx.ellipse(0, 0, 3, 1.8, 0, 0, Math.PI*2); ctx.fill();
    ctx.restore();
  },
  // 04: たれ目（外側下がり）
  (ctx) => {
    ctx.fillStyle = 'rgba(60,60,60,1)';
    ctx.save();
    ctx.translate(11, 11); ctx.rotate(0.3);
    ctx.beginPath(); ctx.ellipse(0, 0, 3, 2, 0, 0, Math.PI*2); ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.translate(21, 11); ctx.rotate(-0.3);
    ctx.beginPath(); ctx.ellipse(0, 0, 3, 2, 0, 0, Math.PI*2); ctx.fill();
    ctx.restore();
    ctx.fillStyle = 'rgba(220,220,220,1)';
    ctx.beginPath(); ctx.arc(12, 10.5, 1, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(22, 10.5, 1, 0, Math.PI*2); ctx.fill();
  },
  // 05: ハーフ目（半閉じ）
  (ctx) => {
    ctx.fillStyle = 'rgba(60,60,60,1)';
    ctx.beginPath(); ctx.arc(11, 12, 2.5, Math.PI, 0); ctx.fill();
    ctx.beginPath(); ctx.arc(21, 12, 2.5, Math.PI, 0); ctx.fill();
    ctx.fillStyle = 'rgba(100,100,100,0.7)';
    ctx.fillRect(7, 9, 9, 2);
    ctx.fillRect(17, 9, 9, 2);
  },
];

function makeEyes() {
  ensure(path.join(BASE, 'eyes'));
  eyeDefs.forEach((draw, i) => {
    const c = newCanvas();
    draw(c.getContext('2d'));
    save(path.join(BASE, 'eyes', `eyes_0${i+1}.png`), c);
  });
}

// ─── hair_back ────────────────────────────────────────────────────────────────
// 後ろ髪: 頭の背面から垂れ下がるシルエット。長さ・形を10パターン
const hairBackDefs = [
  // 01: ショート（肩まで）
  (ctx) => {
    ctx.fillStyle = 'rgba(100,100,100,1)';
    ctx.beginPath();
    ctx.moveTo(6, 6); ctx.arc(16, 8, 10, Math.PI, 0, false);
    ctx.lineTo(26, 22); ctx.lineTo(6, 22); ctx.closePath(); ctx.fill();
  },
  // 02: ミディアム（胸まで）
  (ctx) => {
    ctx.fillStyle = 'rgba(100,100,100,1)';
    ctx.beginPath();
    ctx.moveTo(5, 6); ctx.arc(16, 8, 11, Math.PI, 0, false);
    ctx.lineTo(27, 30); ctx.lineTo(5, 30); ctx.closePath(); ctx.fill();
  },
  // 03: ロング（腰まで）
  (ctx) => {
    ctx.fillStyle = 'rgba(100,100,100,1)';
    ctx.beginPath();
    ctx.moveTo(5, 6); ctx.arc(16, 8, 11, Math.PI, 0, false);
    ctx.lineTo(27, 44); ctx.quadraticCurveTo(26, 50, 16, 52);
    ctx.quadraticCurveTo(6, 50, 5, 44); ctx.closePath(); ctx.fill();
  },
  // 04: ツーサイドアップ（サイドのみ）
  (ctx) => {
    ctx.fillStyle = 'rgba(100,100,100,1)';
    // 左
    ctx.fillRect(3, 10, 7, 26);
    ctx.beginPath(); ctx.arc(6, 36, 3.5, 0, Math.PI*2); ctx.fill();
    // 右
    ctx.fillRect(22, 10, 7, 26);
    ctx.beginPath(); ctx.arc(26, 36, 3.5, 0, Math.PI*2); ctx.fill();
    // 頭頂
    ctx.beginPath(); ctx.arc(16, 8, 10, Math.PI, 0); ctx.fill();
  },
  // 05: ポニーテール
  (ctx) => {
    ctx.fillStyle = 'rgba(100,100,100,1)';
    ctx.beginPath(); ctx.arc(16, 8, 10, Math.PI, 0); ctx.fill();
    ctx.fillRect(13, 17, 6, 4); // 束ねた部分
    // テール
    ctx.beginPath();
    ctx.moveTo(13, 21); ctx.lineTo(19, 21);
    ctx.quadraticCurveTo(22, 35, 18, 50);
    ctx.quadraticCurveTo(16, 55, 14, 50);
    ctx.quadraticCurveTo(10, 35, 13, 21);
    ctx.fill();
  },
  // 06: ウェーブロング
  (ctx) => {
    ctx.fillStyle = 'rgba(100,100,100,1)';
    ctx.beginPath();
    ctx.moveTo(5, 6); ctx.arc(16, 8, 11, Math.PI, 0, false);
    ctx.lineTo(27, 28);
    ctx.quadraticCurveTo(30, 33, 27, 38);
    ctx.quadraticCurveTo(24, 43, 27, 48);
    ctx.lineTo(5, 48);
    ctx.quadraticCurveTo(8, 43, 5, 38);
    ctx.quadraticCurveTo(2, 33, 5, 28);
    ctx.closePath(); ctx.fill();
  },
  // 07: ツインテール
  (ctx) => {
    ctx.fillStyle = 'rgba(100,100,100,1)';
    ctx.beginPath(); ctx.arc(16, 8, 10, Math.PI, 0); ctx.fill();
    // 左テール
    ctx.beginPath();
    ctx.moveTo(5, 18); ctx.lineTo(12, 18);
    ctx.quadraticCurveTo(8, 34, 5, 48);
    ctx.quadraticCurveTo(2, 34, 5, 18);
    ctx.fill();
    // 右テール
    ctx.beginPath();
    ctx.moveTo(20, 18); ctx.lineTo(27, 18);
    ctx.quadraticCurveTo(30, 34, 27, 48);
    ctx.quadraticCurveTo(24, 34, 20, 18);
    ctx.fill();
  },
  // 08: ボブ（外ハネ）
  (ctx) => {
    ctx.fillStyle = 'rgba(100,100,100,1)';
    ctx.beginPath();
    ctx.moveTo(5, 6); ctx.arc(16, 8, 11, Math.PI, 0, false);
    ctx.lineTo(29, 26); ctx.quadraticCurveTo(31, 30, 27, 28);
    ctx.lineTo(24, 20);
    ctx.lineTo(8, 20);
    ctx.lineTo(5, 28); ctx.quadraticCurveTo(1, 30, 3, 26);
    ctx.closePath(); ctx.fill();
  },
  // 09: アフロ風
  (ctx) => {
    ctx.fillStyle = 'rgba(100,100,100,1)';
    ctx.beginPath(); ctx.arc(16, 10, 14, Math.PI * 0.9, Math.PI * 0.1); ctx.fill();
    ctx.fillRect(4, 10, 24, 12);
  },
  // 10: ストレートロング（背中一直線）
  (ctx) => {
    ctx.fillStyle = 'rgba(100,100,100,1)';
    ctx.beginPath();
    ctx.moveTo(6, 6); ctx.arc(16, 8, 10, Math.PI, 0, false);
    ctx.lineTo(26, 58); ctx.lineTo(6, 58); ctx.closePath(); ctx.fill();
  },
];

function makeHairBack() {
  ensure(path.join(BASE, 'hair'));
  hairBackDefs.forEach((draw, i) => {
    const n = String(i+1).padStart(2,'0');
    const c = newCanvas();
    draw(c.getContext('2d'));
    save(path.join(BASE, 'hair', `hair_back_${n}.png`), c);
  });
}

// ─── hair_front ───────────────────────────────────────────────────────────────
// 前髪: 額から垂れる前髪（hair_backと対応したデザイン）
const hairFrontDefs = [
  // 01: ショート前髪（オールバック気味）
  (ctx) => {
    ctx.fillStyle = 'rgba(80,80,80,1)';
    ctx.beginPath();
    ctx.moveTo(6, 6); ctx.arc(16, 8, 10, Math.PI, 0, false);
    ctx.lineTo(26, 13); ctx.quadraticCurveTo(16, 16, 6, 13); ctx.closePath(); ctx.fill();
  },
  // 02: センター分け
  (ctx) => {
    ctx.fillStyle = 'rgba(80,80,80,1)';
    // 左
    ctx.beginPath();
    ctx.moveTo(6, 6); ctx.arc(11, 7, 5, Math.PI*1.1, 0); ctx.lineTo(11,16); ctx.lineTo(6,13); ctx.closePath(); ctx.fill();
    // 右
    ctx.beginPath();
    ctx.moveTo(26, 6); ctx.arc(21, 7, 5, 0, Math.PI*-0.1, true); ctx.lineTo(21,16); ctx.lineTo(26,13); ctx.closePath(); ctx.fill();
    // 頭頂
    ctx.beginPath(); ctx.arc(16, 4, 10, Math.PI*1.1, Math.PI*-0.1, false); ctx.fill();
  },
  // 03: 斜め前髪（右流し）
  (ctx) => {
    ctx.fillStyle = 'rgba(80,80,80,1)';
    ctx.beginPath(); ctx.arc(16, 8, 10, Math.PI, 0); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(6, 14); ctx.lineTo(26, 10); ctx.lineTo(26, 16); ctx.lineTo(6, 18); ctx.closePath(); ctx.fill();
  },
  // 04: たれ前髪（長め）
  (ctx) => {
    ctx.fillStyle = 'rgba(80,80,80,1)';
    ctx.beginPath(); ctx.arc(16, 8, 10, Math.PI, 0); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(7, 14); ctx.lineTo(11, 20); ctx.lineTo(14, 14);
    ctx.lineTo(18, 22); ctx.lineTo(21, 14);
    ctx.lineTo(25, 14); ctx.lineTo(7, 14); ctx.closePath(); ctx.fill();
  },
  // 05: ぱっつん前髪
  (ctx) => {
    ctx.fillStyle = 'rgba(80,80,80,1)';
    ctx.beginPath(); ctx.arc(16, 8, 10, Math.PI, 0); ctx.fill();
    ctx.fillRect(6, 12, 20, 4);
  },
  // 06: ウェーブ前髪
  (ctx) => {
    ctx.fillStyle = 'rgba(80,80,80,1)';
    ctx.beginPath(); ctx.arc(16, 8, 10, Math.PI, 0); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(6, 13);
    ctx.quadraticCurveTo(9, 19, 12, 14);
    ctx.quadraticCurveTo(15, 19, 18, 14);
    ctx.quadraticCurveTo(21, 19, 24, 14);
    ctx.lineTo(26, 13); ctx.lineTo(6, 13); ctx.closePath(); ctx.fill();
  },
  // 07: ツインテール用前髪（センター部分のみ）
  (ctx) => {
    ctx.fillStyle = 'rgba(80,80,80,1)';
    ctx.beginPath(); ctx.arc(16, 8, 10, Math.PI, 0); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(10, 14); ctx.lineTo(22, 14); ctx.lineTo(20, 20); ctx.lineTo(16, 18); ctx.lineTo(12, 20); ctx.closePath(); ctx.fill();
  },
  // 08: ボブ用前髪（外ハネに対応）
  (ctx) => {
    ctx.fillStyle = 'rgba(80,80,80,1)';
    ctx.beginPath(); ctx.arc(16, 8, 10, Math.PI, 0); ctx.fill();
    ctx.fillRect(5, 13, 22, 5);
    ctx.clearRect(5, 16, 3, 2); ctx.clearRect(24, 16, 3, 2);
  },
  // 09: アフロ用前髪（ふわふわ）
  (ctx) => {
    ctx.fillStyle = 'rgba(80,80,80,1)';
    ctx.beginPath(); ctx.arc(16, 8, 10, Math.PI, 0); ctx.fill();
    ctx.beginPath(); ctx.arc(10, 14, 4, Math.PI, 0); ctx.fill();
    ctx.beginPath(); ctx.arc(16, 14, 4, Math.PI, 0); ctx.fill();
    ctx.beginPath(); ctx.arc(22, 14, 4, Math.PI, 0); ctx.fill();
  },
  // 10: ストレート用前髪（シンプルな直線）
  (ctx) => {
    ctx.fillStyle = 'rgba(80,80,80,1)';
    ctx.beginPath(); ctx.arc(16, 8, 10, Math.PI, 0); ctx.fill();
    ctx.fillRect(6, 13, 20, 3);
  },
];

function makeHairFront() {
  hairFrontDefs.forEach((draw, i) => {
    const n = String(i+1).padStart(2,'0');
    const c = newCanvas();
    draw(c.getContext('2d'));
    save(path.join(BASE, 'hair', `hair_front_${n}.png`), c);
  });
}

// ─── top ──────────────────────────────────────────────────────────────────────
const topDefs = [
  // 01: Tシャツ
  (ctx) => {
    ctx.fillStyle = 'rgba(120,120,120,1)';
    ctx.fillRect(8, 19, 16, 18); // 胴体
    ctx.fillRect(2, 19, 6, 10);  // 左袖
    ctx.fillRect(24, 19, 6, 10); // 右袖
    // 首元V
    ctx.fillStyle = 'rgba(0,0,0,0)';
    ctx.clearRect(14, 19, 4, 4);
  },
  // 02: タンクトップ
  (ctx) => {
    ctx.fillStyle = 'rgba(120,120,120,1)';
    ctx.fillRect(9, 19, 14, 18);
    ctx.fillStyle = 'rgba(140,140,140,1)';
    ctx.fillRect(9, 19, 2, 12); // 左肩紐
    ctx.fillRect(21, 19, 2, 12); // 右肩紐
  },
  // 03: ジャケット
  (ctx) => {
    ctx.fillStyle = 'rgba(90,90,90,1)';
    ctx.fillRect(7, 19, 18, 18); // 胴体
    ctx.fillRect(1, 19, 7, 14);  // 左袖
    ctx.fillRect(24, 19, 7, 14); // 右袖
    ctx.fillStyle = 'rgba(130,130,130,1)';
    ctx.fillRect(14, 19, 4, 18); // 前ボタン列
    ctx.fillStyle = 'rgba(200,200,200,1)';
    [23, 28, 33].forEach(y => { ctx.beginPath(); ctx.arc(16, y, 1, 0, Math.PI*2); ctx.fill(); });
  },
  // 04: セーター
  (ctx) => {
    ctx.fillStyle = 'rgba(110,110,110,1)';
    ctx.fillRect(6, 19, 20, 18);
    ctx.fillRect(1, 19, 6, 16);
    ctx.fillRect(25, 19, 6, 16);
    // 首リブ
    ctx.fillStyle = 'rgba(90,90,90,1)';
    ctx.fillRect(11, 19, 10, 4);
    // 横縞テクスチャ
    ctx.fillStyle = 'rgba(130,130,130,0.5)';
    [24, 28, 32].forEach(y => ctx.fillRect(6, y, 20, 1));
  },
  // 05: 制服
  (ctx) => {
    ctx.fillStyle = 'rgba(100,100,100,1)';
    ctx.fillRect(7, 19, 18, 18);
    ctx.fillRect(1, 19, 7, 14);
    ctx.fillRect(24, 19, 7, 14);
    // 白シャツ部分
    ctx.fillStyle = 'rgba(180,180,180,1)';
    ctx.fillRect(13, 19, 6, 18);
    // えり
    ctx.fillStyle = 'rgba(160,160,160,1)';
    ctx.beginPath(); ctx.moveTo(13,19); ctx.lineTo(10,24); ctx.lineTo(13,26); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(19,19); ctx.lineTo(22,24); ctx.lineTo(19,26); ctx.closePath(); ctx.fill();
  },
];

function makeTops() {
  ensure(path.join(BASE, 'top'));
  topDefs.forEach((draw, i) => {
    const n = String(i+1).padStart(2,'0');
    const c = newCanvas();
    draw(c.getContext('2d'));
    save(path.join(BASE, 'top', `top_${n}.png`), c);
  });
}

// ─── bottom ───────────────────────────────────────────────────────────────────
const bottomDefs = [
  // 01: ジーンズ（ストレート）
  (ctx) => {
    ctx.fillStyle = 'rgba(100,100,100,1)';
    ctx.fillRect(8, 37, 7, 22);  // 左脚
    ctx.fillRect(17, 37, 7, 22); // 右脚
    ctx.fillRect(8, 37, 16, 6);  // ウエスト
    ctx.fillStyle = 'rgba(130,130,130,1)';
    ctx.fillRect(15, 37, 2, 22); // 股間ライン
    // ポケット
    ctx.strokeStyle = 'rgba(80,80,80,1)'; ctx.lineWidth = 0.8;
    ctx.strokeRect(9, 40, 4, 4);
    ctx.strokeRect(19, 40, 4, 4);
  },
  // 02: スカート（フレア）
  (ctx) => {
    ctx.fillStyle = 'rgba(110,110,110,1)';
    ctx.beginPath();
    ctx.moveTo(9, 37); ctx.lineTo(23, 37);
    ctx.lineTo(28, 58); ctx.lineTo(4, 58);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(130,130,130,1)';
    ctx.fillRect(9, 37, 14, 4); // ウエスト
  },
  // 03: ショートパンツ
  (ctx) => {
    ctx.fillStyle = 'rgba(100,100,100,1)';
    ctx.fillRect(8, 37, 16, 10);  // ウエスト+ショーツ
    ctx.fillRect(8, 37, 6, 10);
    ctx.fillRect(18, 37, 6, 10);
    // 脚の素肌（透過）
    ctx.clearRect(8, 47, 6, 15);
    ctx.clearRect(18, 47, 6, 15);
    // 素肌色の脚（薄い）
    ctx.fillStyle = 'rgba(160,160,160,0.4)';
    ctx.fillRect(9, 47, 5, 14);
    ctx.fillRect(18, 47, 5, 14);
  },
  // 04: ミニスカート
  (ctx) => {
    ctx.fillStyle = 'rgba(110,110,110,1)';
    ctx.beginPath();
    ctx.moveTo(9, 37); ctx.lineTo(23, 37);
    ctx.lineTo(25, 50); ctx.lineTo(7, 50);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(130,130,130,1)';
    ctx.fillRect(9, 37, 14, 3); // ウエスト
    // 素肌の脚
    ctx.fillStyle = 'rgba(160,160,160,0.4)';
    ctx.fillRect(9, 50, 5, 13);
    ctx.fillRect(18, 50, 5, 13);
  },
  // 05: スラックス（テーパード）
  (ctx) => {
    ctx.fillStyle = 'rgba(90,90,90,1)';
    ctx.beginPath();
    ctx.moveTo(8, 37); ctx.lineTo(16, 37); ctx.lineTo(14, 59); ctx.lineTo(9, 59); ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(16, 37); ctx.lineTo(24, 37); ctx.lineTo(23, 59); ctx.lineTo(18, 59); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(110,110,110,1)';
    ctx.fillRect(8, 37, 16, 5); // ウエスト
    // センタークリース
    ctx.fillStyle = 'rgba(70,70,70,0.5)';
    ctx.fillRect(11, 42, 1, 17);
    ctx.fillRect(20, 42, 1, 17);
  },
];

function makeBottoms() {
  ensure(path.join(BASE, 'bottom'));
  bottomDefs.forEach((draw, i) => {
    const n = String(i+1).padStart(2,'0');
    const c = newCanvas();
    draw(c.getContext('2d'));
    save(path.join(BASE, 'bottom', `bottom_${n}.png`), c);
  });
}

// ─── main ─────────────────────────────────────────────────────────────────────
console.log('=== アバターパーツPNG生成開始 ===\n');

console.log('[body]');
makeBody();

console.log('\n[eyes]');
makeEyes();

console.log('\n[hair_back]');
makeHairBack();

console.log('\n[hair_front]');
makeHairFront();

console.log('\n[top]');
makeTops();

console.log('\n[bottom]');
makeBottoms();

// ディレクトリ構造とファイル数を出力
console.log('\n=== 生成結果 ===');
function countDir(dir) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countDir(path.join(dir, entry.name));
    else if (entry.name.endsWith('.png')) n++;
  }
  return n;
}
function printTree(dir, indent = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      const sub = path.join(dir, entry.name);
      const count = countDir(sub);
      console.log(`${indent}${entry.name}/  (${count}ファイル)`);
      printTree(sub, indent + '  ');
    } else if (entry.name.endsWith('.png')) {
      console.log(`${indent}${entry.name}`);
    }
  }
}
printTree(BASE);
console.log(`\n合計生成ファイル数: ${generated}`);
