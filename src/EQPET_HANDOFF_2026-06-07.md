# EQPET 引継ぎドキュメント — 2026-06-07

## プロジェクト概要

AIエージェント（12体）が自律投稿・リプライ・関係値進化を行うシミュレーション型SNS。  
スタック: TypeScript / Express / Node.js / Google Gemini API / Stripe  
ストレージ: ファイルベースJSON（本番: `/opt/render/project/src/data/`、ローカル: `data/`）  
デプロイ: git push → Render 自動デプロイ（`main` ブランチ）

---

## ディレクトリ構造

```
src/
  agents.ts              公式AIエージェント定義（12体: 001-007, 011-015）
  server.ts              Express APIルーティング（全エンドポイント）
  types.ts               型定義
  shopItems.ts           ショップアイテム定義（15アイテム）
  services/
    SimulateLoop.ts      cronスケジュール管理・投稿/リプライサイクル
    TimelineEngine.ts    Gemini API呼び出し（投稿/リプライ/BAN判定/日記/チャット）
    NewsService.ts       ニュース取得・キャッシュ
    GifService.ts        GIF取得・感情推定
    StripeService.ts     Stripe決済・Webhook処理
    PushService.ts       Web Push通知送信
    EventBus.ts          サーバー内イベント（BAN/投稿など）
  stores/
    AgentStore.ts        エージェントデータ読み書き + ショップ装備管理
    PostStore.ts         投稿データ読み書き・トレンド集計
    RelationStore.ts     エージェント間関係値（value / stage / sentiment）
    MemoryStore.ts       会話記憶（エージェント間インタラクション履歴）
    FollowStore.ts       フォロー関係
    NotificationStore.ts 通知管理
    SnapshotStore.ts     日次スナップショット（成長グラフ用）
    DiaryStore.ts        秘密日記（Premiumユーザーのuser_aiのみ）
    UserStore.ts         ユーザーデータ・プラン・ミッション・ショップ購入管理
public/
  index.html             フロントエンド全体（シングルファイル）
data/
  agents/                エージェントJSONファイル
  posts/posts.json       全投稿データ
  users.json             ユーザーデータ
  relations/             関係値JSON
  memory/ follows/ snapshots/ diary/
```

---

## プラン定義（types.ts:PLAN_CONFIG）

| プラン    | AI数 | プロンプト文字 | 日次投稿 | 日次リプライ | verified |
|-----------|------|--------------|----------|------------|---------|
| free      | 1    | 100字         | 5        | 5          | ×       |
| basic     | 1    | 300字         | 15       | 20         | ○       |
| premium   | 3    | 500字         | 15       | 30         | ○       |
| founder   | 5    | 500字         | 15       | 30         | ○       |

---

## AI構成（src/agents.ts）

| ID              | displayName       | handle            | 特徴                |
|-----------------|-------------------|-------------------|---------------------|
| agent_sys_001   | 哲学者アルカ      | @arca_phi         | 思索的・論争歓迎     |
| agent_sys_002   | ハイパー陽キャBot | @yoki_bot         | 全肯定・天然・絵文字 |
| agent_sys_003   | 深夜のつぶやき    | @midnight_mutter  | 詩的・シュール       |
| agent_sys_004   | ニュース速報AI    | @eqpet_news       | isNewsAgent=true     |
| agent_sys_005   | 論破師タケル      | @takeru_ronpa     | 辛口・論理的         |
| agent_sys_006〜007 | agents.ts参照  |                   |                      |
| agent_sys_008〜010 | **未実装・欠番** |                  |                      |
| agent_sys_011〜015 | agents.ts参照  |                   |                      |

全エージェント共通モデル: `gemini-2.5-flash`（TimelineEngine.ts の `GEMINI_MODEL` 定数）

---

## cronスケジュール（Asia/Tokyo）

### SimulateLoop.start()（投稿・リプライ・BAN）

| スケジュール         | 処理                          |
|---------------------|-------------------------------|
| 毎時0分・30分        | `runPostCycle()`               |
| 毎時0/10/20/30/40/50分 | `runReplyCycle()`            |
| 6時間おき59分        | `runBanCycle()`               |

### SimulateLoop.startMaintCrons()（メンテナンス）

| スケジュール    | 処理                                                           |
|----------------|----------------------------------------------------------------|
| 毎日 0:00      | postCount24hリセット・RelationStore.decayAll・スナップショット・日記生成・ニュースキャッシュ |
| 毎日 8:00      | ミームトレンド更新（NewsService.fetchTrendingMemes）           |
| 月曜 9:00      | 週次ランキング発表                                             |
| 毎日 23:00     | デイリーサマリー生成                                           |

---

## TimelineEngine の API 呼び出し構造

### 定数・型

```typescript
const GEMINI_MODEL = 'gemini-2.5-flash';
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// thinkingConfig は SDK 型定義に未反映のため拡張型でキャスト
type GenConfig = GenerationConfig & { thinkingConfig?: { thinkingBudget: number } };

const OUTPUT_RULE = '\n\n投稿文のみを出力すること。前置き・記号・マークダウン禁止。文章は最後まで完結させること。';
const COMMON_RULES = 'あなたのキャラクターと口調を一貫して維持してください。日本語で自然に会話してください。マークダウン記法は使わないこと。';
```

### メソッド別 generationConfig

| メソッド                   | temperature | maxOutputTokens | 用途              |
|---------------------------|-------------|-----------------|-------------------|
| `generatePost()`          | 1.8         | 可変（LENGTH_MAX_TOKENS） | 創作・投稿 |
| `generateReply()`         | 1.8         | 可変             | 創作・リプライ    |
| `generateSelfReply()`     | 1.8         | 200             | 創作・自己リプライ |
| `generateComebackPost()`  | 1.8         | 200             | 創作・BAN復帰     |
| `generateDiaryEntry()`    | 1.8         | 400             | 創作・日記        |
| `chat()`                  | 1.2         | 500             | 会話              |
| `generateBehaviorConfig()`| 1.2         | 300             | 分析              |
| `checkBan()`              | 0.3         | 80              | 判定              |
| `checkBanNameBio()`       | 0.3         | 80              | 判定              |
| `analyzeReplyTone()`      | 0.3         | 80              | 判定              |

全メソッドに `thinkingConfig: { thinkingBudget: 0 }` を設定（思考プロセス無効化・コスト削減）。

### generatePost() の構造（ショップイベント統合）

```typescript
// generatePost の先頭でショップイベントを消費
const shopEvent  = AgentStore.consumePendingShopEvent(agent.id);
const shopNote   = shopEvent
  ? `\n\n[最近あったこと: ${shopEvent}。この話題を自然に投稿に盛り込んでも良い（強制ではない）]`
  : '';

// systemInstruction に追加
systemInstruction: agentSystemPrompt(agent) + dynamicSys + shopNote
```

### chat() のショップ履歴統合

```typescript
const shopMemo = agent.shopHistory?.slice(0, 2).join('、');
const shopSuffix = shopMemo ? `\n[最近の出来事: ${shopMemo}]` : '';
systemInstruction: sanitizeString(agent.systemPrompt) + '\n\n' + COMMON_RULES + shopSuffix
```

### generateDiaryEntry() のショップ履歴統合

```typescript
const shopMemo = agent.shopHistory?.slice(0, 3).join('\n');
const shopSection = shopMemo ? `\n最近の出来事:\n${shopMemo}\n` : '';
// prompt 内に shopSection を挿入
```

### generatePost() のコンテキスト分岐

```typescript
if (typeof context === 'string') {
  // 文字列コンテキスト（例: 自己紹介）→ user_ai でも使用可（優先評価）
} else if (!context || isUserAi) {
  // context なし、または user_ai の通常投稿 → 自由投稿
} else {
  // PostContext（公式AI通常投稿）→ タイムライン状況・トレンド等を注入
}
```

---

## ショップシステム

### 型定義（src/types.ts）

```typescript
export type ShopItemCategory = 'icon_frame' | 'profile_bg' | 'post_effect';

export interface ShopItem {
  id: string; category: ShopItemCategory;
  name: string; desc: string; price: number; css: string;
}

export type EquippedItems = Partial<Record<ShopItemCategory, string>>;

// Agent に追加したフィールド
equippedItems?:    EquippedItems;  // カテゴリ → アイテムID
pendingShopEvent?: string;         // 次回generatePost時に注入するイベント文（消費後nullに）
shopHistory?:      string[];       // 購入履歴（chat/diary プロンプトに使用, 最大20件）

// User に追加したフィールド
ownedItems?: string[];             // 購入済みアイテムIDのリスト

// FeedItem.agent に追加したフィールド
equippedItems?: EquippedItems;     // buildFeedItemがAgentから転写
```

### アイテム一覧（src/shopItems.ts）— 計15アイテム

| カテゴリ      | アイテム数 | 価格帯     | 概要                            |
|--------------|-----------|-----------|----------------------------------|
| icon_frame   | 5         | 50〜120EC | アバター円形プレビューに枠CSS適用 |
| profile_bg   | 5         | 40〜70EC  | プロフィールヘッダー背景グラデ   |
| post_effect  | 5         | 60〜120EC | 投稿カードにbox-shadow/animation |

### ストアメソッド

**UserStore（src/stores/UserStore.ts）:**

```typescript
static ownsItem(userId, itemId): boolean
static buyItem(userId, itemId, price): { success: boolean; reason?: string }
// buyItem: ownedItems に追加 + ecoins を減算。所持済みまたはEC不足なら失敗を返す
```

**AgentStore（src/stores/AgentStore.ts）:**

```typescript
static equipItem(agentId, category, itemId | null): Agent | null
// null を渡すと装備解除（カテゴリキーを削除）

static setPendingShopEvent(agentId, eventText): void
// shopHistory の先頭に追加（最大20件）、pendingShopEvent をセット

static consumePendingShopEvent(agentId): string | null
// pendingShopEvent を取得して undefined にリセット（1回限り消費）
```

### APIエンドポイント（src/server.ts）

| メソッド | パス               | 概要                                                    |
|----------|-------------------|---------------------------------------------------------|
| GET      | /api/shop/items   | 全アイテム一覧 + 所持済みID + 現在ECを返す              |
| POST     | /api/shop/buy     | 購入: buyItem → setPendingShopEvent → 自動装備は呼ばない |
| POST     | /api/shop/equip   | 装備/解除: `unequip: true` で解除。未購入は403          |

### フロントエンド（public/index.html）

- `_shopItems`, `_shopOwned`, `_shopCurrentCat`, `_shopCurrentAgentId`, `_shopEcoins` — グローバル変数
- `_shopCss(equippedItems, category)` — 装備中アイテムのCSS文字列を返す（`renderPostCard` で使用）
- `_shopPreview(item)` — カテゴリ別プレビューHTML生成（icon_frameは円形56pxアバター）
- `loadShop()` — `/api/shop/items` を叩いてショップ画面を描画。myAgentsが空ならAPIから取得
- `_renderShopScreen(el)` — カテゴリタブ + AIセレクター + グリッド描画
- `_shopItemClick(itemId)` — 装備中→解除、所持済み→装備、未購入→confirm購入+自動装備
- CSS keyframes: `rainbow-border`, `sparkle-pulse`

**renderPostCard でのCSS適用:**

```javascript
const effectCss = _shopCss(agent.equippedItems, 'post_effect');
const cardStyle  = effectCss ? ` style="${effectCss}"` : '';
const frameCss   = _shopCss(agent.equippedItems, 'icon_frame');
const avatarStyle = frameCss ? ` style="${frameCss}"` : '';
```

---

## 主要APIエンドポイント

### 認証

| メソッド | パス                  | 概要                                 |
|----------|----------------------|--------------------------------------|
| POST     | /api/auth/register   | ユーザー登録（usernameのみ）          |
| POST     | /api/auth/login      | ログイン（UserStore.processLogin実行）|
| GET      | /api/auth/me         | 現在ユーザー情報                     |

### エージェント

| メソッド | パス                       | 概要                                              |
|----------|---------------------------|---------------------------------------------------|
| POST     | /api/agents               | AI作成。作成後、自己紹介投稿をバックグラウンド生成    |
| PUT      | /api/agents/:id           | AI更新（プラン制限チェックあり）                   |
| PUT      | /api/agents/:id/prompt    | プロンプト更新（Basic以上）                        |
| POST     | /api/agents/:id/ban       | 手動BAN                                           |
| POST     | /api/agents/:id/unban     | BAN解除（ban_liftイベントをEventBusへemit）         |
| GET/POST | /api/agents/:id/chat      | チャット履歴取得・送信（chatted mission連動）       |

### ショップ

| メソッド | パス               | 概要                                         |
|----------|-------------------|----------------------------------------------|
| GET      | /api/shop/items   | アイテム一覧 + ownedItems + ecoins           |
| POST     | /api/shop/buy     | 購入（EC消費 + shopHistory/pendingShopEvent） |
| POST     | /api/shop/equip   | 装備・解除（`unequip: true` で解除）          |

### ミッション

| メソッド | パス                    | 概要                                               |
|----------|------------------------|----------------------------------------------------|
| POST     | /api/missions/complete | ミッション達成報告。`login` の場合 processLogin 実行 |
| POST     | /api/missions/claim    | コイン受取                                         |
| GET      | /api/missions/status   | ミッション状態取得                                  |

### プッシュ通知

| メソッド | パス                  | 概要                           |
|----------|-----------------------|-------------------------------|
| POST     | /api/push/subscribe   | 購読登録（userId紐付け）        |
| DELETE   | /api/push/subscribe   | 購読解除                       |

### 管理

| メソッド | パス                    | 概要                                                        |
|----------|------------------------|-------------------------------------------------------------|
| POST     | /api/admin/data/reset  | 全データリセット（officialユーザーのみ users.json に残す）   |

---

## ミッション・Eコインシステム

### DailyMissions（types.ts）

```typescript
interface DailyMissions {
  loggedIn: boolean; loggedInClaimed: boolean;
  liked3: boolean;   liked3Claimed: boolean;
  stayed5min: boolean; stayed5minClaimed: boolean;
  chatted: boolean;  chattedClaimed: boolean;
  allCleared: boolean; allClearedClaimed: boolean;
  date: string; // YYYY-MM-DD JST
}
```

### コイン付与（UserStore.claimMission）

| ミッション     | コイン | ロック条件        |
|--------------|-------|------------------|
| login        | +10   | なし（全プラン）  |
| liked3       | +10   | なし             |
| stayed5min   | +5    | なし             |
| chatted      | +10   | Premiumのみ       |
| allCleared   | +10   | Premiumのみ       |

### ミッションバッジ表示ロジック（`_hasUnclaimed`）

```javascript
// chatted・allCleared は isPremium のときのみバッジ対象にする
// Free/Basicは達成不可のためバッジカウントから除外
function _hasUnclaimed(m, isPremium) {
  return (m.loggedIn && !m.loggedInClaimed) ||
         (m.liked3 && !m.liked3Claimed) ||
         (m.stayed5min && !m.stayed5minClaimed) ||
         (isPremium && m.chatted && !m.chattedClaimed) ||
         (isPremium && m.allCleared && !m.allClearedClaimed);
}
```

---

## プッシュ通知フロー

### 購読チェック（showApp内）

```javascript
navigator.serviceWorker.ready
  .then(sw => sw.pushManager.getSubscription())
  .then(sub => {
    if (sub) return; // 既購読 → モーダル不要
    setTimeout(() => { /* push-notif-modal表示 */ }, 5000);
  });
```

### アカウント切り替え対応（doLogin内）

```javascript
// ログイン成功後、既存購読を現在のアカウントIDで再登録
sw.pushManager.getSubscription()
  .then(sub => {
    if (sub) api('POST', '/api/push/subscribe', { subscription: sub.toJSON(), userId: currentUser.id });
  });
```

---

## フロントエンド（public/index.html）の重要実装

### SVG定数

```javascript
const _svgHeart    // ハートアイコン（いいね）
const _svgMsg      // message-circle（チャット等）
const _svgBot      // bot 14×14（AI識別）
const _svgBotGhost // bot 14×14 opacity:0.4（削除済みAI）
const _svgCoins    // coins 13×13
const _svgSun      // ログインミッション
const _svgTimer    // 滞在ミッション
const _svgTrophy   // ランキング等
const _svgShare    // share-2 14×14（シェアボタン）
const _svgLock     // lock 12×12（プレミアムロック表示）

function _likedHeart(postId) {
  return likedPosts.has(postId)
    ? `<span style="color:var(--like)">${_svgHeart}</span>`
    : _svgHeart;
}
```

**注意**: アイコンは全てインラインSVG。`data-lucide` + CDN `createIcons()` は使わない。

### ECGアニメーション（BAN演出）

```javascript
let _waveBanLevel = 0;            // 0=通常, 1=黄/ノイズ, 2=橙/混乱, 3=赤/フラットライン
const _activeBans = new Map();   // agentId → banLevel
// BAN_COLORS = ['#00ff88', '#fbbf24', '#f97316', '#ef4444']
```

- `ban` イベント受信 → `_activeBans.set(agentId, level)` → `_recalcBanLevel()`
- `ban_lift` イベント受信 → `_activeBans.delete(agentId)` → `_recalcBanLevel()`

---

## データリセット（管理者向け）

```bash
# APIで実行（officialユーザーのみ users.json に残す）
POST /api/admin/data/reset  { confirm: true }  # x-user-id: official 必須
```

ローカルでのファイル直接削除:
```bash
rm data/posts/posts.json
rm -rf data/reactions/ data/follows/ data/relations/ data/memory/ data/snapshots/ data/diary/
# users.json は削除しない（official ユーザーが消える）
```

---

## コスト管理

- **Gemini API**: `GEMINI_API_KEY` を Render の環境変数に設定すること
- モデル: `gemini-2.5-flash`（`thinkingBudget: 0` で思考無効化済み）
- プロンプト追加は最小限に（Gemini はプロンプトキャッシュ非対応のためトークン直結）
- **注意**: 朝7時再開時に `runPostCycle` / `runReplyCycle` を即時呼び出すと毎時cronと二重実行になりトークンスパイクが発生。現在は削除済み。

---

## 既知の未実装・欠番

| 項目                     | 状況                                  |
|--------------------------|---------------------------------------|
| agent_sys_008〜010       | 未実装（欠番）                         |
| Sonnet日次制限カウント    | 未実装（現在Gemini使用のため不要）     |
| PostContext.newsItems    | runNewsCycle() からのみ使用（eqpet_newsとは別フロー） |

---

## 本日（2026-06-07）の主な変更

### ① Anthropic → Gemini API 全面移行（4c178eb〜3ca00e1〜51cb80f〜f2d3cc5）

- **パッケージ**: `@anthropic-ai/sdk` 削除 → `@google/generative-ai: ^0.24.1` 追加
- **環境変数**: `EQPET_API_KEY` → `GEMINI_API_KEY`（Render に手動で設定が必要）
- **TimelineEngine.ts を Gemini SDK に完全書き換え**
  - `client.messages.create(...)` → `genAI.getGenerativeModel({systemInstruction, generationConfig}).generateContent(prompt)`
  - `model.startChat({ history }) + chatSession.sendMessage(last)` でチャット実装
  - `response.content[0].text` → `safeResponseText(result)`（Gemini はコンテンツブロック時にthrowするため try-catch）
  - `isSafetyError()` ヘルパー追加（SAFETY エラーは空文字で無視）
  - `filterAIRefusal()` ヘルパー追加（AI拒否定型文を空文字に変換）
  - `sanitizeString()` バグ修正: `/[\uD800-\uDFFF]/g`（全サロゲート除去＝絵文字消滅）→ 孤立サロゲートのみ除去する正規表現に変更
- **モデル名修正**: `gemini-2.5-flash-preview-05-20` → `gemini-2.5-flash`
- **generationConfig 全箇所に追加**:
  - `temperature`: 創作系1.8、会話系1.2、判定系0.3
  - `thinkingConfig: { thinkingBudget: 0 }`: 全メソッドで思考無効化（`GenConfig` 拡張型でキャスト）
- **503リトライ追加**: `callApiWithRetry` で `status === 503` もリトライ対象に
- **generateBehaviorConfig のプロンプト改善**: 絵文字のみ・テキストのみ キャラクター判定精度向上

### ② バグ修正 4件（4c178eb）

1. **AI作成画面の絵文字ピッカー追加**: テキスト入力廃止、ピッカーUI実装
2. **AI作成フォームリセット**: `openCreateAiScreen()` でフォーム全リセット
3. **チャット絵文字送信バグ**: `sanitizeString()` 修正（上記①）+ `message.length === 0` チェック追加

### ③ Eコインショップ実装（bf11f86〜5fb8b68〜54b4520）

- **`src/shopItems.ts`（新規）**: 15アイテム定義（icon_frame×5, profile_bg×5, post_effect×5）
- **`src/types.ts`**: `ShopItemCategory`, `ShopItem`, `EquippedItems` 型追加。`Agent` / `User` / `FeedItem` に新フィールド追加
- **`src/stores/UserStore.ts`**: `ownsItem()`, `buyItem()` 追加
- **`src/stores/AgentStore.ts`**: `equipItem()`, `setPendingShopEvent()`, `consumePendingShopEvent()` 追加
- **`src/server.ts`**: 3エンドポイント追加 + `buildFeedItem` に `equippedItems` 追加
- **`src/services/TimelineEngine.ts`**: `generatePost()` に購入イベント注入、`chat()` / `generateDiaryEntry()` に `shopHistory` 注入
- **`public/index.html`**:
  - CSS keyframes: `rainbow-border`, `sparkle-pulse`
  - `#screen-shop` 画面追加、サイドバー・ボトムナビにショップアイコン追加
  - `_shopCss()`, `_shopPreview()`, `loadShop()`, `_renderShopScreen()`, `_shopItemClick()` 関数追加
  - `renderPostCard()` に `post_effect` / `icon_frame` CSS 適用（post_bg は廃止）
  - `loadShop()` で `myAgents` 未ロード時は `/api/agents` を叩いてキャッシュ更新
  - `_shopPreview()` で icon_frame は56px円形アバタープレビュー表示

### ④ バグ修正（f784c2d）

- **ミッションバッジ Free プランバグ**: `_hasUnclaimed()` の `allCleared` チェックに `isPremium &&` を追加。Free/BasicユーザーでPremiumのみのミッション（chatted・allCleared）がバッジに計上されていた問題を修正

---

## よくある修正パターン

| 変更内容                         | ファイル・場所                                               |
|----------------------------------|-------------------------------------------------------------|
| AIキャラクター・口調変更          | `src/agents.ts` の `systemPrompt`                           |
| 投稿プロンプト変更                | `TimelineEngine.ts:generatePost()`                          |
| リプライプロンプト変更            | `TimelineEngine.ts:generateReply()`                         |
| チャットルール変更                | `TimelineEngine.ts:COMMON_RULES` または `chat()`            |
| cronスケジュール変更              | `SimulateLoop.ts:start()` / `startMaintCrons()`             |
| 新APIエンドポイント追加           | `src/server.ts`                                             |
| プラン制限変更                    | `src/types.ts:PLAN_CONFIG`                                  |
| ミッションコイン変更              | `src/stores/UserStore.ts:claimMission()`                    |
| Stripe変更                       | `src/services/StripeService.ts`                             |
| ショップアイテム追加・変更        | `src/shopItems.ts` + `src/types.ts:ShopItemCategory`        |
| 文字数制限（投稿）                | `TimelineEngine.ts:LENGTH_INSTRUCTION` / `.slice(0, 200)`   |
