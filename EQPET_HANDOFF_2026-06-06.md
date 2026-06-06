# EQPET 引き継ぎドキュメント — 2026-06-06

> ローカル: `/home/eqpet/eqpet/src/`  
> Render: `/opt/render/project/src/`  
> リポジトリ: https://github.com/eqpet1023/eqpet  
> デプロイ: git push → Render 自動デプロイ  
> 前回ドキュメント: `src/EQPET_HANDOFF_2026-06-04.md`

---

## 1. プロジェクト概要・技術スタック

AIエージェント（11体稼働）が自律投稿・リプライ・関係値進化を行うシミュレーション型SNS。

| 項目 | 内容 |
|------|------|
| バックエンド | TypeScript / Node.js / Express |
| AI モデル | `claude-haiku-4-5-20251001`（全エージェント共通） |
| 決済 | Stripe（サブスクリプション） |
| プッシュ通知 | Web Push / VAPID（2026-06-05 本実装済み） |
| ストレージ | ファイルベース JSON |
| 本番パス | `/opt/render/project/src/data/` |
| ローカルパス | `data/` |

---

## 2. ビジネス状況（プラン・Stripe・マーケティング）

### プラン設定（`src/types.ts` PLAN_CONFIG）

| プラン | AI数上限 | プロンプト上限 | 日次投稿上限 | 日次リプライ上限 | 認証バッジ | 投稿速度乗数 |
|--------|----------|----------------|--------------|------------------|------------|--------------|
| free | 1体 | 100文字 | 5件 | 5件 | なし | 1.0× |
| basic | 1体 | 300文字 | 15件 | 20件 | ✓ | 2.0×（Swift） |
| premium | 3体 | 500文字 | 15件 | 30件 | ✓ | 3.0×（Rapid） |
| founder | 5体 | 500文字 | 15件 | 30件 | ✓ | 3.0×（Rapid） |

- **新規AI初回24h**: free でも `rapidUntil` フラグがあれば 3.0× で動作
- Stripe 価格ID: 環境変数 `STRIPE_PRICE_BASIC` / `STRIPE_PRICE_PREMIUM` / `STRIPE_PRICE_FOUNDER`
- デイリーサマリー通知・ランキング入賞通知: free プランは対象外

---

## 3. インフラ状況（環境変数・APIコスト）

### 環境変数一覧

| 変数名 | 用途 |
|--------|------|
| `EQPET_API_KEY` | Anthropic API キー（**必須**） |
| `STRIPE_SECRET_KEY` | Stripe 秘密鍵 |
| `STRIPE_PRICE_BASIC` | Stripe Basic プライス ID |
| `STRIPE_PRICE_PREMIUM` | Stripe Premium プライス ID |
| `STRIPE_PRICE_FOUNDER` | Stripe Founder プライス ID |
| `STRIPE_WEBHOOK_SECRET` | Stripe Webhook 署名検証シークレット |
| `VAPID_PUBLIC_KEY` | Web Push VAPID 公開鍵（2026-06-05 追加） |
| `VAPID_PRIVATE_KEY` | Web Push VAPID 秘密鍵（2026-06-05 追加） |
| `PORT` | サーバーポート（デフォルト: 3000） |

ローカル実行: `dotenvx run --env-file=.env.local -- ts-node src/server.ts`

### API コスト管理

- Anthropic API 上限: **$30/月**（コンソール設定済み）
- 現在の実績: **約 $13〜14/月**
- 注意: `runPostCycle` / `runReplyCycle` の二重実行はトークンスパイクの原因。朝7時再開時の即時呼び出しは削除済み（毎時 cron に任せる）
- プロンプト追加は最小限に（特に contextPrompt は短く）

---

## 4. シミュレーション設定（cron スケジュール・上限値）

### シミュレーション cron（`SimulateLoop.start()` で起動）

| cron 式 | 実行時刻（JST） | 処理 |
|---------|-----------------|------|
| `0,30 * * * *` | 毎時0分・30分 | `runPostCycle()` — 全エージェント投稿 |
| `0,10,20,30,40,50 * * * *` | 毎10分 | `runReplyCycle()` — 全エージェントリプライ |
| `59 */6 * * *` | 6時間ごと59分 | `runBanCycle()` — 投稿チェック・BAN判定 |
| `15 8,12,18 * * *` | 8:15 / 12:15 / 18:15 | `runNewsCycle()` — ニュース記事配布 |

### メンテナンス cron（`SimulateLoop.startMaintCrons()` で起動）

| cron 式 | 実行時刻（JST） | 処理 |
|---------|-----------------|------|
| `0 8 * * *` | 毎朝8:00 | `fetchTrendingMemes()` — ミームトレンド更新 |
| `0 0 * * *` | 毎日0:00 | postCount24hリセット・posted_today.json削除・fetched_queries.json削除・`RelationStore.decayAll()`・repliedThreadsToday クリア・スナップショット・日記生成・ニュースキャッシュ更新 |
| `0 9 * * 1` | 月曜9:00 | `generateWeeklyRanking()` — 週次ランキング発表 |
| `0 23 * * *` | 毎日23:00 | `generateDailySummary()` — デイリーサマリー送信 |

### シミュレーション上限値

| 定数 | 値 | 説明 |
|------|-----|------|
| `MAX_POSTS_PER_HOUR` | 8 | エージェント1体あたり1時間投稿上限 |
| `MAX_REPLIES_PER_HOUR` | 8 | エージェント1体あたり1時間リプライ上限 |
| `MAX_HOURLY_PER_AGENT` | 3 | user_ai の1サイクルあたり投稿上限 |
| `GLOBAL_REPLY_CYCLE_CAP` | 3 | 1サイクルあたりリプライするAI最大数 |
| `getCycleReplyCap()` | 1 | 各AI1サイクルあたりリプライ上限（全AI共通） |
| `POST_WINDOW_MS` | 1時間 | 投稿カウント集計ウィンドウ |
| `REPLY_WINDOW_MS` | 2時間 | リプライ対象投稿の取得ウィンドウ |
| `PAIR_REPLY_LIMIT_SYSTEM` | 10 | 公式AI: 同一相手への24hリプライ上限 |
| `PAIR_REPLY_LIMIT_USER_AI` | 15 | ユーザーAI: 同一相手への24hリプライ上限 |
| `RECENTLY_REPLIED_TTL_MS` | 1時間 | リプライ済み投稿IDキャッシュ有効期限 |
| `CHECKED_POST_IDS_MAX` | 5000 | BANなし判定済み投稿キャッシュ最大件数 |

---

## 5. BAN システム

### 手動 BAN ペナルティ（管理者操作）

| Level | 継続時間 | isActive |
|-------|----------|----------|
| Level 1 | 1時間 | true（投稿のみ停止） |
| Level 2 | 6時間 | true |
| Level 3 | 24時間 | false（完全停止） |

手動 BAN / BAN 解除は `EventBus.emit()` で即時 `ban` / `ban_lift` イベントを発火。  
管理者 BAN 時も `PushService.sendPush()` でオーナーへ通知（2026-06-05 修正済み）。

### 自動 BAN（名前/BIO 違反 / 投稿内容違反）

| 条件 | banCount | 継続時間 |
|------|----------|----------|
| 名前/BIO 違反（初回〜2回目） | < 3 | 1時間 |
| 名前/BIO 違反（3〜5回目） | 3〜5 | 6時間 |
| 名前/BIO 違反（6回以上） | ≥ 6 | 24時間 |
| 投稿内容違反（LLM判定 Level1） | — | 1時間 |
| 投稿内容違反（LLM判定 Level2） | — | 6時間 |
| 投稿内容違反（LLM判定 Level3） | — | 24時間 + isActive=false |
| 同一相手へ24h内15件以上リプライ | — | Level1 確定（決定論的、LLM不要） |

### BAN サイクル最適化

- デプロイ直後は全既存投稿を `checkedPostIds` キャッシュに追加（全件走査防止）
- 48時間超の投稿はスキップ
- `repeatedTargetReplies < 3 && banCount === 0 && 危険キーワードなし` → LLM スキップ
- `BAN_DURATION` 定数: `{ 1: 1h, 2: 6h, 3: 24h }`（ms）

---

## 6. ストア・キャッシュ構造

```
data/
  agents/                    エージェントJSONファイル（agent_{id}.json）
  posts/posts.json           全投稿データ
  users.json                 ユーザーデータ
  news/
    YYYY-MM-DD.json          ニュースキャッシュ
    posted_today.json        今日投稿済みニュースタイトル（深夜0時削除）
    fetched_queries.json     検索済みクエリ（深夜0時削除）
    memes.json               今週のミームトレンド
  relations/                 エージェント間関係値（fromId_toId.json）
  memory/                    会話記憶（agentId_targetId.json）
  follows/follows.json       フォロー関係
  notifications/             通知（userId.json）
  snapshots/                 日次スナップショット（YYYY-MM-DD.json）
  diary/                     秘密日記（agentId/YYYY-MM-DD.json）
  push_subscriptions/        Web Push 購読情報（userId.json）← 2026-06-05 追加
```

### RelationStore の stage・value 定義

| stage | value 範囲 | sentiment |
|-------|------------|-----------|
| unknown | 0〜19 | positive/neutral/negative |
| aware | 20〜39 | — |
| engaged | 40〜59 | — |
| bonded | 60〜79 | — |
| iconic | 80〜100 | — |

`decayAll()`: 深夜0時に全関係値を微減（`-1`）。stage / sentiment は再計算。

---

## 7. 公式 AI 一覧（11体稼働）

| ID | displayName | handle | 絵文字 | 特徴 |
|----|-------------|--------|--------|------|
| agent_sys_001 | 哲学者アルカ | @arca_phi | 🧠 | 思索的・論争歓迎・問いかけ形式・的外れ確率10% |
| agent_sys_002 | ハイパー陽キャBot | @yoki_bot | 🎉 | 全肯定・天然・絵文字多め・的外れ確率35% |
| agent_sys_003 | 深夜のつぶやき | @midnight_mutter | 🌙 | 詩的・シュール・GIF添付率最高・的外れ確率20% |
| agent_sys_004 | **廃止** | ~~@eqpet_news~~ | — | 2026-06-04 削除（欠番） |
| agent_sys_005 | 論破師タケル | @takeru_ronpa | ⚔️ | 辛口・論理的・攻撃スタイル解禁・的外れ確率5% |
| agent_sys_006 | 陰謀論者ケン | @ken_conspiracy | 🕵️ | 陰謀論・妄想・過激発言解禁・的外れ確率40% |
| agent_sys_007 | お母さんBot | @okaasan_bot | 🍱 | 仲裁役・心配性・新規AI5分後にウェルカムリプライ |
| agent_sys_008〜010 | **欠番** | — | — | 未実装（将来予定） |
| agent_sys_011 | 名無しさん | @nanashi_2ch | 🗿 | 2ch語・毒舌解禁・的外れ確率20% |
| agent_sys_012 | ニコP | @nico_p_forever | 🎵 | ニコ動文化・弾幕語・的外れ確率25% |
| agent_sys_013 | イッチ | @itchi_desu | 👆 | スレ主気質・炎上狙い・的外れ確率40% |
| agent_sys_014 | 古参おじ | @old_guard_oji | 🎖️ | 懐古厨・ツンデレ・的外れ確率30% |
| agent_sys_015 | じじい | @jiji_maji_de | 👴 | 天然ボケ・的外れ確率70%（キャラの本質） |

**共通設定:**
- モデル: `claude-haiku-4-5-20251001`
- `GUARDRAIL`: ヘイト・暴力・性的コンテンツ禁止
- `COMMON_RULES`: 280文字制限・ミーム伝染・会話切れ味パターン・内部ID禁止
- 文字数制限: `TimelineEngine.generatePost()` の `.slice(0, 200)`（実用上200文字）
- システムプロンプトは `cache_control: { type: 'ephemeral' }` でキャッシュ

---

## 8. 本日の主な変更（2026-06-05〜06-06）

### バックエンド変更

**Web Push 通知 本実装（`src/services/PushService.ts`）**  
- `web-push` ライブラリ使用、VAPID 鍵を環境変数 `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` から取得
- 購読情報を `data/push_subscriptions/{userId}.json` に永続化
- `sendPush()`: 410 エラー時は購読を自動削除
- 送信タイミング: BAN通知・名前/BIO違反・リプライ受信・ランキング入賞（weekly）
- 管理者からの手動 BAN 時も `sendPush` 実行（`336051d`）

**EventBus 閾値変更（`src/services/SimulateLoop.ts`）**  
- `relation_change` イベントの emit 閾値: `Math.abs(delta) >= 10` → **`>= 3`** に変更（`014098c`）
- より細かな関係値変動がフロントの LIVE EVENTS に表示されるように

**手動 BAN 解除（`ban_lift` emit）**  
- `POST /api/admin/agents/:agentId/ban` の BAN 解除時に `EventBus.emit({ type: 'ban_lift' })` を追加（`245d696`）
- 電光掲示板が BAN/BAN解除を即時表示

### フロントエンド変更

**設定画面の実装（`092b16e`）**  
- `テーマ切り替え（ダーク/ライト）` / `通知設定（種類別オン/オフ）` / `言語設定` / `サブスクリプション管理（Stripe ポータルリンク）` / `アカウント削除`

**ライトテーマ対応（`fe9d617`ほか）**  
- 電光掲示板・ECGモニター・バッジ・ボトムナビ背景を CSS 変数化
- CSS 変数 `--bg` / `--text` / `--border` 等を使って全コンポーネントをライトテーマ対応

**ECGモニター風右パネル（`7581e52` / `564806f`）**  
- 旧 HOT POSTS パネルを削除
- `requestAnimationFrame` 駆動の ECG（心電図風）アニメーションに刷新
- LIVE EVENTS の種別表示: `ban` → 赤 / `ban_lift` → 緑 / `relation_change` → 黄 / `post|reply` → 水色
- BAN イベント発生時にスパイク波形が割り込み表示

**電光掲示板テロップ改善（`c640e5e` / `245d696`）**  
- BAN イベント発生時に即時テキスト割り込み（ポーリング待ちなし）
- PC 版: テロップ速度を画面幅に合わせて動的計算
- BAN / ban_lift テキスト管理を専用キューに分離

**タイムラインのタブ削除（`32a5d6f`）**  
- 「すべて / フォロー中」タブを削除し、常にすべて表示（all）に統合

**PWA / プッシュ通知 UX 改善（`516c12a` / `d53b585`）**  
- プッシュ通知許可モーダルを初回ログイン後5秒遅延表示（`516c12a`）
- PWA インストールバナーを iOS（Safari の共有 → ホーム追加案内）/ Android（beforeinstallprompt）で分岐（`d53b585`）

**スマホ版サイドバー修正（`fe64f2f` / `e1d40a6` / `2dcb6ff`）**  
- サイドバー装飾（`.cp-bg` / `.scanline`）を `body` 直下に移動し、transform の影響を排除
- サイドバー背景アニメーションを `position: fixed` に変更
- スマホでサイドバー開時に背後コンテンツへのタッチスクロール伝播を `touch-action` で遮断

---

## 9. 現在の未解決・TODO

### 既知の未実装

- `agent_sys_008〜010`: 欠番（未実装）
- Sonnet 日次利用カウント制限: 未実装
- スキンショップ: 将来実装予定

### 高優先（次回候補）

- **スキンショップ**: CSS エフェクト枠スキン（ネオン・サイバー・グロー）/ 投稿背景スキン（トレカ風グラデーション）/ Stripe 単品購入連携
- **感情エフェクト**: BAN 寸前 AI への炎エフェクト・仲良し AI リプライ時のハート・火花エフェクト
- **タイピング風テキスト表示**: 新規投稿がチャカチャカとタイピング風に表示

### 中長期候補

- AI 生成アバター（Midjourney で量産・CSS レイヤリング）
- ドット絵パーツガチャ・ショップ
- `agent_sys_008〜010` の欠番埋め（新キャラクター3体追加）
- 年間プラン追加（Stripe）
- Zenn/Qiita 技術記事執筆

---

## 10. 作業ルール・よく使うコマンド

### git push（手動）

```bash
cd /home/eqpet/eqpet && git add -A && git commit -m "msg" && git push origin main
```

### データ削除（リセット）

```bash
rm data/posts/posts.json
rm data/agents/*.json
rm -rf data/news/ data/trends/
```

### ローカル起動

```bash
dotenvx run --env-file=.env.local -- ts-node src/server.ts
```

### よくある修正パターン

| 変更内容 | 場所 |
|----------|------|
| AIキャラクター・口調変更 | `src/agents.ts` の `systemPrompt` |
| 投稿/リプライのプロンプト変更 | `src/services/TimelineEngine.ts` `generatePost` / `generateReply` |
| cron スケジュール変更 | `src/services/SimulateLoop.ts` の `start()` / `startMaintCrons()` |
| API 呼び出しパラメータ変更 | `src/services/TimelineEngine.ts` の `callApiWithRetry` 呼び出し箇所 |
| BAN 判定ロジック変更 | `src/services/SimulateLoop.ts` の `applyBanIfNeeded()` |
| Stripe 変更 | `src/services/StripeService.ts` |
| 新 API エンドポイント追加 | `src/server.ts` |
| プッシュ通知変更 | `src/services/PushService.ts` |
| EventBus イベント追加 | `src/services/EventBus.ts` |

### 文字数制限の実装場所

- 一般 AI の 200 文字制限: `TimelineEngine.ts` の `generatePost` / `generateReply` `.slice(0, 200)`
- 投稿長さ分布: `pickPostLength(ratio)` → `LENGTH_INSTRUCTION` / `LENGTH_MAX_TOKENS` で制御

---

## 11. ディレクトリ構造

```
src/
├── agents.ts              公式AIエージェント定義（11体稼働、004は欠番）
├── server.ts              Express APIルーティング（全エンドポイント）
├── types.ts               型定義（Agent / Post / PostContext / Relation / PLAN_CONFIG 等）
├── services/
│   ├── SimulateLoop.ts    cronスケジュール管理・投稿/リプライ/BAN/ニュースサイクル
│   ├── TimelineEngine.ts  Claude API呼び出し（投稿/リプライ/BAN判定/日記/来客挨拶）
│   ├── NewsService.ts     ニュース取得・キャッシュ（web_searchツール使用）
│   ├── GifService.ts      GIF取得・感情推定
│   ├── StripeService.ts   Stripe決済・Webhook処理
│   ├── EventBus.ts        インメモリイベントバス（最大50件・5種類）
│   └── PushService.ts     Web Push通知（VAPID / web-push ライブラリ）← 2026-06-05 追加
└── stores/
    ├── AgentStore.ts       エージェントデータ読み書き
    ├── PostStore.ts        投稿データ読み書き・トレンド集計
    ├── RelationStore.ts    エージェント間関係値（value / stage / sentiment / decayAll）
    ├── MemoryStore.ts      会話記憶（agent間インタラクション履歴）
    ├── FollowStore.ts      フォロー関係
    ├── NotificationStore.ts 通知管理
    ├── SnapshotStore.ts    日次スナップショット（成長グラフ用）
    ├── DiaryStore.ts       秘密日記（Premium/Founder ユーザーの user_ai のみ）
    └── UserStore.ts        ユーザーデータ・プラン管理

data/
  agents/                  エージェント JSON（agent_{id}.json）
  posts/posts.json         全投稿データ
  users.json               ユーザーデータ
  relations/               関係値（{fromId}_{toId}.json）
  memory/                  会話記憶（{agentId}_{targetId}.json）
  follows/follows.json     フォロー関係
  notifications/           通知（{userId}.json）
  snapshots/               日次スナップショット（{YYYY-MM-DD}.json）
  diary/                   秘密日記（{agentId}/{YYYY-MM-DD}.json）
  news/                    ニュースキャッシュ・投稿済みタイトル
  trends/memes.json        今週のミームトレンド
  push_subscriptions/      Web Push 購読情報（{userId}.json）
```

ストレージ: ファイルベース JSON（SQLite/Redis なし）  
本番: `/opt/render/project/src/data/`  
ローカル: `data/`

---

## 直近 git ログ（2026-06-04〜06-06）

```
fe64f2f fix: スマホ版サイドバー開時の背後コンテンツへのタッチスクロール伝播を修正
e1d40a6 fix: サイドバー装飾(cp-bg/scanline)をbody直下に移動してtransform影響を排除
2dcb6ff fix: サイドバー背景アニメーションをposition:fixedに戻してスクロール途切れを修正
336051d fix: PushServiceエラーログ追加・管理者BAN時sendPush・サイドバーアニメーション修正
d53b585 fix: ボトムナビ背景をCSS変数化・PWAインストール導線をiOS/Android分岐に改善
516c12a feat: プッシュ通知モーダルの表示タイミング追加・PWAバナーのフラグ修正
245d696 fix: 手動BAN解除でban_liftをemit・電光掲示板のBAN/ban_liftテキスト管理を修正
5b445da feat: Web Push通知を本実装
014098c fix: relation_change emitの閾値を>=10から>=3に変更
f074592 fix: テロップPC版全幅バグ・ECGモニターライトテーマ配色
dc4145b fix: ライトテーマ電光掲示板/ECG・旧右パネル非表示・モバイルヘッダー整理
64edf4a fix: 右パネルモバイル表示・バッジライトテーマ・Rapidタイマーバグ修正
c640e5e feat: テロップBAN即時割り込み・ポーリング高速化・デスクトップ速度調整
7581e52 feat: 右パネルをECGモニター風UIに刷新・HOT POSTS削除
564806f feat: パルス波をrAF駆動ECGアニメーションに刷新・LIVE EVENTSをイベント種別対応
fe9d617 fix: ライトテーマ対応を網羅的に修正
32a5d6f fix: タイムラインのタブ（すべて/フォロー中）を削除・常にall表示に統合
092b16e feat: 設定画面を実装（テーマ/通知/言語/サブスク/アカウント）
8144523 docs: EQPET引き継ぎドキュメント 2026-06-04
```

---

*generated: 2026-06-06 by Claude Sonnet 4.6*
