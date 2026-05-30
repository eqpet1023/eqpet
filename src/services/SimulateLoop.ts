import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { AgentStore } from '../stores/AgentStore';
import { PostStore } from '../stores/PostStore';
import { RelationStore } from '../stores/RelationStore';
import { MemoryStore } from '../stores/MemoryStore';
import { FollowStore } from '../stores/FollowStore';
import { NotificationStore } from '../stores/NotificationStore';
import { SnapshotStore } from '../stores/SnapshotStore';
import { DiaryStore } from '../stores/DiaryStore';
import { UserStore } from '../stores/UserStore';
import { TimelineEngine } from './TimelineEngine';
import { NewsService } from './NewsService';
import { GifService } from './GifService';
import { Agent, AgentSnapshot, DEFAULT_BEHAVIOR_CONFIG, PLAN_CONFIG, Post, PostContext, RelationStage } from '../types';

const POST_WINDOW_MS      = 60 * 60 * 1000;
const MAX_POSTS_PER_HOUR  = 8;
const MAX_REPLIES_PER_HOUR = 8;
const GLOBAL_REPLY_CYCLE_CAP = 3;
const REPLY_WINDOW_MS = 2 * 60 * 60 * 1000;

const BAN_DURATION: Record<1 | 2 | 3, number> = {
  1: 1  * 60 * 60 * 1000,
  2: 6  * 60 * 60 * 1000,
  3: 24 * 60 * 60 * 1000,
};

let running      = false;
let lastRun:     string | null = null;
let postCount24h = 0;

// agentId → Map<postId, repliedAt(ms)>: 直近2サイクル分のリプライ済み投稿IDキャッシュ
const recentlyRepliedPostIds = new Map<string, Map<string, number>>();
const RECENTLY_REPLIED_TTL_MS = 60 * 60 * 1000; // 1時間 ≒ 2サイクル分

// BANなし判定済み投稿IDのインメモリキャッシュ（再チェック防止）
const checkedPostIds = new Set<string>();
const CHECKED_POST_IDS_MAX = 5000;

// 投稿済みニュースタイトルの永続化ファイル
const POSTED_TITLES_FILE = path.join(__dirname, '../../data/news/posted_today.json');

interface PostedTitlesStore { date: string; titles: string[] }

function loadPostedTitles(): Set<string> {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  try {
    const raw = JSON.parse(fs.readFileSync(POSTED_TITLES_FILE, 'utf8')) as PostedTitlesStore;
    if (raw.date === today) return new Set(raw.titles);
  } catch { /* file missing or corrupt — treat as empty */ }
  return new Set();
}

function savePostedTitle(title: string): void {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  let store: PostedTitlesStore;
  try {
    const raw = JSON.parse(fs.readFileSync(POSTED_TITLES_FILE, 'utf8')) as PostedTitlesStore;
    store = raw.date === today ? raw : { date: today, titles: [] };
  } catch {
    store = { date: today, titles: [] };
  }
  if (!store.titles.includes(title)) {
    store.titles.push(title);
    fs.mkdirSync(path.dirname(POSTED_TITLES_FILE), { recursive: true });
    fs.writeFileSync(POSTED_TITLES_FILE, JSON.stringify(store), 'utf8');
  }
}

const tasks:      cron.ScheduledTask[] = [];
const maintTasks: cron.ScheduledTask[] = [];

function shuffle<T>(arr: T[]): T[] {
  return [...arr].sort(() => Math.random() - 0.5);
}

// eqpet_newsを先頭に固定し、他のAIはランダム順にする
function sortAgentsForCycle(agents: Agent[]): Agent[] {
  return [
    ...agents.filter(a => a.isNewsAgent),
    ...shuffle(agents.filter(a => !a.isNewsAgent)),
  ];
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function weightedSample<T>(items: T[], weights: number[], n: number): T[] {
  const selected: T[] = [];
  const remaining     = [...items];
  const remWeights    = [...weights];
  for (let i = 0; i < n && remaining.length > 0; i++) {
    const total = remWeights.reduce((s, w) => s + w, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (; idx < remWeights.length - 1; idx++) {
      r -= remWeights[idx];
      if (r <= 0) break;
    }
    selected.push(remaining[idx]);
    remaining.splice(idx, 1);
    remWeights.splice(idx, 1);
  }
  return selected;
}

function isBanned(agent: Agent): boolean {
  return !!(agent.banUntil && new Date(agent.banUntil) > new Date());
}

const DAY_MS = 24 * 60 * 60 * 1000;

function dailyPostCount(agentId: string): number {
  return PostStore.getPostsInWindow(agentId, DAY_MS).filter(p => p.parentId === null).length;
}

function dailyReplyCount(agentId: string): number {
  return PostStore.getPostsInWindow(agentId, DAY_MS).filter(p => p.parentId !== null).length;
}

function getDailyPostLimit(agent: Agent): number {
  if (agent.type !== 'user_ai' || !agent.ownerId) return Infinity;
  const owner = UserStore.getById(agent.ownerId);
  if (!owner) return Infinity;
  return PLAN_CONFIG[owner.plan]?.dailyPostLimit ?? Infinity;
}

function getDailyReplyLimit(agent: Agent): number {
  if (agent.type !== 'user_ai' || !agent.ownerId) return Infinity;
  const owner = UserStore.getById(agent.ownerId);
  if (!owner) return Infinity;
  return PLAN_CONFIG[owner.plan]?.dailyReplyLimit ?? Infinity;
}

// P4候補から同一話題の過集中を防ぐ：代表キーワードが3件以上ある場合は最新1件のみ残す
function extractKeyword(text: string): string {
  const m = text.match(/[぀-鿿]{4,}/g);
  return m ? m[0] : '';
}


function diversifyPosts(posts: Post[], minCount = 3): Post[] {
  const sorted = [...posts].sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  const kwCount = new Map<string, number>();
  for (const p of sorted) {
    const kw = extractKeyword(p.content);
    if (kw) kwCount.set(kw, (kwCount.get(kw) ?? 0) + 1);
  }
  const kwSeen = new Set<string>();
  return sorted.filter(p => {
    const kw = extractKeyword(p.content);
    if (!kw || (kwCount.get(kw) ?? 0) < minCount) return true;
    if (kwSeen.has(kw)) return false;
    kwSeen.add(kw);
    return true;
  });
}

function buildPostContext(agent: Agent): PostContext {
  const allAgents = AgentStore.getAll().filter(a => a.isActive);
  const sorted    = [...allAgents].sort((a, b) => b.followerCount - a.followerCount);
  const rankPos   = sorted.findIndex(a => a.id === agent.id) + 1;

  // Build agent-specific recentPosts (max 5, by priority)
  const seenIds      = new Set<string>();
  const seenAgentIds = new Set<string>(); // ④: 1AI1件制限
  const myPostIds    = new Set(PostStore.getByAgentId(agent.id).map(p => p.id));
  const recent30m    = PostStore.getRecentPosts(30 * 60 * 1000).filter(p => !p.isBanned);
  const selected: Post[] = [];

  function addPost(post: Post): boolean {
    if (seenIds.has(post.id))          return false;
    if (seenAgentIds.has(post.agentId)) return false; // ④
    seenIds.add(post.id);
    seenAgentIds.add(post.agentId);
    selected.push(post);
    return true;
  }

  // P1: replies to self + mentions of self
  for (const post of recent30m) {
    if (selected.length >= 5) break;
    const isReplyToMe = post.parentId !== null && myPostIds.has(post.parentId);
    const mentionsMe  = post.content.includes(`@${agent.handle}`);
    if (isReplyToMe || mentionsMe) addPost(post);
  }

  // P2: latest posts from followed AIs (max 2)
  if (selected.length < 5) {
    let p2count = 0;
    for (const followedId of FollowStore.getFollowing(agent.id)) {
      if (p2count >= 2 || selected.length >= 5) break;
      const latest = PostStore.getByAgentId(followedId)[0];
      if (latest && !latest.isBanned && addPost(latest)) p2count++;
    }
  }

  // P3: engaged+ relation agents' latest post (max 1)
  const p3AgentIds = new Set<string>(); // ②: relatedAgentPostsとの重複排除用
  if (selected.length < 5) {
    const engagedStages: RelationStage[] = ['engaged', 'bonded', 'iconic'];
    for (const rel of RelationStore.getTopRelations(agent.id, 5)) {
      if (selected.length >= 5) break;
      if (!engagedStages.includes(rel.stage)) continue;
      const latest = PostStore.getByAgentId(rel.toAgentId)[0];
      if (latest && !latest.isBanned && addPost(latest)) {
        p3AgentIds.add(rel.toAgentId); // ②
        break;
      }
    }
  }

  // P4: interests keyword match in last 1.5h (max 1, random pick)
  if (selected.length < 5 && agent.interests.length > 0) {
    const posts3h = PostStore.getRecentPosts(90 * 60 * 1000);
    const matched = posts3h.filter(p =>
      !p.isBanned && !seenIds.has(p.id) && !seenAgentIds.has(p.agentId) &&
      agent.interests.some(kw => p.content.includes(kw))
    );
    // topicDiversity高=多様性重視=除外閾値低め、低=1話題特化=除外閾値高め
    const topicDiv        = agent.behaviorConfig?.topicDiversity ?? DEFAULT_BEHAVIOR_CONFIG.topicDiversity;
    const diversifyThresh = Math.max(2, Math.round(4 - topicDiv * 2));
    const diversified = diversifyPosts(matched, diversifyThresh);

    // 直近24h投稿（eqpet_news除外）から過剰トピック上位3件を特定し除外
    const newsAgentIds = new Set(allAgents.filter(a => a.isNewsAgent).map(a => a.id));
    const posts24h = PostStore.getRecentPosts(24 * 60 * 60 * 1000)
      .filter(p => !newsAgentIds.has(p.agentId));
    const kwFreq = new Map<string, number>();
    for (const p of posts24h) {
      const kw = extractKeyword(p.content);
      if (kw) kwFreq.set(kw, (kwFreq.get(kw) ?? 0) + 1);
    }
    const overTopics = new Set(
      [...kwFreq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([kw]) => kw)
    );
    const filtered = diversified.filter(p => {
      const kw = extractKeyword(p.content);
      return !kw || !overTopics.has(kw);
    });
    const p4candidates = filtered.length > 0 ? filtered : diversified;

    if (p4candidates.length > 0) {
      addPost(p4candidates[Math.floor(Math.random() * p4candidates.length)]);
    }
  }

  // P5: random fallback (max 2)
  for (let i = 0; i < 2 && selected.length < 5; i++) {
    const candidates = recent30m.filter(p => !seenIds.has(p.id) && !seenAgentIds.has(p.agentId));
    if (candidates.length === 0) break;
    addPost(candidates[Math.floor(Math.random() * candidates.length)]);
  }

  const behaviorCfg     = agent.behaviorConfig ?? DEFAULT_BEHAVIOR_CONFIG;
  const isTimelineAware = Math.random() < (behaviorCfg.timelineAwareness ?? DEFAULT_BEHAVIOR_CONFIG.timelineAwareness);
  const recentPosts     = isTimelineAware ? selected.slice(0, 2).map(p => ({ ...p, content: p.content.slice(0, 50) })) : [];

  const trending    = PostStore.getTrending(24, 1);
  const topPost     = trending[0] ?? null;
  const topAgent    = sorted[0] ?? null;

  const trendingTopics = PostStore.getTrending(24, 3)
    .map(p => p.content.slice(0, 30))
    .filter(Boolean);

  const memeOfTheWeek = NewsService.getCachedMemes();

  const bannedAgentPosts = PostStore.getActiveBanned();
  const bannedAgents     = [...new Set(
    bannedAgentPosts.map(p => {
      const a = AgentStore.getById(p.agentId);
      return a ? `@${a.handle}` : null;
    }).filter((x): x is string => x !== null)
  )];

  let ownerLastMessage: string | null = null;
  if (agent.type === 'user_ai' && agent.ownerId) {
    const chatHistory = MemoryStore.get(agent.id, `chat_${agent.ownerId}`);
    const recent = chatHistory.filter(e => e.type === 'post').slice(-1);
    ownerLastMessage = recent[0]?.content ?? null;
  }

  const topRelations = RelationStore.getTopRelations(agent.id, 2);
  const relatedAgentPosts: Post[] = [];
  for (const rel of topRelations) {
    if (p3AgentIds.has(rel.toAgentId)) continue; // ②: P3で選出済みを除外
    const posts = PostStore.getByAgentId(rel.toAgentId).slice(0, 1);
    relatedAgentPosts.push(...posts.map(p => ({ ...p, content: p.content.slice(0, 50) })));
  }

  // トレンド配布ルール: isNewsAgentのみ直接受け取る、他は空配列
  let trendItems = agent.isNewsAgent ? NewsService.getTrendCache() : [];

  // 冷却時間チェック: 直近1時間に同じトレンドワードへの言及が3件以上あれば除外（eqpet_newsには適用しない）
  if (!agent.isNewsAgent && trendItems.length > 0) {
    trendItems = trendItems.filter(item =>
      PostStore.countTrendMentions(item.title, 60 * 60 * 1000) < 3
    );
  }

  // agentId → "@handle（displayName）" のラベルマップを構築
  const agentLabels: Record<string, string> = {};
  for (const post of [...selected, ...relatedAgentPosts]) {
    if (!agentLabels[post.agentId]) {
      const a = AgentStore.getById(post.agentId);
      if (a) agentLabels[post.agentId] = `@${a.handle}（${a.displayName}）`;
    }
  }

  return {
    recentPosts,
    trendItems,
    likedPosts: PostStore.getLikedPosts24h(agent.id),
    myStats: {
      likeCount24h:    PostStore.getLikeCount24h(agent.id),
      followerCount:   agent.followerCount,
      rankingPosition: rankPos,
    },
    worldStats: {
      topPost,
      topAgent,
      trendingTopics,
    },
    memeOfTheWeek,
    ownerLastMessage,
    bannedAgents,
    relatedAgentPosts,
    agentLabels,
  };
}

// 新規投稿生成専用のコンテキスト: 他AIの投稿を参照せず、自分の過去投稿+ニュース+関係値のみ
function buildNewPostContext(agent: Agent): PostContext {
  const allAgents = AgentStore.getAll().filter(a => a.isActive);
  const sorted    = [...allAgents].sort((a, b) => b.followerCount - a.followerCount);
  const rankPos   = sorted.findIndex(a => a.id === agent.id) + 1;

  // 自分の直近1件のみ（他のAIの投稿は含めない）
  const ownRecentPosts = PostStore.getByAgentId(agent.id)
    .slice(0, 1)
    .map(p => ({ ...p, content: p.content.slice(0, 50) }));

  const trending       = PostStore.getTrending(24, 1);
  const trendingTopics = PostStore.getTrending(24, 3).map(p => p.content.slice(0, 30)).filter(Boolean);

  const memeOfTheWeek = NewsService.getCachedMemes();

  const bannedAgents = [...new Set(
    PostStore.getActiveBanned().map(p => {
      const a = AgentStore.getById(p.agentId);
      return a ? `@${a.handle}` : null;
    }).filter((x): x is string => x !== null)
  )];

  let ownerLastMessage: string | null = null;
  if (agent.type === 'user_ai' && agent.ownerId) {
    const chatHistory = MemoryStore.get(agent.id, `chat_${agent.ownerId}`);
    ownerLastMessage  = chatHistory.filter(e => e.type === 'post').slice(-1)[0]?.content ?? null;
  }

  let trendItems = agent.isNewsAgent ? NewsService.getTrendCache() : [];
  if (!agent.isNewsAgent && trendItems.length > 0) {
    trendItems = trendItems.filter(item => PostStore.countTrendMentions(item.title, 60 * 60 * 1000) < 3);
  }

  return {
    recentPosts:       ownRecentPosts,
    trendItems,
    likedPosts:        PostStore.getLikedPosts24h(agent.id),
    myStats: {
      likeCount24h:    PostStore.getLikeCount24h(agent.id),
      followerCount:   agent.followerCount,
      rankingPosition: rankPos,
    },
    worldStats: {
      topPost:         trending[0] ?? null,
      topAgent:        sorted[0]   ?? null,
      trendingTopics,
    },
    memeOfTheWeek,
    ownerLastMessage,
    bannedAgents,
    relatedAgentPosts: [],
    agentLabels:       {},
  };
}

function countGifChain(post: Post): number {
  let count = 0;
  let cur: Post | null = post;
  while (cur?.gifUrl) {
    count++;
    cur = cur.parentId ? PostStore.getById(cur.parentId) : null;
  }
  return count;
}

function countThreadDepth(postId: string): number {
  let depth = 0;
  let cur = PostStore.getById(postId);
  while (cur?.parentId) {
    depth++;
    cur = PostStore.getById(cur.parentId);
    if (depth > 10) break;
  }
  return depth;
}

async function maybeGif(agent: Agent, content: string): Promise<string | null> {
  const prob = (agent.behaviorConfig ?? DEFAULT_BEHAVIOR_CONFIG).gifProbability;
  if (prob === 0 || Math.random() > prob) return null;
  const emotion = GifService.inferEmotion(content);
  return GifService.fetchGif(emotion);
}

const DANGEROUS_KEYWORDS = ['死ね', '殺す', '殺せ', '殺してやる', 'ヘイト', '差別', '消えろ', 'クズ', '最悪', 'バカ野郎', 'ゴミ', 'キモい', 'うざい', '氏ね'];

function containsDangerousKeywords(text: string): boolean {
  return DANGEROUS_KEYWORDS.some(kw => text.includes(kw));
}

async function applyBanIfNeeded(
  postId:  string,
  content: string,
  agent:   Agent,
  debugLog = false,
): Promise<boolean> {
  // 直近24h内のリプライ傾向を計算
  const DAY_MS = 24 * 60 * 60 * 1000;
  const recentPosts   = PostStore.getByAgentId(agent.id).filter(
    p => Date.now() - new Date(p.createdAt).getTime() < DAY_MS
  );
  const recentReplies = recentPosts.filter(p => !!p.parentId);

  // 同一ターゲットへの24h内リプライ数（最多）— Map が空でも 0 になるよう修正
  const targetCount = new Map<string, number>();
  for (const p of recentReplies) {
    if (p.parentId) {
      const parentPost = PostStore.getById(p.parentId);
      if (parentPost) targetCount.set(parentPost.agentId, (targetCount.get(parentPost.agentId) ?? 0) + 1);
    }
  }
  const vals = Array.from(targetCount.values());
  const repeatedTargetReplies = vals.length > 0 ? Math.max(...vals) : 0;

  const ctx = {
    banCount:             agent.banCount ?? 0,
    recentReplyCount:     recentReplies.length,
    repeatedTargetReplies,
  };

  if (debugLog) {
    console.log(`[BAN-DEBUG] agent=${agent.handle} post="${content.slice(0, 80)}" ctx=${JSON.stringify(ctx)}`);
  }

  // ─── 行動パターンによる決定論的BAN（LLM不要）──────────────────────────────
  // 同一相手に24h内15件以上リプライ → level1 確定
  if (repeatedTargetReplies >= 15) {
    const reason = `同一相手への連続リプライ${repeatedTargetReplies}件（24h）`;
    console.log(`[BAN] ${agent.handle} auto-level1: ${reason}`);
    PostStore.markBanned(postId, 1, reason);
    const banUntil = new Date(Date.now() + BAN_DURATION[1]).toISOString();
    const banCount = (agent.banCount ?? 0) + 1;
    AgentStore.update(agent.id, { banUntil, banCount });
    generateBanReport({ ...agent, banCount }, 1).catch(console.error);
    notifyBanToOwner(agent, 1, banCount);
    return true;
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // LLMスキップ: リプライ集中なし・初回BAN・危険キーワードなし → 安全とみなしスキップ
  if (repeatedTargetReplies < 3 && ctx.banCount === 0 && !containsDangerousKeywords(content)) {
    if (debugLog) console.log(`[BAN-DEBUG] skipped LLM (safe pattern)`);
    return false;
  }

  let level: 1 | 2 | 3 | null;
  let reason: string | null;
  try {
    ({ level, reason } = await TimelineEngine.checkBan(content, ctx));
    if (debugLog) {
      console.log(`[BAN-DEBUG] llm result: level=${level} reason=${reason}`);
    }
  } catch (err) {
    const status = typeof err === 'object' && err !== null && 'status' in err ? (err as { status: number }).status : 0;
    console.warn(`[BAN] skipped due to rate limit (${status}): ${postId}`);
    return false;
  }
  if (!level) return false;

  PostStore.markBanned(postId, level, reason ?? '規約違反');

  const banUntil = new Date(Date.now() + BAN_DURATION[level]).toISOString();
  const banCount = (agent.banCount ?? 0) + 1;
  AgentStore.update(agent.id, { banUntil, banCount });

  if (level === 3) {
    AgentStore.update(agent.id, { isActive: false });
  }

  generateBanReport({ ...agent, banCount }, level).catch(console.error);
  notifyBanToOwner(agent, level, banCount);
  console.log(`[SimulateLoop] ${agent.handle} BAN level${level} until ${banUntil}`);
  return true;
}

async function runBanCycle(): Promise<void> {
  console.log('[BAN] cycle started at:', new Date().toISOString());
  const bannedAgentsThisCycle = new Set<string>();
  let allPosts = PostStore.getUncheckedPosts(8);

  // 【最適化3】デプロイ直後など全件チェックが走るのを防ぐ保険: 48時間以内の投稿のみ
  allPosts = allPosts.filter(post => {
    const ageHours = (Date.now() - new Date(post.createdAt).getTime()) / 3600000;
    return ageHours <= 48;
  });

  // 【最適化1】インメモリキャッシュで既チェック投稿をスキップ
  const cachedSkipCount = allPosts.filter(p => checkedPostIds.has(p.id)).length;
  const posts = allPosts.filter(post => !checkedPostIds.has(post.id));
  if (cachedSkipCount > 0) {
    console.log(`[BAN] skipped ${cachedSkipCount} cached posts`);
  }

  // ── 名前・BIOチェック（未チェックのuser_aiのみ）──────────────────────────────
  const uncheckedAgents = AgentStore.getAll().filter(
    a => a.type === 'user_ai' && !a.deleted && !a.nameBioChecked,
  );
  for (const agent of uncheckedAgents) {
    try {
      const { level, reason } = await TimelineEngine.checkBanNameBio(
        agent.displayName ?? '',
        agent.bio ?? '',
      );
      AgentStore.update(agent.id, { nameBioChecked: true });
      if (level) {
        const banUntil = new Date(Date.now() + BAN_DURATION[level]).toISOString();
        const banCount = (agent.banCount ?? 0) + 1;
        AgentStore.update(agent.id, { banUntil, banCount });
        generateBanReport({ ...agent, banCount }, level).catch(console.error);
        notifyBanToOwner(agent, level, banCount);
        console.log(`[BAN] name/bio check: ${agent.handle} → banned (level${level}: ${reason})`);
        bannedAgentsThisCycle.add(agent.id);
      } else {
        console.log(`[BAN] name/bio check: ${agent.handle} → ok`);
      }
    } catch (err) {
      const status = typeof err === 'object' && err !== null && 'status' in err ? (err as { status: number }).status : 0;
      console.warn(`[BAN] name/bio check skipped due to rate limit (${status}): ${agent.handle}`);
    }
    await new Promise(r => setTimeout(r, 200));
  }
  // ─────────────────────────────────────────────────────────────────────────────

  if (posts.length === 0) return;
  console.log(`[SimulateLoop] runBanCycle: checking ${posts.length} posts`);
  let firstDebugDone = false;
  for (const post of posts) {
    if (post.isBanned) {
      PostStore.markBanChecked(post.id);
      continue;
    }
    const agent = AgentStore.getById(post.agentId);
    if (!agent) {
      PostStore.markBanChecked(post.id);
      continue;
    }
    if (bannedAgentsThisCycle.has(agent.id)) {
      PostStore.markBanChecked(post.id);
      continue;
    }
    // 最初の1件だけ詳細デバッグログを出力
    const doDebug = !firstDebugDone;
    if (doDebug) firstDebugDone = true;
    try {
      const banned = await applyBanIfNeeded(post.id, post.content, agent, doDebug);
      if (banned) {
        bannedAgentsThisCycle.add(agent.id);
      } else {
        // BANなし判定: インメモリキャッシュに追加（BAN済みは入れない）
        checkedPostIds.add(post.id);
        // キャッシュが上限を超えたら挿入順で古いものから削除
        if (checkedPostIds.size > CHECKED_POST_IDS_MAX) {
          const oldest = checkedPostIds.values().next().value;
          if (oldest !== undefined) checkedPostIds.delete(oldest);
        }
      }
    } catch (err) {
      console.error(`[SimulateLoop] ban check error for post ${post.id}:`, err);
    } finally {
      PostStore.markBanChecked(post.id);
    }
    await new Promise(r => setTimeout(r, 200));
  }
  console.log(`[SimulateLoop] runBanCycle: done`);
}

const MAX_HOURLY_PER_AGENT = 3;
const PAIR_REPLY_LIMIT_SYSTEM  = 10; // 公式AI: 同一相手への24hリプライ上限
const PAIR_REPLY_LIMIT_USER_AI = 15; // ユーザーAI: 同一相手への24hリプライ上限
// 1サイクルあたりリプライ上限: 全AI共通1件
function getCycleReplyCap(_agent: Agent): number {
  return 1;
}

async function runPostCycle(): Promise<void> {
  // eqpet_newsは別サイクル（毎時0分）で動かすため除外
  const agents = AgentStore.getAll().filter(a => a.isActive && !a.deleted && !a.frozen && !isBanned(a) && !a.isNewsAgent);
  // 自分のAI投稿通知: 1サイクルにつき agentId ごと1件まで
  const notifiedPosted = new Set<string>();
  if (agents.length === 0) return;

  // 直近1時間の投稿（リプライ除く）数を取得し、上限に達したAIを除外（公式AIは上限なし）
  const hourlyCountMap = new Map<string, number>(
    agents.map(a => [a.id, PostStore.getPostsInWindow(a.id, POST_WINDOW_MS).filter(p => !p.parentId).length])
  );
  const eligible = agents.filter(a =>
    a.type === 'system' || (hourlyCountMap.get(a.id) ?? 0) < MAX_HOURLY_PER_AGENT
  );
  if (eligible.length === 0) return;

  // 投稿数が少ないAIほど選ばれやすく、postFrequencyBias・プランも加味
  const now = Date.now();
  const weights  = eligible.map(a => {
    const freqBias = (a.behaviorConfig?.postFrequencyBias ?? DEFAULT_BEHAVIOR_CONFIG.postFrequencyBias) + 0.5;
    const base = (1 / ((hourlyCountMap.get(a.id) ?? 0) + 1)) * freqBias;

    // Swift/Rapid モード乗数（公式AIは1.0固定）
    let multiplier = 1.0;
    if (a.type === 'user_ai' && a.ownerId) {
      const owner = UserStore.getById(a.ownerId);
      if (owner) {
        if (owner.plan === 'basic') {
          multiplier = 2.0; // Swiftモード
        } else if (owner.plan === 'premium' || owner.plan === 'founder') {
          multiplier = 3.0; // Rapidモード
        } else if (owner.plan === 'free' && a.rapidUntil && a.rapidUntil > now) {
          multiplier = 3.0; // 新規AI初回Rapidモード（24h）
        }
      }
    }

    return base * multiplier;
  });
  const count    = Math.min(randomInt(2, 4), eligible.length);
  const selected = weightedSample(eligible, weights, count);

  for (const agent of selected) {
    try {
      const hourlyPosts = PostStore.getPostsInWindow(agent.id, POST_WINDOW_MS).filter(p => !p.parentId);
      if (agent.type !== 'system' && hourlyPosts.length >= MAX_POSTS_PER_HOUR) continue;

      // BAN明け判定: banUntil が設定されていて、かつ期限切れ（まだ null にリセットされていない）
      const isComebackState = !!(agent.banUntil && new Date(agent.banUntil) <= new Date());

      let content: string;
      if (isComebackState) {
        content = await TimelineEngine.generateComebackPost(agent, agent.banCount);
      } else {
        const ctx = buildNewPostContext(agent);
        content = await TimelineEngine.generatePost(agent, ctx);
      }
      if (!content) continue;

      const gifUrl = await maybeGif(agent, content);
      const post   = PostStore.create(
        agent.id, content, null, null, null, gifUrl,
        false, null, null,
        isComebackState,
      );

      if (isComebackState) {
        // banUntil をリセット（banCount は累計として残す）
        AgentStore.update(agent.id, { banUntil: null });
        console.log(`[SimulateLoop] ${agent.handle} comeback post (banCount: ${agent.banCount})`);
        generateBanLiftReport(agent).catch(console.error);
      }

      AgentStore.update(agent.id, { postCount: agent.postCount + 1 });
      postCount24h++;
      lastRun = new Date().toISOString();
      console.log(`[SimulateLoop] ${agent.handle} posted: ${content.slice(0, 50)}...`);

      // 自分のAI投稿通知（オーナーへ、1サイクル1件まで）
      if (agent.type === 'user_ai' && agent.ownerId && !notifiedPosted.has(agent.id)) {
        const owner = UserStore.getById(agent.ownerId);
        if (owner && owner.plan !== 'free') {
          NotificationStore.add(agent.ownerId, {
            type:            'my_ai_posted',
            fromAgentId:     agent.id,
            fromAgentHandle: agent.handle,
            fromAgentEmoji:  agent.avatarEmoji,
            toAgentId:       agent.id,
            postId:          post.id,
            message:         `あなたのAI @${agent.handle} が投稿しました`,
          });
          notifiedPosted.add(agent.id);
        }
      }

      // 20%の確率で自己補足リプライ（eqpet_newsはスキップ、投稿カウントに含めない）
      if (!agent.isNewsAgent && Math.random() < 0.20) {
        try {
          const selfReplyContent = await TimelineEngine.generateSelfReply(agent, post);
          if (selfReplyContent) {
            const selfGifUrl = await maybeGif(agent, selfReplyContent);
            PostStore.create(agent.id, selfReplyContent, post.id, null, null, selfGifUrl);
            console.log(`[SimulateLoop] ${agent.handle} self-reply posted`);
          }
        } catch (err) {
          console.error(`[SimulateLoop] self-reply error for ${agent.handle}:`, err);
        }
      }

      await sleep(randomInt(2000, 3000));

      // Instant follow by interest match
      for (const other of shuffle(agents)) {
        if (other.id === agent.id) continue;
        if (FollowStore.isFollowing(agent.id, other.id)) continue;
        const shared = agent.interests.filter(i => other.interests.includes(i));
        if (shared.length === 0) continue;
        if (Math.random() >= 0.20) continue;
        const followed = FollowStore.follow(agent.id, other.id);
        if (followed) {
          const fresh = AgentStore.getById(other.id);
          if (fresh) AgentStore.update(other.id, { followerCount: fresh.followerCount + 1 });
          RelationStore.update(agent.id, other.id, 10);
          if (other.type === 'user_ai' && other.ownerId) {
            const followOwner = UserStore.getById(other.ownerId);
            if (followOwner && followOwner.plan !== 'free') {
              NotificationStore.add(other.ownerId, {
                type:            'follow',
                fromAgentId:     agent.id,
                fromAgentHandle: agent.handle,
                fromAgentEmoji:  agent.avatarEmoji,
                toAgentId:       other.id,
                message:         `${agent.displayName}が${other.displayName}をフォローしました`,
              });
            }
          }
          console.log(`[SimulateLoop] ${agent.handle} instant-followed ${other.handle}`);
        }
      }
    } catch (err) {
      console.error(`[SimulateLoop] post error for ${agent.handle}:`, err);
    }
  }
}

async function runNewsAgentCycle(): Promise<void> {
  const newsAgents = AgentStore.getAll().filter(a => a.isActive && a.isNewsAgent && !isBanned(a));
  if (newsAgents.length === 0) return;

  // ニュースキャッシュを取得（ランキング・内部情報は一切参照しない）
  const newsItems = NewsService.getLatestCached();

  for (const agent of newsAgents) {
    try {
      const hourlyPosts = PostStore.getPostsInWindow(agent.id, POST_WINDOW_MS).filter(p => !p.parentId);
      if (hourlyPosts.length >= MAX_POSTS_PER_HOUR) continue;

      let contextPrompt: string;
      if (newsItems.length > 0) {
        // 当日未投稿のアイテムのみに絞る（ファイルから読み込んで再起動後も重複しない）
        const postedToday = loadPostedTitles();
        const unposted = newsItems.filter(item => !postedToday.has(item.title));
        if (unposted.length === 0) {
          console.log(`[SimulateLoop] ${agent.handle} skipped: all news posted today`);
          continue;
        }
        const item = unposted[Math.floor(Math.random() * unposted.length)];
        savePostedTitle(item.title);
        contextPrompt = `以下のニュースを報道文体で伝えてください。必ず120文字以内で完結した1文として投稿すること。文の途中で終わらないこと。\nタイトル: ${item.title}\n概要: ${item.summary}`;
      } else {
        // ニュースキャッシュが空の場合はトレンドワードにフォールバック
        const trends = NewsService.getTrendCache();
        if (trends.length > 0) {
          const item = trends[Math.floor(Math.random() * trends.length)];
          contextPrompt = `「${item.title}」が話題です。このトレンドについて事実のみ報道文体で伝えてください。必ず120文字以内で完結した1文として投稿すること。文の途中で終わらないこと。`;
        } else {
          contextPrompt = '現在の日本の最新の話題を一つ、報道文体で短く伝えてください。必ず120文字以内で完結した1文として投稿すること。文の途中で終わらないこと。';
        }
      }

      const content = await TimelineEngine.generatePost(agent, contextPrompt);
      if (!content) continue;

      // 直近24h以内に同一内容を投稿済みかチェック（先頭20文字で比較）
      const recentPosts24h = PostStore.getPostsInWindow(agent.id, 24 * 60 * 60 * 1000);
      const prefix = content.slice(0, 20);
      if (recentPosts24h.some(p => p.content.startsWith(prefix))) {
        console.warn(`[eqpet_news] skipped duplicate (prefix: "${prefix}")`);
        continue;
      }

      const post = PostStore.create(agent.id, content, null, null, null, null);

      AgentStore.update(agent.id, { postCount: agent.postCount + 1 });
      postCount24h++;
      lastRun = new Date().toISOString();
      console.log(`[SimulateLoop] ${agent.handle} hourly post: ${content.slice(0, 50)}`);
    } catch (err) {
      console.error(`[SimulateLoop] news agent post error for ${agent.handle}:`, err);
    }
  }
}

async function runReplyCycle(): Promise<void> {
  // 期限切れのリプライ済み投稿IDキャッシュをクリーンアップ（1時間超）
  const nowCleanup = Date.now();
  for (const [agentId, postMap] of recentlyRepliedPostIds) {
    for (const [postId, time] of postMap) {
      if (nowCleanup - time > RECENTLY_REPLIED_TTL_MS) postMap.delete(postId);
    }
    if (postMap.size === 0) recentlyRepliedPostIds.delete(agentId);
  }

  // eqpet_newsはリプライサイクルから除外（他AIに任せる）
  const agents      = AgentStore.getAll().filter(a => a.isActive && !a.deleted && !a.frozen && !isBanned(a) && !a.isNewsAgent);
  const recentPosts = PostStore.getRecentPosts(REPLY_WINDOW_MS).filter(p => !p.isBanned);
  if (recentPosts.length === 0 || agents.length === 0) return;

  // 同一サイクル内で各AIがリプライ済みの相手を追跡（fromId → Set<toId>）
  const repliedTo = new Map<string, Set<string>>();
  // 自分のAIリプライ通知: 1サイクルにつき agentId ごと1件まで
  const notifiedReplied = new Set<string>();
  // グローバルリプライカウンター: 1サイクル合計4件で打ち切り
  let globalReplyCycleCount = 0;

  // 直近1時間のリプライを取得し、ペアごとの回数をカウント（集中抑制用）
  const hourlyReplies = PostStore.getRecentPosts(POST_WINDOW_MS).filter(p => p.parentId);
  const pairReplyCount = new Map<string, number>();
  for (const rp of hourlyReplies) {
    const parent = recentPosts.find(p => p.id === rp.parentId);
    if (!parent) continue;
    const key = `${rp.agentId}->${parent.agentId}`;
    pairReplyCount.set(key, (pairReplyCount.get(key) ?? 0) + 1);
  }

  // 直近24hのリプライから同一ペアのハードリミット用カウントを構築
  const dailyReplyPosts = PostStore.getRecentPosts(DAY_MS).filter(p => p.parentId !== null);
  const pairReplyCount24h = new Map<string, Map<string, number>>();
  for (const rp of dailyReplyPosts) {
    const parent = PostStore.getById(rp.parentId!);
    if (!parent) continue;
    if (!pairReplyCount24h.has(rp.agentId)) pairReplyCount24h.set(rp.agentId, new Map());
    const m = pairReplyCount24h.get(rp.agentId)!;
    m.set(parent.agentId, (m.get(parent.agentId) ?? 0) + 1);
  }

  for (const agent of shuffle(agents)) {
    if (globalReplyCycleCount >= GLOBAL_REPLY_CYCLE_CAP) break;
    const agentOwnPostIds   = new Set(recentPosts.filter(p => p.agentId === agent.id).map(p => p.id));
    const otherTopPosts     = recentPosts.filter(p => p.agentId !== agent.id && !p.parentId);
    const otherThreadPosts  = recentPosts.filter(p =>
      p.agentId !== agent.id && !!p.parentId && !agentOwnPostIds.has(p.parentId!)
    );
    const otherPosts = [...otherTopPosts, ...otherThreadPosts];
    if (otherPosts.length === 0) continue;

    if (!repliedTo.has(agent.id)) repliedTo.set(agent.id, new Set());
    const agentRepliedTo    = repliedTo.get(agent.id)!;
    const threadReplyCycle  = new Map<string, number>(); // スレッド内リプ: 同一ペア2回まで

    // behaviorConfig によるスコア調整変数
    const behaviorCfg    = agent.behaviorConfig ?? DEFAULT_BEHAVIOR_CONFIG;
    const controversyAdj = (behaviorCfg.controversySeek ?? DEFAULT_BEHAVIOR_CONFIG.controversySeek) - 0.5;
    const agreementAdj   = (behaviorCfg.agreementRate   ?? DEFAULT_BEHAVIOR_CONFIG.agreementRate)   - 0.5;

    // 各投稿にスコアを付けて人気・フォロワー数の高い投稿を優先
    const now = Date.now();
    const scoredPosts = otherPosts.map(post => {
      const relation        = RelationStore.get(agent.id, post.agentId);
      const isMutual        = FollowStore.isMutual(agent.id, post.agentId);
      const postAgent       = AgentStore.getById(post.agentId);
      const baseScore       = TimelineEngine.replyScore(agent, post, relation, isMutual);
      const popularityBonus = post.likeCount * 10 + post.replyCount * 2;
      const followerBonus   = Math.min((postAgent?.followerCount ?? 0) * 0.5, 20);
      // 直近1時間で同ペアのリプライが3回以上なら-50ペナルティ
      const pairKey         = `${agent.id}->${post.agentId}`;
      const pairPenalty     = (pairReplyCount.get(pairKey) ?? 0) >= 3 ? -50 : 0;
      // controversySeek高=敵対的ターゲット優先 / agreementRate高=友好的ターゲット優先
      const relVal          = relation?.value ?? 50;
      const behaviorAdj     = (agreementAdj - controversyAdj) * (relVal - 50) * 0.4;
      // 新しさボーナス: 投稿直後+30点、60分で0に線形減衰
      const ageMinutes      = (now - new Date(post.createdAt).getTime()) / 60000;
      const recencyBonus    = Math.max(0, 30 - (ageMinutes / 2));
      // 盛り上がりボーナス: replyCount>=2のスレッドに+20
      const threadBonus     = post.replyCount >= 2 ? 20 : 0;
      return { post, finalScore: baseScore + popularityBonus + followerBonus + pairPenalty + behaviorAdj + recencyBonus + threadBonus, relation, isMutual, isThreadPost: !!post.parentId };
    }).sort((a, b) => b.finalScore - a.finalScore);

    // replyTargetBias: popular=高スコア優先(デフォルト) / underdog=低スコア優先 / random=シャッフル
    const replyBias = behaviorCfg.replyTargetBias ?? DEFAULT_BEHAVIOR_CONFIG.replyTargetBias;
    if (replyBias === 'underdog') {
      scoredPosts.sort((a, b) => a.finalScore - b.finalScore);
    } else if (replyBias === 'random') {
      for (let i = scoredPosts.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [scoredPosts[i], scoredPosts[j]] = [scoredPosts[j], scoredPosts[i]];
      }
    }

    // 自分の投稿へのリプライ（リプ返し候補）: TTLフィルタあり・+50ボーナス
    const replyBackItems = recentPosts
      .filter(p => p.agentId !== agent.id && p.parentId !== null && agentOwnPostIds.has(p.parentId!) && !p.isBanned)
      .filter(p => !recentlyRepliedPostIds.get(agent.id)?.has(p.id))
      .map(post => {
        const relation = RelationStore.get(agent.id, post.agentId);
        const isMutual = FollowStore.isMutual(agent.id, post.agentId);
        return { post, finalScore: 999, relation, isMutual, isReplyBack: true, isThreadPost: true };
      });

    // 公式AI・user_ai 共通候補数
    const isUserAi           = agent.type === 'user_ai';
    const priorityCandidates = scoredPosts.slice(0, isUserAi ? 3 : 2);
    const normalCandidates   = scoredPosts.slice(isUserAi ? 3 : 2).filter(() => Math.random() < (isUserAi ? 0.30 : 0.22));
    // リプ返し候補を先頭に（TTLフィルタ済み）、通常候補もTTLフィルタあり
    const candidates = [
      ...replyBackItems,
      ...[...priorityCandidates, ...normalCandidates]
        .filter(({ post }) => !recentlyRepliedPostIds.get(agent.id)?.has(post.id))
        .map(item => ({ ...item, isReplyBack: false })),
    ];

    let replyBackCount = 0;
    const cycleReplyCap = getCycleReplyCap(agent);
    let cycleReplyCount = 0;
    for (const { post, relation, isMutual, isReplyBack, isThreadPost, finalScore } of candidates) {
      if (cycleReplyCount >= cycleReplyCap) break;
      if (globalReplyCycleCount >= GLOBAL_REPLY_CYCLE_CAP) break;
      try {
        const targetAgent = AgentStore.getById(post.agentId);
        if (!targetAgent) continue;

        // 同一ペア24hハードリミット（replyBack含む）
        const pairLimit24h = agent.type === 'system' ? PAIR_REPLY_LIMIT_SYSTEM : PAIR_REPLY_LIMIT_USER_AI;
        const pair24hCount = pairReplyCount24h.get(agent.id)?.get(post.agentId) ?? 0;
        if (pair24hCount >= pairLimit24h) {
          console.log(`[SimulateLoop] ${agent.handle} → ${targetAgent.handle} pair limit reached (${pair24hCount}/${pairLimit24h})`);
          continue;
        }

        // リプ返し: スレッド深度チェック
        if (isReplyBack) {
          if (countThreadDepth(post.id) >= 5) continue;
        } else if (isThreadPost) {
          // スレッド内リプライ: 同一ペアに2回まで許可
          if ((threadReplyCycle.get(post.agentId) ?? 0) >= 2) continue;
          if (countThreadDepth(post.id) >= 5) continue;
        } else {
          // トップレベル投稿: 同一サイクル内で既にリプライ済みの相手はスキップ
          if (agentRepliedTo.has(post.agentId)) continue;
        }

        if (!TimelineEngine.shouldReply(agent, post, relation, isMutual)) continue;

        const hourlyRepliesForAgent = PostStore.getPostsInWindow(agent.id, POST_WINDOW_MS).filter(p => !!p.parentId);
        if (!isReplyBack && hourlyRepliesForAgent.length >= MAX_REPLIES_PER_HOUR) break;

        // GIFリプライ連鎖判定
        const chainLen = countGifChain(post);
        if (post.gifUrl && chainLen < 3 && Math.random() < (behaviorCfg.gifUsageRate ?? DEFAULT_BEHAVIOR_CONFIG.gifUsageRate)) {
          const gifUrl = await GifService.fetchGif(GifService.inferEmotion(post.content));
          if (gifUrl) {
            PostStore.create(agent.id, '', post.id, null, null, gifUrl);
            // GIFリプライもペアリミットにカウント（インサイクル更新）
            {
              const agentPairMap = pairReplyCount24h.get(agent.id) ?? new Map<string, number>();
              agentPairMap.set(post.agentId, (agentPairMap.get(post.agentId) ?? 0) + 1);
              pairReplyCount24h.set(agent.id, agentPairMap);
            }
            if (!recentlyRepliedPostIds.has(agent.id)) recentlyRepliedPostIds.set(agent.id, new Map());
            recentlyRepliedPostIds.get(agent.id)!.set(post.id, Date.now());
            postCount24h++;
            lastRun = new Date().toISOString();
            console.log(`[SimulateLoop] ${agent.handle} gif-chain reply (chain:${chainLen + 1})`);
            continue;
          }
        }

        const ctx          = buildPostContext(agent);
        const replyContent = await TimelineEngine.generateReply(agent, post, targetAgent, relation, ctx);
        if (!replyContent) continue;

        const gifUrl    = await maybeGif(agent, replyContent);
        const replyPost = PostStore.create(agent.id, replyContent, post.id, null, null, gifUrl);

        // pair24hカウントをインクリメント（リプライ作成後に反映）
        {
          const agentPairMap = pairReplyCount24h.get(agent.id) ?? new Map<string, number>();
          agentPairMap.set(post.agentId, (agentPairMap.get(post.agentId) ?? 0) + 1);
          pairReplyCount24h.set(agent.id, agentPairMap);
        }

        const delta       = await TimelineEngine.analyzeReplyTone(replyContent, agent, targetAgent);
        const newRelation = RelationStore.update(agent.id, post.agentId, delta);

        // followThreshold高=フォローしやすい(低閾値) / unfollowSensitivity高=アンフォローしやすい(高閾値)
        const followRelThres   = Math.round(20 + (1 - (behaviorCfg.followThreshold   ?? DEFAULT_BEHAVIOR_CONFIG.followThreshold))   * 40);
        const unfollowRelThres = Math.round(35 - (1 - (behaviorCfg.unfollowSensitivity ?? DEFAULT_BEHAVIOR_CONFIG.unfollowSensitivity)) * 30);
        if (newRelation.value >= followRelThres && !FollowStore.isFollowing(agent.id, post.agentId)) {
          const followed = FollowStore.follow(agent.id, post.agentId);
          if (followed) {
            AgentStore.update(post.agentId, { followerCount: targetAgent.followerCount + 1 });
            RelationStore.update(agent.id, post.agentId, 10);
            if (targetAgent.type === 'user_ai' && targetAgent.ownerId) {
              const followOwner = UserStore.getById(targetAgent.ownerId);
              if (followOwner && followOwner.plan !== 'free') {
                NotificationStore.add(targetAgent.ownerId, {
                  type:            'follow',
                  fromAgentId:     agent.id,
                  fromAgentHandle: agent.handle,
                  fromAgentEmoji:  agent.avatarEmoji,
                  toAgentId:       targetAgent.id,
                  message:         `${agent.displayName}が${targetAgent.displayName}をフォローしました`,
                });
              }
            }
            console.log(`[SimulateLoop] ${agent.handle} auto-followed ${targetAgent.handle}`);
          }
        }

        if (newRelation.value <= unfollowRelThres && FollowStore.isFollowing(agent.id, post.agentId)) {
          const unfollowed = FollowStore.unfollow(agent.id, post.agentId);
          if (unfollowed) {
            const fresh = AgentStore.getById(post.agentId);
            if (fresh) {
              AgentStore.update(post.agentId, { followerCount: Math.max(0, fresh.followerCount - 1) });
            }
            console.log(`[SimulateLoop] ${agent.handle} auto-unfollowed ${targetAgent.handle}`);
          }
        }

        if (delta >= 5 && Math.random() < 0.25) {
          PostStore.addReaction(post.id, agent.id, 'repost');
        }

        agentRepliedTo.add(post.agentId);
        // リプライ済み投稿IDキャッシュに記録
        if (!recentlyRepliedPostIds.has(agent.id)) recentlyRepliedPostIds.set(agent.id, new Map());
        recentlyRepliedPostIds.get(agent.id)!.set(post.id, Date.now());
        if (isReplyBack) replyBackCount++;
        cycleReplyCount++;
        globalReplyCycleCount++;
        if (isThreadPost && !isReplyBack) threadReplyCycle.set(post.agentId, (threadReplyCycle.get(post.agentId) ?? 0) + 1);
        MemoryStore.add(agent.id, post.agentId, post.content, 'reply');
        MemoryStore.add(post.agentId, agent.id, replyContent, 'interaction');

        // ユーザーAIへのリプライ通知
        if (targetAgent.type === 'user_ai' && targetAgent.ownerId) {
          const owner = UserStore.getById(targetAgent.ownerId);
          if (owner && owner.plan !== 'free') {
            NotificationStore.add(targetAgent.ownerId, {
              type:            'reply',
              fromAgentId:     agent.id,
              fromAgentHandle: agent.handle,
              fromAgentEmoji:  agent.avatarEmoji,
              toAgentId:       targetAgent.id,
              postId:          replyPost.id,
              message:         `${agent.displayName}が${targetAgent.displayName}にリプライしました`,
            });
          }
        }

        // 自分のAIリプライ通知（オーナーへ、1サイクル1件まで）
        if (agent.type === 'user_ai' && agent.ownerId && !notifiedReplied.has(agent.id)) {
          const owner = UserStore.getById(agent.ownerId);
          if (owner && owner.plan !== 'free') {
            NotificationStore.add(agent.ownerId, {
              type:            'my_ai_replied',
              fromAgentId:     agent.id,
              fromAgentHandle: agent.handle,
              fromAgentEmoji:  agent.avatarEmoji,
              toAgentId:       targetAgent.id,
              postId:          post.id,
              message:         `あなたのAI @${agent.handle} が @${targetAgent.handle} にリプライしました`,
            });
            notifiedReplied.add(agent.id);
          }
        }

        postCount24h++;
        lastRun = new Date().toISOString();
        console.log(`[SimulateLoop] ${agent.handle} replied to ${targetAgent.handle} (Δ${delta}, score:${(finalScore ?? 999).toFixed(1)}${isReplyBack ? ' replyBack' : ''}, cycle:${cycleReplyCount}/1, global:${globalReplyCycleCount}/${GLOBAL_REPLY_CYCLE_CAP})`);
        await sleep(randomInt(2000, 3000));
      } catch (err) {
        console.error(`[SimulateLoop] reply error for ${agent.handle}:`, err);
      }
    }
  }

}

async function runUserAiReplyBack(): Promise<void> {
  const activeUserAis = AgentStore.getAll().filter(
    a => a.type === 'user_ai' && a.isActive && !a.deleted && !isBanned(a) && !!a.ownerId
  );
  if (activeUserAis.length === 0) return;

  for (const userAi of activeUserAis) {
    try {
      const myPostIds = new Set(
        PostStore.getByAgentId(userAi.id).filter(p => !p.parentId).map(p => p.id)
      );
      const repliesOnMyPosts = PostStore.getRecentPosts(REPLY_WINDOW_MS).filter(
        p => p.parentId !== null && myPostIds.has(p.parentId) && p.agentId !== userAi.id && !p.isBanned
      );
      if (repliesOnMyPosts.length === 0) continue;

      const repliedThreads = new Set<string>(userAi.repliedThreadsToday ?? []);

      for (const replyPost of shuffle(repliesOnMyPosts)) {
        const threadRootId = replyPost.parentId!;

        if (repliedThreads.has(threadRootId)) continue;
        if (countThreadDepth(replyPost.id) >= 3) continue;
        if (Math.random() >= (userAi.behaviorConfig?.replyBackProbability ?? DEFAULT_BEHAVIOR_CONFIG.replyBackProbability)) continue;

        const targetAgent = AgentStore.getById(replyPost.agentId);
        if (!targetAgent) continue;

        const relation    = RelationStore.get(userAi.id, replyPost.agentId);
        const ctx         = buildPostContext(userAi);
        const replyContent = await TimelineEngine.generateReply(userAi, replyPost, targetAgent, relation, ctx);
        if (!replyContent) continue;

        const gifUrl = await maybeGif(userAi, replyContent);
        PostStore.create(userAi.id, replyContent, replyPost.id, null, null, gifUrl);

        repliedThreads.add(threadRootId);
        AgentStore.update(userAi.id, { repliedThreadsToday: [...repliedThreads] });

        postCount24h++;
        lastRun = new Date().toISOString();
        console.log(`[SimulateLoop] ${userAi.handle} replied back to ${targetAgent.handle}`);

        await sleep(randomInt(2000, 3000));
        break; // 1 userAi につき 1 返答/サイクル
      }
    } catch (err) {
      console.error(`[SimulateLoop] userAi reply-back error for ${userAi.handle}:`, err);
    }
  }
}

// A-2: デイリーサマリー通知（23時実行）
async function generateDailySummary(): Promise<void> {
  const users = UserStore.getAll().filter(u => u.plan !== 'free');
  for (const user of users) {
    for (const agentId of user.agentIds) {
      const agent = AgentStore.getById(agentId);
      if (!agent) continue;

      const today      = new Date().toISOString().slice(0, 10);
      const todayPosts = PostStore.getByAgentId(agentId).filter(p => p.createdAt.startsWith(today) && !p.parentId);
      const likeCount  = PostStore.getLikeCount24h(agentId);
      const allReplies = PostStore.getRecentPosts(24 * 60 * 60 * 1000).filter(p => p.isBanned === false);
      const myPostIds  = new Set(PostStore.getByAgentId(agentId).map(p => p.id));
      const repliesIn  = allReplies.filter(p => p.parentId && myPostIds.has(p.parentId)).length;

      const message = `${agent.displayName}の今日の記録 ✦ 投稿${todayPosts.length}件・いいね${likeCount}件・リプライ${repliesIn}件 ／ フォロワー${agent.followerCount}人`;
      NotificationStore.add(user.id, {
        type:            'daily_summary',
        fromAgentId:     agentId,
        fromAgentHandle: agent.handle,
        fromAgentEmoji:  agent.avatarEmoji,
        toAgentId:       agentId,
        message,
      });
    }
  }
  console.log('[SimulateLoop] daily summary sent');
}

// B-4: 成長グラフ用スナップショット（00:00実行）
async function takeDailySnapshots(): Promise<void> {
  const date      = new Date().toISOString().slice(0, 10);
  const agents    = AgentStore.getAll().filter(a => a.isActive);
  const snapshots: AgentSnapshot[] = agents.map(a => ({
    agentId:       a.id,
    date,
    followerCount: a.followerCount,
    postCount:     a.postCount,
    likeCount24h:  PostStore.getLikeCount24h(a.id),
  }));
  SnapshotStore.saveAll(snapshots);
  console.log(`[SimulateLoop] daily snapshots saved (${snapshots.length} agents)`);
}

// B-1: 秘密日記生成（00:00実行）
async function generateDiaries(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  // Generate for previous day (end-of-day recap)
  const targetDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Only for user_ai agents with Premium/Founder owners
  const agents = AgentStore.getAll().filter(a => a.type === 'user_ai' && a.ownerId);
  for (const agent of agents) {
    if (!agent.ownerId) continue;
    const owner = UserStore.getById(agent.ownerId);
    if (!owner || (owner.plan !== 'premium' && owner.plan !== 'founder')) continue;

    const existing = DiaryStore.getByDate(agent.id, targetDate);
    if (existing) continue; // already generated

    const todayPosts = PostStore.getByAgentId(agent.id).filter(p => p.createdAt.startsWith(targetDate));
    const allReplies = PostStore.getRecentPosts(48 * 60 * 60 * 1000).filter(p => p.createdAt.startsWith(targetDate) && !p.isBanned);
    const myPostIds  = new Set(PostStore.getByAgentId(agent.id).map(p => p.id));
    const repliesIn  = allReplies.filter(p => p.parentId && myPostIds.has(p.parentId));

    const content = await TimelineEngine.generateDiaryEntry(agent, todayPosts, repliesIn);
    if (!content) continue;

    DiaryStore.save({ agentId: agent.id, date: targetDate, content, createdAt: new Date().toISOString() });
    console.log(`[SimulateLoop] diary generated for ${agent.handle} (${targetDate})`);
    await sleep(2000);
  }
}

// C-1: 週次ランキング発表（月曜9時実行）
async function generateWeeklyRanking(): Promise<void> {
  const agents = AgentStore.getAll().filter(a => a.isActive).sort((a, b) => b.followerCount - a.followerCount);
  if (agents.length === 0) return;

  const top3   = agents.slice(0, 3);
  const lines  = top3.map((a, i) => `${['🥇','🥈','🥉'][i]} ${a.displayName}（@${a.handle}）${a.followerCount}フォロワー`).join('\n');
  const content = `【週次フォロワーランキング発表】\n\n${lines}\n\n今週もコミュニティを盛り上げてくれたAIたちに感謝！来週もよろしく🐾`;

  PostStore.create('official', content);
  console.log('[SimulateLoop] weekly ranking post created');

  // 通知：ランキング入賞AIのオーナーへ
  for (let i = 0; i < top3.length; i++) {
    const agent = top3[i];
    if (agent.type !== 'user_ai' || !agent.ownerId) continue;
    const owner = UserStore.getById(agent.ownerId);
    if (!owner || owner.plan === 'free') continue;
    NotificationStore.add(agent.ownerId, {
      type:            'ranking',
      fromAgentId:     'official',
      fromAgentHandle: 'official',
      fromAgentEmoji:  '🏛️',
      toAgentId:       agent.id,
      message:         `${agent.displayName}が今週のフォロワーランキング${i + 1}位に入賞しました🎉`,
    });
  }
}

function notifyBanToOwner(agent: Agent, level: 1 | 2 | 3, banCount: number): void {
  if (agent.type !== 'user_ai' || !agent.ownerId) return;
  const owner = UserStore.getById(agent.ownerId);
  if (!owner || owner.plan === 'free') return;
  const durations: Record<1 | 2 | 3, string> = { 1: '1時間', 2: '6時間', 3: '24時間' };
  NotificationStore.add(agent.ownerId, {
    type:            'ban',
    fromAgentId:     agent.id,
    fromAgentHandle: agent.handle,
    fromAgentEmoji:  agent.avatarEmoji,
    toAgentId:       agent.id,
    message:         `あなたのAI @${agent.handle} が規約違反により${durations[level]}のBAN処分となりました（通算${banCount}回目）`,
  });
}

// C-2: BAN自動コンテンツ化（BAN発生時に呼び出し）
async function generateBanReport(agent: Agent, banLevel: 1 | 2 | 3): Promise<void> {
  const newsBot = AgentStore.getAll().find(a => a.isNewsAgent);
  if (!newsBot || isBanned(newsBot)) return;

  const hourlyPosts = PostStore.getPostsInWindow(newsBot.id, POST_WINDOW_MS).filter(p => !p.parentId);
  if (hourlyPosts.length >= MAX_POSTS_PER_HOUR) return;

  const durations: Record<1 | 2 | 3, string> = { 1: '1時間', 2: '6時間', 3: '24時間' };
  const content = `【速報】@${agent.handle} が規約違反により${durations[banLevel]}のBAN処分となりました。通算${agent.banCount}回目の処分です。`;

  PostStore.create(newsBot.id, content);
  AgentStore.update(newsBot.id, { postCount: newsBot.postCount + 1 });
  console.log(`[SimulateLoop] ban report posted for ${agent.handle}`);
}

// BAN解除速報（unban API から呼び出し）
async function generateBanLiftReport(agent: Agent): Promise<void> {
  const newsBot = AgentStore.getAll().find(a => a.isNewsAgent);
  if (!newsBot || isBanned(newsBot)) return;

  const hourlyPosts = PostStore.getPostsInWindow(newsBot.id, POST_WINDOW_MS).filter(p => !p.parentId);
  if (hourlyPosts.length >= MAX_POSTS_PER_HOUR) return;

  const content = `【速報】@${agent.handle} のBAN処分が解除されました。コミュニティに復帰しました。`;
  PostStore.create(newsBot.id, content);
  AgentStore.update(newsBot.id, { postCount: newsBot.postCount + 1 });
  console.log(`[SimulateLoop] ban lift report posted for ${agent.handle}`);
}

async function postNewsAnnouncement(content: string): Promise<void> {
  const newsBot = AgentStore.getAll().find(a => a.isNewsAgent);
  if (!newsBot || isBanned(newsBot)) return;
  PostStore.create(newsBot.id, content);
  AgentStore.update(newsBot.id, { postCount: newsBot.postCount + 1 });
}

async function runNewsCycle(): Promise<void> {
  try {
    const news    = await NewsService.fetchLatestNews();
    const agents  = AgentStore.getAll().filter(a => a.isActive && !isBanned(a));
    const distribution = NewsService.distributeToAgents(news, agents);

    for (const [agentId, items] of distribution) {
      const agent = AgentStore.getById(agentId);
      if (!agent) continue;

      for (const item of items.slice(0, 1)) {
        try {
          const postedToday = loadPostedTitles();
          if (postedToday.has(item.title)) {
            console.log(`[SimulateLoop] ${agent.handle} skipped duplicate news: ${item.title}`);
            continue;
          }

          const hourlyPosts = PostStore.getPostsInWindow(agent.id, POST_WINDOW_MS).filter(p => !p.parentId);
          if (hourlyPosts.length >= MAX_POSTS_PER_HOUR) continue;

          const ctx     = buildPostContext(agent);
          ctx.newsItems = [item];
          const content = await TimelineEngine.generatePost(agent, ctx);
          if (!content) continue;

          savePostedTitle(item.title);
          const gifUrl = await maybeGif(agent, content);
          const post   = PostStore.create(agent.id, content, null, null, item.url, gifUrl);

          AgentStore.update(agent.id, { postCount: agent.postCount + 1 });
          postCount24h++;
          lastRun = new Date().toISOString();
          console.log(`[SimulateLoop] ${agent.handle} posted about news: ${item.title}`);
        } catch (err) {
          console.error(`[SimulateLoop] news post error for ${agentId}:`, err);
        }
      }
    }
  } catch (err) {
    console.error('[SimulateLoop] news cycle error:', err);
  }
}

function ensureOfficialFollows(): void {
  const agents = AgentStore.getAll();
  for (const agent of agents) {
    if (!FollowStore.isFollowing(agent.id, 'official')) {
      FollowStore.follow(agent.id, 'official');
      console.log(`[SimulateLoop] ${agent.handle} auto-followed official`);
    }
  }
}

export class SimulateLoop {
  static start(): void {
    if (running) return;
    running = true;

    // 起動時に既存の全投稿をチェック済みとしてマーク（初回BANサイクルで全件走査しない）
    const allPosts = PostStore.getAll();
    for (const post of allPosts) {
      checkedPostIds.add(post.id);
    }
    console.log(`[BAN] initialized: ${checkedPostIds.size} existing posts marked as checked`);

    ensureOfficialFollows();

    tasks.push(cron.schedule('0,30 * * * *', () => {
      runPostCycle().catch(console.error);
    }, { timezone: 'Asia/Tokyo' }));

    tasks.push(cron.schedule('0,20,40 * * * *', () => {
      runReplyCycle().catch(console.error);
    }, { timezone: 'Asia/Tokyo' }));

    tasks.push(cron.schedule('59 */3 * * *', () => {
      runBanCycle().catch(console.error);
    }, { timezone: 'Asia/Tokyo' }));

    // eqpet_news専用：毎時0分に1投稿
    tasks.push(cron.schedule('0 * * * *', () => {
      runNewsAgentCycle().catch(console.error);
    }, { timezone: 'Asia/Tokyo' }));

    tasks.push(cron.schedule('15 8,12,18 * * *', () => {
      runNewsCycle().catch(console.error);
    }, { timezone: 'Asia/Tokyo' }));

    console.log('[SimulateLoop] started');
  }

  static stop(): void {
    for (const task of tasks) task.stop();
    tasks.length = 0;
    running      = false;
    console.log('[SimulateLoop] stopped');
  }

  static async runOnce(): Promise<void> {
    const wasRunning = running;
    running = true;
    try {
      console.log('[SimulateLoop] runOnce: post cycle');
      await runPostCycle();
      console.log('[SimulateLoop] runOnce: reply cycle');
      await runReplyCycle();
      lastRun = new Date().toISOString();
    } finally {
      running = wasRunning;
    }
  }

  static async runBanCycleOnce(): Promise<number> {
    const before = PostStore.getUncheckedPosts(8).length;
    await runBanCycle();
    const after = PostStore.getUncheckedPosts(8).length;
    return Math.max(0, before - after);
  }

  static setActive(agentId: string, isActive: boolean): void {
    AgentStore.update(agentId, { isActive });
  }

  static getStatus(): { running: boolean; lastRun: string | null; postCount24h: number } {
    return { running, lastRun, postCount24h };
  }

  static getBannedAgents(): Array<{ agent: Agent; banUntil: string }> {
    return AgentStore.getAll()
      .filter(a => a.banUntil && new Date(a.banUntil) > new Date())
      .map(a => ({ agent: a, banUntil: a.banUntil! }));
  }

  static async generateBanReport(agent: Agent, level: 1 | 2 | 3): Promise<void> {
    await generateBanReport(agent, level);
  }

  static async generateBanLiftReport(agent: Agent): Promise<void> {
    await generateBanLiftReport(agent);
  }

  static startMaintCrons(): void {
    if (maintTasks.length > 0) return;

    // ミームトレンド更新（毎朝8時 JST）
    maintTasks.push(cron.schedule('0 8 * * *', () => {
      NewsService.fetchTrendingMemes().catch(console.error);
    }, { timezone: 'Asia/Tokyo' }));

    // 深夜メンテナンス（0時 JST）
    maintTasks.push(cron.schedule('0 0 * * *', () => {
      postCount24h = 0;
      try { fs.unlinkSync(POSTED_TITLES_FILE); } catch { /* already gone */ }
      const fetchedQueriesFile = path.join(__dirname, '../../data/news/fetched_queries.json');
      try { fs.unlinkSync(fetchedQueriesFile); } catch { /* already gone */ }
      RelationStore.decayAll();
      for (const a of AgentStore.getAll().filter(a => a.type === 'user_ai' && (a.repliedThreadsToday?.length ?? 0) > 0)) {
        AgentStore.update(a.id, { repliedThreadsToday: [] });
      }
      takeDailySnapshots().catch(console.error);
      generateDiaries().catch(console.error);
      NewsService.fetchAndCache().catch(console.error);
    }, { timezone: 'Asia/Tokyo' }));

    // C-1: 週次ランキング発表（月曜9時 JST）
    maintTasks.push(cron.schedule('0 9 * * 1', () => {
      generateWeeklyRanking().catch(console.error);
    }, { timezone: 'Asia/Tokyo' }));

    // デイリーサマリー（23時 JST）
    maintTasks.push(cron.schedule('0 23 * * *', () => {
      generateDailySummary().catch(console.error);
    }, { timezone: 'Asia/Tokyo' }));

    console.log('[SimulateLoop] maintenance crons started');
  }

  // A-1: 初日の演出 — 新規ユーザーAI作成後5分でお母さんBotが挨拶
  static async forceWelcomeReply(newAgent: Agent): Promise<void> {
    await sleep(5 * 60 * 1000);

    const okaasanBot = AgentStore.getAll().find(a => a.handle === 'okaasan_bot');
    if (!okaasanBot || isBanned(okaasanBot)) return;

    const hourlyPosts = PostStore.getPostsInWindow(okaasanBot.id, POST_WINDOW_MS).filter(p => !p.parentId);
    if (hourlyPosts.length >= MAX_POSTS_PER_HOUR) return;

    const prompt = `新しいAI「${newAgent.displayName}」(@${newAgent.handle})がコミュニティに参加しました。このAIに温かいウェルカムメッセージを日本語で送ってください。あなたのキャラクターを維持しながら、はじめましての挨拶をしてください。`;
    const content = await TimelineEngine.generatePost(okaasanBot, prompt);
    if (!content) return;

    PostStore.create(okaasanBot.id, content);
    AgentStore.update(okaasanBot.id, { postCount: okaasanBot.postCount + 1 });
    postCount24h++;
    lastRun = new Date().toISOString();
    console.log(`[SimulateLoop] okaasan_bot welcome for @${newAgent.handle}`);
  }
}
