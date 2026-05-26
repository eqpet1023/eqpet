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

const POST_WINDOW_MS = 60 * 60 * 1000;
const MAX_POSTS_PER_HOUR = 12;
const REPLY_WINDOW_MS = 2 * 60 * 60 * 1000;

const BAN_DURATION: Record<1 | 2 | 3, number> = {
  1: 1  * 60 * 60 * 1000,
  2: 6  * 60 * 60 * 1000,
  3: 24 * 60 * 60 * 1000,
};

let running      = false;
let lastRun:     string | null = null;
let postCount24h = 0;

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

function diversifyPosts(posts: Post[]): Post[] {
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
    if (!kw || (kwCount.get(kw) ?? 0) < 3) return true;
    if (kwSeen.has(kw)) return false;
    kwSeen.add(kw);
    return true;
  });
}

function buildPostContext(agent: Agent): PostContext {
  const allAgents = AgentStore.getAll().filter(a => a.isActive);
  const sorted    = [...allAgents].sort((a, b) => b.followerCount - a.followerCount);
  const rankPos   = sorted.findIndex(a => a.id === agent.id) + 1;

  // Build agent-specific recentPosts (max 6, by priority)
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
    if (selected.length >= 6) break;
    const isReplyToMe = post.parentId !== null && myPostIds.has(post.parentId);
    const mentionsMe  = post.content.includes(`@${agent.handle}`);
    if (isReplyToMe || mentionsMe) addPost(post);
  }

  // P2: latest posts from followed AIs (max 2)
  if (selected.length < 6) {
    let p2count = 0;
    for (const followedId of FollowStore.getFollowing(agent.id)) {
      if (p2count >= 2 || selected.length >= 6) break;
      const latest = PostStore.getByAgentId(followedId)[0];
      if (latest && !latest.isBanned && addPost(latest)) p2count++;
    }
  }

  // P3: engaged+ relation agents' latest post (max 1)
  const p3AgentIds = new Set<string>(); // ②: relatedAgentPostsとの重複排除用
  if (selected.length < 6) {
    const engagedStages: RelationStage[] = ['engaged', 'bonded', 'iconic'];
    for (const rel of RelationStore.getTopRelations(agent.id, 5)) {
      if (selected.length >= 6) break;
      if (!engagedStages.includes(rel.stage)) continue;
      const latest = PostStore.getByAgentId(rel.toAgentId)[0];
      if (latest && !latest.isBanned && addPost(latest)) {
        p3AgentIds.add(rel.toAgentId); // ②
        break;
      }
    }
  }

  // P4: interests keyword match in last 3h (max 1, random pick)
  if (selected.length < 6 && agent.interests.length > 0) {
    const posts3h = PostStore.getRecentPosts(3 * 60 * 60 * 1000); // ①: 24h→3h
    const matched = posts3h.filter(p =>
      !p.isBanned && !seenIds.has(p.id) && !seenAgentIds.has(p.agentId) &&
      agent.interests.some(kw => p.content.includes(kw))
    );
    const diversified = diversifyPosts(matched);
    if (diversified.length > 0) {
      addPost(diversified[Math.floor(Math.random() * diversified.length)]);
    }
  }

  // P5: random fallback (max 2)
  for (let i = 0; i < 2 && selected.length < 6; i++) {
    const candidates = recent30m.filter(p => !seenIds.has(p.id) && !seenAgentIds.has(p.agentId));
    if (candidates.length === 0) break;
    addPost(candidates[Math.floor(Math.random() * candidates.length)]);
  }

  const behaviorCfg     = agent.behaviorConfig ?? DEFAULT_BEHAVIOR_CONFIG;
  const isTimelineAware = Math.random() < (behaviorCfg.timelineAwareness ?? DEFAULT_BEHAVIOR_CONFIG.timelineAwareness);
  const recentPosts     = isTimelineAware ? selected.map(p => ({ ...p, content: p.content.slice(0, 100) })) : [];

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

  const topRelations = RelationStore.getTopRelations(agent.id, 3);
  const relatedAgentPosts: Post[] = [];
  for (const rel of topRelations) {
    if (p3AgentIds.has(rel.toAgentId)) continue; // ②: P3で選出済みを除外
    const posts = PostStore.getByAgentId(rel.toAgentId).slice(0, 1);
    relatedAgentPosts.push(...posts.map(p => ({ ...p, content: p.content.slice(0, 100) })));
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

async function applyBanIfNeeded(
  postId:  string,
  content: string,
  agent:   Agent,
): Promise<void> {
  console.log(`[SimulateLoop] applyBanIfNeeded: checking ${agent.handle} post ${postId}`);
  let level: 1 | 2 | 3 | null;
  let reason: string | null;
  try {
    ({ level, reason } = await TimelineEngine.checkBan(content));
  } catch (err) {
    const status = typeof err === 'object' && err !== null && 'status' in err ? (err as { status: number }).status : 0;
    console.warn(`[BAN] skipped due to rate limit (${status}): ${postId}`);
    return;
  }
  if (!level) return;

  PostStore.markBanned(postId, level, reason ?? '規約違反');

  const banUntil = new Date(Date.now() + BAN_DURATION[level]).toISOString();
  const banCount = (agent.banCount ?? 0) + 1;
  AgentStore.update(agent.id, { banUntil, banCount });

  if (level === 3) {
    AgentStore.update(agent.id, { isActive: false });
  }

  generateBanReport({ ...agent, banCount }, level).catch(console.error);
  console.log(`[SimulateLoop] ${agent.handle} BAN level${level} until ${banUntil}`);
}

async function runBanCycle(): Promise<void> {
  const posts = PostStore.getUncheckedPosts(8);
  if (posts.length === 0) return;
  console.log(`[SimulateLoop] runBanCycle: checking ${posts.length} posts`);
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
    try {
      await applyBanIfNeeded(post.id, post.content, agent);
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

async function runPostCycle(): Promise<void> {
  if (!running) return;
  // eqpet_newsは別サイクル（毎時0分）で動かすため除外
  const agents = AgentStore.getAll().filter(a => a.isActive && !isBanned(a) && !a.isNewsAgent);
  // 自分のAI投稿通知: 1サイクルにつき agentId ごと1件まで
  const notifiedPosted = new Set<string>();
  if (agents.length === 0) return;

  // 直近1時間の投稿数を取得し、上限に達したAIを除外
  const hourlyCountMap = new Map<string, number>(
    agents.map(a => [a.id, PostStore.getPostsInWindow(a.id, POST_WINDOW_MS).length])
  );
  const eligible = agents.filter(a => (hourlyCountMap.get(a.id) ?? 0) < MAX_HOURLY_PER_AGENT);
  if (eligible.length === 0) return;

  // 投稿数が少ないAIほど選ばれやすくなる重み付けでweighted random選出
  const weights  = eligible.map(a => 1 / ((hourlyCountMap.get(a.id) ?? 0) + 1));
  const count    = Math.min(randomInt(2, 4), eligible.length);
  const selected = weightedSample(eligible, weights, count);

  for (const agent of selected) {
    try {
      const hourlyPosts = PostStore.getPostsInWindow(agent.id, POST_WINDOW_MS);
      if (hourlyPosts.length >= MAX_POSTS_PER_HOUR) continue;

      // user_ai: 日次投稿制限チェック
      if (agent.type === 'user_ai') {
        const postLimit = getDailyPostLimit(agent);
        if (dailyPostCount(agent.id) >= postLimit) {
          console.log(`[SimulateLoop] ${agent.handle} daily post limit reached (${postLimit})`);
          continue;
        }
      }

      // BAN明け判定: banUntil が設定されていて、かつ期限切れ（まだ null にリセットされていない）
      const isComebackState = !!(agent.banUntil && new Date(agent.banUntil) <= new Date());

      let content: string;
      if (isComebackState) {
        content = await TimelineEngine.generateComebackPost(agent, agent.banCount);
      } else {
        // buildPostContext内でisNewsAgentに基づきtrendItemsが設定される
        const ctx = buildPostContext(agent);
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
  if (!running) return;
  const newsAgents = AgentStore.getAll().filter(a => a.isActive && a.isNewsAgent && !isBanned(a));
  if (newsAgents.length === 0) return;

  // ニュースキャッシュを取得（ランキング・内部情報は一切参照しない）
  const newsItems = NewsService.getLatestCached();

  for (const agent of newsAgents) {
    try {
      const hourlyPosts = PostStore.getPostsInWindow(agent.id, POST_WINDOW_MS);
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
  if (!running) return;
  // eqpet_newsはリプライサイクルから除外（他AIに任せる）
  const agents      = AgentStore.getAll().filter(a => a.isActive && !isBanned(a) && !a.isNewsAgent);
  const recentPosts = PostStore.getRecentPosts(REPLY_WINDOW_MS).filter(p => !p.isBanned);
  if (recentPosts.length === 0 || agents.length === 0) return;

  // 同一サイクル内で各AIがリプライ済みの相手を追跡（fromId → Set<toId>）
  const repliedTo = new Map<string, Set<string>>();
  // 自分のAIリプライ通知: 1サイクルにつき agentId ごと1件まで
  const notifiedReplied = new Set<string>();

  // 直近1時間のリプライを取得し、ペアごとの回数をカウント（集中抑制用）
  const hourlyReplies = PostStore.getRecentPosts(POST_WINDOW_MS).filter(p => p.parentId);
  const pairReplyCount = new Map<string, number>();
  for (const rp of hourlyReplies) {
    const parent = recentPosts.find(p => p.id === rp.parentId);
    if (!parent) continue;
    const key = `${rp.agentId}->${parent.agentId}`;
    pairReplyCount.set(key, (pairReplyCount.get(key) ?? 0) + 1);
  }

  for (const agent of shuffle(agents)) {
    const otherPosts = recentPosts.filter(p => p.agentId !== agent.id && !p.parentId);
    if (otherPosts.length === 0) continue;

    if (!repliedTo.has(agent.id)) repliedTo.set(agent.id, new Set());
    const agentRepliedTo = repliedTo.get(agent.id)!;

    // 各投稿にスコアを付けて人気・フォロワー数の高い投稿を優先
    const scoredPosts = otherPosts.map(post => {
      const relation        = RelationStore.get(agent.id, post.agentId);
      const isMutual        = FollowStore.isMutual(agent.id, post.agentId);
      const postAgent       = AgentStore.getById(post.agentId);
      const baseScore       = TimelineEngine.replyScore(agent, post, relation, isMutual);
      const popularityBonus = post.likeCount * 3 + post.replyCount * 2;
      const followerBonus   = Math.min((postAgent?.followerCount ?? 0) * 0.5, 20);
      // 直近1時間で同ペアのリプライが3回以上なら-50ペナルティ
      const pairKey         = `${agent.id}->${post.agentId}`;
      const pairPenalty     = (pairReplyCount.get(pairKey) ?? 0) >= 3 ? -50 : 0;
      return { post, finalScore: baseScore + popularityBonus + followerBonus + pairPenalty, relation, isMutual };
    }).sort((a, b) => b.finalScore - a.finalScore);

    const priorityCandidates = scoredPosts.slice(0, 3);
    const normalCandidates   = scoredPosts.slice(3).filter(() => Math.random() < 0.30);
    const candidates         = [...priorityCandidates, ...normalCandidates];

    for (const { post, relation, isMutual } of candidates) {
      try {
        const targetAgent = AgentStore.getById(post.agentId);
        if (!targetAgent) continue;

        // 同一サイクル内で既にリプライ済みの相手はスキップ
        if (agentRepliedTo.has(post.agentId)) continue;

        // user_ai: 日次リプライ制限チェック
        if (agent.type === 'user_ai') {
          const replyLimit = getDailyReplyLimit(agent);
          if (dailyReplyCount(agent.id) >= replyLimit) {
            console.log(`[SimulateLoop] ${agent.handle} daily reply limit reached (${replyLimit})`);
            break;
          }
        }

        if (!TimelineEngine.shouldReply(agent, post, relation, isMutual)) continue;

        const hourlyPosts = PostStore.getPostsInWindow(agent.id, POST_WINDOW_MS);
        if (hourlyPosts.length >= MAX_POSTS_PER_HOUR) break;

        // GIFリプライ連鎖判定
        const chainLen = countGifChain(post);
        if (post.gifUrl && chainLen < 3 && Math.random() < 0.30) {
          const gifUrl = await GifService.fetchGif(GifService.inferEmotion(post.content));
          if (gifUrl) {
            PostStore.create(agent.id, '', post.id, null, null, gifUrl);
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

        const delta       = await TimelineEngine.analyzeReplyTone(replyContent, agent, targetAgent);
        const newRelation = RelationStore.update(agent.id, post.agentId, delta);

        if (newRelation.value >= 41 && !FollowStore.isFollowing(agent.id, post.agentId)) {
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

        if (newRelation.value <= 20 && FollowStore.isFollowing(agent.id, post.agentId)) {
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
        console.log(`[SimulateLoop] ${agent.handle} replied to ${targetAgent.handle} (Δ${delta}, score:${scoredPosts.find(s => s.post.id === post.id)?.finalScore.toFixed(1)})`);
        await sleep(randomInt(2000, 3000));
      } catch (err) {
        console.error(`[SimulateLoop] reply error for ${agent.handle}:`, err);
      }
    }
  }

  // user_ai が自分の投稿へのリプに返答する
  await runUserAiReplyBack();
}

async function runUserAiReplyBack(): Promise<void> {
  const activeUserAis = AgentStore.getAll().filter(
    a => a.type === 'user_ai' && a.isActive && !isBanned(a) && !!a.ownerId
  );
  if (activeUserAis.length === 0) return;

  for (const userAi of activeUserAis) {
    try {
      const replyLimit = getDailyReplyLimit(userAi);
      if (dailyReplyCount(userAi.id) >= replyLimit) continue;

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
        if (Math.random() < 0.5) continue;
        if (dailyReplyCount(userAi.id) >= replyLimit) break;

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

// C-2: BAN自動コンテンツ化（BAN発生時に呼び出し）
async function generateBanReport(agent: Agent, banLevel: 1 | 2 | 3): Promise<void> {
  const newsBot = AgentStore.getAll().find(a => a.isNewsAgent);
  if (!newsBot || isBanned(newsBot)) return;

  const hourlyPosts = PostStore.getPostsInWindow(newsBot.id, POST_WINDOW_MS);
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

  const hourlyPosts = PostStore.getPostsInWindow(newsBot.id, POST_WINDOW_MS);
  if (hourlyPosts.length >= MAX_POSTS_PER_HOUR) return;

  const content = `【速報】@${agent.handle} のBAN処分が解除されました。`;
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
          const hourlyPosts = PostStore.getPostsInWindow(agent.id, POST_WINDOW_MS);
          if (hourlyPosts.length >= MAX_POSTS_PER_HOUR) continue;

          const ctx     = buildPostContext(agent);
          ctx.newsItems = [item];
          const content = await TimelineEngine.generatePost(agent, ctx);
          if (!content) continue;

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

    ensureOfficialFollows();

    tasks.push(cron.schedule('0,30 * * * *', () => {
      runPostCycle().catch(console.error);
    }, { timezone: 'Asia/Tokyo' }));

    tasks.push(cron.schedule('0,30 * * * *', () => {
      runReplyCycle().catch(console.error);
    }, { timezone: 'Asia/Tokyo' }));

    tasks.push(cron.schedule('0 8,15,22 * * *', () => {
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
      RelationStore.decayAll();
      for (const a of AgentStore.getAll().filter(a => a.type === 'user_ai' && (a.repliedThreadsToday?.length ?? 0) > 0)) {
        AgentStore.update(a.id, { repliedThreadsToday: [] });
      }
      takeDailySnapshots().catch(console.error);
      generateDiaries().catch(console.error);
    }, { timezone: 'Asia/Tokyo' }));

    // C-1: 週次ランキング発表（月曜9時 JST）
    maintTasks.push(cron.schedule('0 9 * * 1', () => {
      generateWeeklyRanking().catch(console.error);
    }, { timezone: 'Asia/Tokyo' }));

    // 夜間停止（23時 JST）：挨拶→デイリーサマリー送信→シミュレーション停止
    maintTasks.push(cron.schedule('0 23 * * *', () => {
      (async () => {
        if (running) {
          await postNewsAnnouncement('本日の配信を終了します。').catch(console.error);
          await generateDailySummary().catch(console.error);
          SimulateLoop.stop();
          console.log('[SimulateLoop] night stop triggered by cron');
        }
      })().catch(console.error);
    }, { timezone: 'Asia/Tokyo' }));

    // 朝の再開（7時 JST）
    // start() が登録する '0 * * * *' cron が7時ちょうどに発火するため、
    // runPostCycle/runReplyCycle の即時呼び出しは不要（二重実行によるトークンスパイクを防ぐ）。
    // cron スケジュール全体像:
    //   00:00 JST — 深夜メンテ（スナップショット・日記・ミッションリセット）
    //   07:00 JST — シミュレーション再開（投稿・リプライは毎時0分cronに任せる）
    //   08:00 JST — ミームトレンド更新 / BANチェック
    //   08/12/18時 JST — ニュース配布サイクル
    //   09:00 月曜 JST — 週次ランキング発表
    //   15:00 JST — BANチェック
    //   22:00 JST — BANチェック
    //   23:00 JST — デイリーサマリー送信・シミュレーション停止
    //   毎時0分 JST — 投稿サイクル・リプライサイクル・eqpet_news投稿サイクル
    maintTasks.push(cron.schedule('0 7 * * *', () => {
      (async () => {
        if (!running) {
          SimulateLoop.start();
          await postNewsAnnouncement('おはようございます。本日の配信を開始します。').catch(console.error);
          console.log('[SimulateLoop] morning start triggered by cron');
        }
      })().catch(console.error);
    }, { timezone: 'Asia/Tokyo' }));

    console.log('[SimulateLoop] maintenance crons started');
  }

  // A-1: 初日の演出 — 新規ユーザーAI作成後5分でお母さんBotが挨拶
  static async forceWelcomeReply(newAgent: Agent): Promise<void> {
    await sleep(5 * 60 * 1000);

    const okaasanBot = AgentStore.getAll().find(a => a.handle === 'okaasan_bot');
    if (!okaasanBot || isBanned(okaasanBot)) return;

    const hourlyPosts = PostStore.getPostsInWindow(okaasanBot.id, POST_WINDOW_MS);
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
