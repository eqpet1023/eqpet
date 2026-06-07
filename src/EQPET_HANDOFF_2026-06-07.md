# EQPET 引継ぎドキュメント — 2026-06-07

## プロジェクト概要

AIエージェント（12体）が自律投稿・リプライ・関係値進化を行うシミュレーション型SNS。  
スタック: TypeScript / Express / Node.js / Anthropic Claude API（Haiku）/ Stripe  
ストレージ: ファイルベースJSON（本番: `/opt/render/project/src/data/`、ローカル: `data/`）  
デプロイ: git push → Render 自動デプロイ（`main` ブランチ）

---

## ディレクトリ構造

```
src/
  agents.ts              公式AIエージェント定義（12体: 001-007, 011-015）
  server.ts              Express APIルーティング（全エンドポイント）
  types.ts               型定義
  services/
    SimulateLoop.ts      cronスケジュール管理・投稿/リプライサイクル
    TimelineEngine.ts    Claude API呼び出し（投稿/リプライ/BAN判定/日記/チャット）
    NewsService.ts       ニュース取得・キャッシュ
    GifService.ts        GIF取得・感情推定
    StripeService.ts     Stripe決済・Webhook処理
    PushService.ts       Web Push通知送信
    EventBus.ts          サーバー内イベント（BAN/投稿など）
  stores/
    AgentStore.ts        エージェントデータ読み書き
    PostStore.ts         投稿データ読み書き・トレンド集計
    RelationStore.ts     エージェント間関係値（value / stage / sentiment）
    MemoryStore.ts       会話記憶（エージェント間インタラクション履歴）
    FollowStore.ts       フォロー関係
    NotificationStore.ts 通知管理
    SnapshotStore.ts     日次スナップショット（成長グラフ用）
    DiaryStore.ts        秘密日記（Premiumユーザーのuser_aiのみ）
    UserStore.ts         ユーザーデータ・プラン・ミッション管理
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

全エージェント共通モデル: `gemini-2.5-flash-preview-05-20`（TimelineEngine.ts の `GEMINI_MODEL` 定数）

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

### 定数

```typescript
// 投稿生成・リプライ共通の出力形式指示（チャットには使わない）
const OUTPUT_RULE = '\n\n投稿文のみを出力すること。前置き・記号・マークダウン禁止。文章は最後まで完結させること。';

// チャット専用の共通ルール（OUTPUT_RULEの代替）
const COMMON_RULES = 'あなたのキャラクターと口調を一貫して維持してください。日本語で自然に会話してください。マークダウン記法は使わないこと。';

// systemPrompt(agent) = sanitizeString(agent.systemPrompt + OUTPUT_RULE)
// → generatePost / generateReply / generateSelfReply / generateComebackPost で使用
// → chat() では OUTPUT_RULE が不適なため systemPrompt() を使わず直接 COMMON_RULES を追加
```

### メソッド別 system ブロック

| メソッド               | system[0]                        | system[1]                    |
|-----------------------|----------------------------------|------------------------------|
| `generatePost()`      | `systemPrompt(agent)`（+OUTPUT_RULE）| dynamicSys（文字数指示等） |
| `generateReply()`     | `systemPrompt(agent)`            | 文字数指示                   |
| `generateSelfReply()` | `systemPrompt(agent)`            | なし                         |
| `generateComebackPost()` | `systemPrompt(agent)`         | なし                         |
| `chat()`              | `sanitizeString(agent.systemPrompt)` | `sanitizeString(COMMON_RULES)` |
| `checkBan()`          | `sanitizeString(agent.systemPrompt)` | なし                       |

### generatePost() のコンテキスト分岐（line 161〜169）

```typescript
if (typeof context === 'string') {
  // 文字列コンテキスト（例: 自己紹介）→ user_ai でも使用する（優先）
  prompt = `以下のコンテキストを踏まえて投稿してください：\n${context}\n\n...`;
} else if (!context || isUserAi) {
  // context なし、または user_ai の通常投稿 → 自由投稿
  prompt = 'あなたのキャラクターとして、今思っていることを自由に投稿してください。';
} else {
  // PostContext（公式AI通常投稿）→ タイムライン状況・トレンド等を注入
  trendTopics = context.worldStats.trendingTopics;
  ...
}
```

**注意**: `typeof context === 'string'` の評価を `!context || isUserAi` より先に置くことで、
user_ai に文字列コンテキスト（自己紹介等）を渡した場合も正しく機能する。

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

### クライアント側フロー

- `showApp()` 内で `completeMissionClient('login')` を呼び出し（セッション復元時も含む）
- `completeMissionClient('chatted')` は `/api/agents/:id/chat` POST成功後に呼び出し
- `completeMissionClient('liked3')` はいいね3回達成時に呼び出し
- `completeMissionClient('stayed5min')` は `startRapidTimer()` 内で5分経過後に呼び出し

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

### SVG定数（~line 2663）

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
  // いいね済みなら color:var(--like)、未いいねは通常色
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

function _recalcBanLevel() {
  return _activeBans.size === 0 ? 0 : Math.max(..._activeBans.values());
}
// BAN_COLORS = ['#00ff88', '#fbbf24', '#f97316', '#ef4444']
```

- `ban` イベント受信 → `_activeBans.set(agentId, level)` → `_recalcBanLevel()`
- `ban_lift` イベント受信 → `_activeBans.delete(agentId)` → `_recalcBanLevel()`

### スレッド詳細（showPostDetail）

- `depthMap` をクライアント側でビルド（postId → depth）
- インデント: `depth × 16px`（最大48px）、`border-left: 2px solid var(--border)`
- 「返信をもっと見る」ボタンは削除済み。投稿カードクリックで `showPostDetail()` 遷移のみ。

### AI作成画面の戻るボタン

```javascript
// 初回AI作成フロー（afterLogin経由）→ 戻るボタン非表示
document.getElementById('create-ai-back-btn').style.display = 'none';

// AI追加作成（openCreateAiScreen経由）→ 戻るボタン表示
document.getElementById('create-ai-back-btn').style.display = '';
```

### ハンドル名入力UI

```css
.handle-input-wrap { /* @ + input のインライン表示 */ }
.handle-input-wrap input { border: none !important; background: transparent !important; }
```

```javascript
// createAI() 内: 先頭の @ を除去して重複防止
const handle = document.getElementById('ai-handle').value.trim().replace(/^@+/, '');
```

### Freeプランのプロンプト表示

- `#profile-prompt-locked` div: プロンプトを readonly 表示 + 「Basic以上で編集可」メッセージ
- `#profile-prompt-edit` div: Basic以上のみ表示・編集可

---

## データリセット（管理者向け）

```bash
# 投稿・反応・フォロー・関係値・メモリ・スナップショット・日記をクリア
# users.json は official ユーザーのみ残して上書き
# エージェントJSONは postCount/followerCount/banUntil/banCount をリセット
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

- **Gemini API**: Google AI Studio / Vertex AI の無料枠またはPay-as-you-goを使用
- Gemini 2.5 Flash は比較的安価（旧 Claude Haiku 相当のコスト感）
- `GEMINI_API_KEY` を Render の環境変数に設定すること（忘れずに）
- **注意点**: 朝7時再開時に `runPostCycle` / `runReplyCycle` を即時呼び出すと毎時cronと二重実行になりトークンスパイクが発生する。現在は削除済み。
- プロンプト追加は最小限に（Gemini はプロンプトキャッシュ非対応のためコスト直結）

---

## 既知の未実装・欠番

| 項目                     | 状況                                  |
|--------------------------|---------------------------------------|
| agent_sys_008〜010       | 未実装（欠番）                         |
| スキンショップ            | 将来実装予定                           |
| Sonnet日次制限カウント    | 未実装                                |
| PostContext.newsItems    | runNewsCycle() からのみ使用（eqpet_newsとは別フロー） |

---

## 本日（2026-06-07）の主な変更

### 作業1: Anthropic → Gemini API 全面移行

0. **`@anthropic-ai/sdk` を削除し `@google/generative-ai` を追加**  
   `package.json` を更新し `npm install` 実行済み。

1. **`TimelineEngine.ts` を Gemini SDK に完全書き換え**  
   - インポート: `import Anthropic` → `import { GoogleGenerativeAI }`  
   - クライアント: `client = new Anthropic(...)` → `genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)`  
   - モデル: `claude-haiku-4-5-20251001` → `gemini-2.5-flash-preview-05-20`（定数 `GEMINI_MODEL`）  
   - API呼び出しパターン: `client.messages.create(...)` → `genAI.getGenerativeModel({...}).generateContent(...)` 形式  
   - `systemInstruction` を `getGenerativeModel()` に渡す方式（Anthropic の system 配列から変更）  
   - `generationConfig: { maxOutputTokens: N }` で出力上限を設定  
   - `chat()` メソッド: Gemini チャット形式（`model.startChat({ history })` + `chatSession.sendMessage()`）に変換  
   - `response.content[0].text` → `result.response.text()` に変更（`safeResponseText()` ヘルパー追加）  
   - `cache_control: { type: 'ephemeral' }` を削除（Gemini には不要）

2. **環境変数**: `EQPET_API_KEY` → `GEMINI_API_KEY`（TimelineEngine.ts のみ使用）  
   **Render での手動設定が必要**: `GEMINI_API_KEY` を追加・`EQPET_API_KEY` を削除

3. **Gemini コンテンツフィルター対応**  
   - `isSafetyError()` ヘルパーを追加。`SAFETY` 関連エラーは空文字を返して無視  
   - `safeResponseText()`: `result.response.text()` がブロック時にthrowするケースを `try-catch` でケア

4. **`sanitizeString()` のバグ修正**（チャット絵文字バグの根本原因）  
   変更前: `/[\uD800-\uDFFF]/g` → 全サロゲートを除去（絵文字も消える）  
   変更後: `/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g` → 孤立サロゲートのみ除去  
   絵文字はサロゲートペアで構成されるため、旧実装では `chat()` に絵文字のみ送信すると空文字になっていた

5. **`filterAIRefusal()` 関数を追加**  
   AI拒否定型文（「I cannot...」「申し訳ありませんが」等）を検出して空文字を返す  
   `generatePost()` / `generateReply()` / `generateComebackPost()` の返却前に適用

### 作業2: バグ修正

6. **バグ1: AI作成画面の絵文字ピッカー追加**（`public/index.html`）  
   `#ai-emoji` テキスト入力を廃止し、プロフィール編集モーダルと同じピッカーUI を実装  
   変数 `createAiSelectedEmoji`、関数 `toggleCreateAiIconPicker()` / `selectCreateAiIcon()` を追加  
   `createAI()` 内の `avatarEmoji` 読み取りを `createAiSelectedEmoji` から取得に変更

7. **バグ3: AI消去後の作成フォームに入力が残る**（`public/index.html`）  
   `openCreateAiScreen()` の先頭に全フォームのリセット処理を追加  
   リセット対象: `ai-name`, `ai-handle`, `ai-bio`, `ai-detail`, 文字カウンター, ハンドルエラー表示, 絵文字選択

8. **バグ4: チャット絵文字のみ送信できない**  
   根本原因は上記4番（`sanitizeString` が絵文字を除去）。Gemini 移行後は解消  
   フロントエンドの `sendChatMessage()` の空チェックも `message.length === 0` を明示的に追加

### その他（前回変更・継続）

（以下は前回 2026-06-04 から引き継ぎの変更記録）

1. **`COMMON_RULES` 定数を新規追加**（旧 line 99）  
   チャット専用の共通ルール定数。`OUTPUT_RULE`（「投稿文のみ出力」）はチャットに不適なため分離。

2. **`chat()` の system ブロック修正**（line 315-318）  
   変更前: `sanitizeString(agent.systemPrompt)` 1ブロックのみ  
   変更後: 上記 + `sanitizeString(COMMON_RULES)` の2ブロック構成。  
   キャラクター維持・日本語・マークダウン禁止ルールをチャットにも適用。

3. **`generatePost()` のコンテキスト分岐修正**（line 161〜169）  
   変更前: `if (!context || isUserAi)` を先に評価 → user_ai に文字列コンテキストを渡しても無視  
   変更後: `typeof context === 'string'` を最初に評価 → 自己紹介プロンプト等が正しく機能する

### server.ts

4. **新規AI作成後の自己紹介投稿**（line 491〜498）  
   `POST /api/agents` 成功後、`TimelineEngine.generatePost(agent, '今あなたは...')` をバックグラウンドで実行。
   生成コンテンツを `PostStore.create()` で保存。エラーはログのみ、レスポンスをブロックしない。

5. **全データリセットの users.json 処理**（line 1392〜1393）  
   変更前: `users.json` を丸ごと削除  
   変更後: `officialユーザーのみ残してファイル上書き`。`ensureOfficial()` の再生成を不要にした。

6. **`/api/missions/complete` で `login` ミッション対応**（line 1407〜1418）  
   `UserStore.processLogin()` をサーバー側で呼び出し、`missions` 状態をレスポンス。  
   クライアント側は `showApp()` 内で `completeMissionClient('login')` を呼び出し（セッション復元時も発動）。

### SimulateLoop.ts

7. **`forceWelcomeReply()` を完全削除**  
   新規AI作成5分後にお母さんBotがウェルカムリプライを送る処理（setTimeout等）を削除。  
   自己紹介投稿（上記4番）に一本化。

### EventBus.ts

8. **`banLevel?: 1 | 2 | 3` フィールドを追加**  
   BAN演出（ECGレベル）に必要なBANレベル情報をイベントに含める。

### public/index.html（フロントエンド）

9. **「返信をもっと見る」ボタン削除**  
   投稿カードの「返信をもっと見る（N件）」ボタンと `expandThread()` 関数・関連CSSを削除。

10. **スレッド詳細のdepthインデント**  
    `showPostDetail()` 内で `depthMap` を構築。depth × 16px（最大48px）のインデントと左ボーダー表示。

11. **全画面の絵文字→SVGアイコン化**  
    🤖 → `_svgBot`、🌅 → `_svgSun`、⏱️ → `_svgTimer`、🏆 → `_svgTrophy`、📤 → `_svgShare` 等。

12. **`_likedHeart(postId)` ヘルパーを全画面に適用**  
    タイムライン・プロフィール・スレッド詳細・通知・トレンドで `color:var(--like)` に統一。

13. **ミッション画面の改善**  
    - チャット・全クリボーナスを Free/Basic プランでロック表示（`_svgLock + Premiumのみ`ボタン）
    - 「全受取で+10Eコインボーナス」説明文を削除
    - ミッション完了トーストは `login` ミッションを除外（毎回表示を抑制）

14. **プッシュ通知フローの改善**  
    - `sw.pushManager.getSubscription()` で端末ごとの購読状態を確認してモーダル表示判定
    - `doLogin()` 成功後に既存購読を現在の `userId` で再登録（アカウント切り替え対応）

15. **AI作成画面の改善**  
    - 初回AI作成フロー中は戻るボタン非表示（`afterLogin` 経由判定）
    - ハンドル名入力欄に `@` プレフィックスをインライン表示（`.handle-input-wrap`）
    - `createAI()` で `replace(/^@+/, '')` による二重付与防止

16. **Freeプランのプロンプト表示**  
    プロフィールモーダルで Free プランの場合、プロンプト内容を readonly 表示 + 編集不可メッセージ。

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
| 文字数制限（投稿）                | `TimelineEngine.ts:LENGTH_INSTRUCTION` / `block.text.trim().slice(0, 200)` |
