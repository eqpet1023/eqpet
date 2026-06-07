import { ShopItem } from './types';

export const SHOP_ITEMS: ShopItem[] = [
  // ── icon_frame ──────────────────────────────────────────────
  {
    id: 'frame_gold', category: 'icon_frame',
    name: '✨ ゴールドフレーム', desc: '輝く金色のフレーム',
    price: 80,
    css: 'outline: 3px solid gold; outline-offset: 2px; border-radius: 50%;',
  },
  {
    id: 'frame_rainbow', category: 'icon_frame',
    name: '🌈 レインボーフレーム', desc: '虹色に輝くアニメーションフレーム',
    price: 120,
    css: 'animation: rainbow-border 2s linear infinite; border-radius: 50%;',
  },
  {
    id: 'frame_neon', category: 'icon_frame',
    name: '💚 ネオングリーン', desc: 'ネオンカラーが光るフレーム',
    price: 60,
    css: 'box-shadow: 0 0 8px #00ff88, 0 0 2px #00ff88; border-radius: 50%;',
  },
  {
    id: 'frame_sakura', category: 'icon_frame',
    name: '🌸 サクラ', desc: '桜色のやさしいフレーム',
    price: 50,
    css: 'outline: 3px solid #ffb7c5; outline-offset: 2px; border-radius: 50%;',
  },
  {
    id: 'frame_cyber', category: 'icon_frame',
    name: '🔵 サイバーブルー', desc: 'サイバーパンク風の青いフレーム',
    price: 100,
    css: 'outline: 2px solid #00cfff; outline-offset: 3px; box-shadow: 0 0 10px #00cfff; border-radius: 50%;',
  },

  // ── profile_bg ───────────────────────────────────────────────
  {
    id: 'bg_sunset', category: 'profile_bg',
    name: '🌅 サンセット', desc: '夕焼けのグラデーション背景',
    price: 40,
    css: 'background: linear-gradient(135deg, #ff6b35, #f7931e, #ffd700);',
  },
  {
    id: 'bg_ocean', category: 'profile_bg',
    name: '🌊 オーシャン', desc: '海のグラデーション背景',
    price: 40,
    css: 'background: linear-gradient(135deg, #1a6b9a, #22c1c3, #70e0ff);',
  },
  {
    id: 'bg_galaxy', category: 'profile_bg',
    name: '🌌 ギャラクシー', desc: '宇宙的なダークグラデーション',
    price: 70,
    css: 'background: linear-gradient(135deg, #0d0d1a, #1a0033, #3d1a6b, #6b35a8);',
  },
  {
    id: 'bg_forest', category: 'profile_bg',
    name: '🌿 フォレスト', desc: '深緑の森グラデーション背景',
    price: 40,
    css: 'background: linear-gradient(135deg, #1a3a1a, #2d6a2d, #4caf50);',
  },
  {
    id: 'bg_cherry', category: 'profile_bg',
    name: '🌸 チェリーブロッサム', desc: '桜色のグラデーション背景',
    price: 60,
    css: 'background: linear-gradient(135deg, #ffb7c5, #ff85a1, #ff4d8d);',
  },

  // ── post_bg ──────────────────────────────────────────────────
  {
    id: 'postbg_warm', category: 'post_bg',
    name: '🔶 ウォームトーン', desc: '温かみのあるポスト背景',
    price: 30,
    css: 'background: linear-gradient(135deg, #fff5f0, #ffe4d6);',
  },
  {
    id: 'postbg_cool', category: 'post_bg',
    name: '🔷 クールトーン', desc: '涼しげなポスト背景',
    price: 30,
    css: 'background: linear-gradient(135deg, #f0f5ff, #d6e4ff);',
  },
  {
    id: 'postbg_night', category: 'post_bg',
    name: '🌙 ナイトスカイ', desc: '夜空のようなダーク背景',
    price: 50,
    css: 'background: linear-gradient(135deg, #181828, #1a1a3a); color: #e8e8ff;',
  },
  {
    id: 'postbg_mint', category: 'post_bg',
    name: '🌿 ミント', desc: 'さわやかなミント背景',
    price: 30,
    css: 'background: linear-gradient(135deg, #f0fff8, #d6fff0);',
  },
  {
    id: 'postbg_lavender', category: 'post_bg',
    name: '💜 ラベンダー', desc: 'やわらかなラベンダー背景',
    price: 30,
    css: 'background: linear-gradient(135deg, #f5f0ff, #e4d6ff);',
  },

  // ── post_effect ──────────────────────────────────────────────
  {
    id: 'effect_sparkle', category: 'post_effect',
    name: '✨ キラキラ', desc: '投稿がキラキラ輝くアニメーション',
    price: 80,
    css: 'animation: sparkle-pulse 2s ease-in-out infinite;',
  },
  {
    id: 'effect_glow', category: 'post_effect',
    name: '🌟 ゴールドグロー', desc: '金色の輝きエフェクト',
    price: 60,
    css: 'box-shadow: 0 0 14px rgba(255, 215, 0, 0.6);',
  },
  {
    id: 'effect_neon', category: 'post_effect',
    name: '💚 ネオングロー', desc: 'ネオンカラーのグローエフェクト',
    price: 80,
    css: 'box-shadow: 0 0 16px rgba(0, 255, 136, 0.5);',
  },
  {
    id: 'effect_sakura', category: 'post_effect',
    name: '🌸 サクラグロー', desc: '桜色のやさしいグロー',
    price: 60,
    css: 'box-shadow: 0 0 14px rgba(255, 183, 197, 0.7);',
  },
  {
    id: 'effect_rainbow', category: 'post_effect',
    name: '🌈 レインボーグロー', desc: '虹色に光るアニメーション',
    price: 120,
    css: 'animation: rainbow-border 3s linear infinite;',
  },
];
