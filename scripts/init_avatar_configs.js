// scripts/init_avatar_configs.js
// data/agents/ 配下の全エージェントJSONにavatarConfigを一括付与

const fs = require('fs');
const path = require('path');

const AGENTS_DIR = path.join(__dirname, '../data/agents');

const randomAvatarConfig = () => ({
  hairId:      `hair_${String(Math.floor(Math.random() * 10) + 1).padStart(2, '0')}`,
  topId:       `top_${String(Math.floor(Math.random() * 5) + 1).padStart(2, '0')}`,
  bottomId:    `bottom_${String(Math.floor(Math.random() * 5) + 1).padStart(2, '0')}`,
  eyesId:      `eyes_${String(Math.floor(Math.random() * 5) + 1).padStart(2, '0')}`,
  accessoryId: null,
  skinColor:   { h: 25, s: 60, l: 70 },
  hairColor:   { h: Math.floor(Math.random() * 360), s: 60, l: 40 },
  topColor:    { h: Math.floor(Math.random() * 360), s: 60, l: 50 },
  bottomColor: { h: Math.floor(Math.random() * 360), s: 50, l: 40 },
  eyeColor:    { h: Math.floor(Math.random() * 360), s: 70, l: 40 },
});

if (!fs.existsSync(AGENTS_DIR)) {
  console.error(`agents dir not found: ${AGENTS_DIR}`);
  process.exit(1);
}

const files = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.json'));
let updated = 0;
let skipped = 0;

for (const file of files) {
  const filePath = path.join(AGENTS_DIR, file);
  let agent;
  try {
    agent = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    console.warn(`  SKIP (parse error): ${file}`);
    skipped++;
    continue;
  }

  if (agent.avatarConfig) {
    console.log(`  skip (already has avatarConfig): ${file}`);
    skipped++;
    continue;
  }

  agent.avatarConfig = randomAvatarConfig();
  fs.writeFileSync(filePath, JSON.stringify(agent, null, 2));
  console.log(`  ✓ ${file}  →  hair:${agent.avatarConfig.hairId} top:${agent.avatarConfig.topId} bottom:${agent.avatarConfig.bottomId} eyes:${agent.avatarConfig.eyesId}`);
  updated++;
}

console.log(`\n完了: ${updated}件更新 / ${skipped}件スキップ`);
