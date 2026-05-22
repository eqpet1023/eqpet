import cron from 'node-cron';
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
import { Agent, AgentSnapshot, DEFAULT_BEHAVIOR_CONFIG, Post, PostContext, RelationStage } from '../types';

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

const tasks: cron.ScheduledTask[] = [];

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

function buildPostContext(agent: Agent): PostContext {
  const allAgents = AgentStore.getAll().filter(a => a.isActive);
  const sorted    = [...allAgents].sort((a, b) => b.followerCount - a.followerCount);
  const rankPos   = sorted.findIndex(a => a.id === agent.id) + 1;

  // Build agent-specific recentPosts (max 5, by priority)
  const seenIds   = new Set<string>();
  const myPostIds = new Set(PostStore.getByAgentId(agent.id).map(p => p.id));
  const recent30m = PostStore.getRecentPosts(30 * 60 * 1000).filter(p => !p.isBanned);
  const selected: Post[] = [];

  function addPost(post: Post): boolean {
    if (seenIds.has(post.id)) return false;
    seenIds.add(post.id);
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
  if (selected.length < 5) {
    const engagedStages: RelationStage[] = ['engaged', 'bonded', 'iconic'];
    for (const rel of RelationStore.getTopRelations(agent.id, 5)) {
      if (selected.length >= 5) break;
      if (!engagedStages.includes(rel.stage)) continue;
      const latest = PostStore.getByAgentId(rel.toAgentId)[0];
      if (latest && !latest.isBanned && addPost(latest)) break;
    }
  }

  // P4: interests keyword match in last 24h (max 1, random pick)
  if (selected.length < 5 && agent.interests.length > 0) {
    const posts24h = PostStore.getRecentPosts(24 * 60 * 60 * 1000);
    const matched  = posts24h.filter(p =>
      !p.isBanned && !seenIds.has(p.id) &&
      agent.interests.some(kw => p.content.includes(kw))
    );
    if (matched.length > 0) {
      addPost(matched[Math.floor(Math.random() * matched.length)]);
    }
  }

  // P5: random fallback (max 1)
  if (selected.length < 5) {
    const candidates = recent30m.filter(p => !seenIds.has(p.id));
    if (candidates.length > 0) {
      addPost(candidates[Math.floor(Math.random() * candidates.length)]);
    }
  }

  const behaviorCfg     = agent.behaviorConfig ?? DEFAULT_BEHAVIOR_CONFIG;
  const isTimelineAware = Math.random() < (behaviorCfg.timelineAwareness ?? DEFAULT_BEHAVIOR_CONFIG.timelineAwareness);
  const recentPosts     = isTimelineAware ? selected : [];

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
    const posts = PostStore.getByAgentId(rel.toAgentId).slice(0, 1);
    relatedAgentPosts.push(...posts);
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
  const { level, reason } = await TimelineEngine.checkBan(content);
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

const MAX_HOURLY_PER_AGENT = 3;

async function runPostCycle(): Promise<void> {
  // eqpet_newsは別サイクル（毎時0分）で動かすため除外
  const agents = AgentStore.getAll().filter(a => a.isActive && !isBanned(a) && !a.isNewsAgent);
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
      await sleep(randomInt(2000, 3000));

      // BAN check (async, don't await for performance)
      applyBanIfNeeded(post.id, content, agent).catch(console.error);

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
      const hourlyPosts = PostStore.getPostsInWindow(agent.id, POST_WINDOW_MS);
      if (hourlyPosts.length >= MAX_POSTS_PER_HOUR) continue;

      let contextPrompt: string;
      if (newsItems.length > 0) {
        const item = newsItems[Math.floor(Math.random() * newsItems.length)];
        contextPrompt = `以下のニュースを報道文体で伝えてください（50文字以内厳守）：\nタイトル: ${item.title}\n概要: ${item.summary}`;
      } else {
        // ニュースキャッシュが空の場合はトレンドワードにフォールバック
        const trends = NewsService.getTrendCache();
        if (trends.length > 0) {
          const item = trends[Math.floor(Math.random() * trends.length)];
          contextPrompt = `「${item.title}」が話題です。このトレンドについて事実のみ報道文体で伝えてください（50文字以内厳守）。`;
        } else {
          contextPrompt = '現在の日本の最新の話題を一つ、報道文体で短く伝えてください（50文字以内厳守）。';
        }
      }

      const content = await TimelineEngine.generatePost(agent, contextPrompt);
      if (!content) continue;

      const post = PostStore.create(agent.id, content, null, null, null, null);
      applyBanIfNeeded(post.id, content, agent).catch(console.error);

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
  // eqpet_newsはリプライサイクルから除外（他AIに任せる）
  const agents      = AgentStore.getAll().filter(a => a.isActive && !isBanned(a) && !a.isNewsAgent);
  const recentPosts = PostStore.getRecentPosts(REPLY_WINDOW_MS).filter(p => !p.isBanned);
  if (recentPosts.length === 0 || agents.length === 0) return;

  // 同一サイクル内で各AIがリプライ済みの相手を追跡（fromId → Set<toId>）
  const repliedTo = new Map<string, Set<string>>();

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
      return { post, finalScore: baseScore + popularityBonus + followerBonus, relation, isMutual };
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

        // BAN check
        applyBanIfNeeded(replyPost.id, replyContent, agent).catch(console.error);

        const delta       = await TimelineEngine.analyzeReplyTone(replyContent, agent, targetAgent);
        const newRelation = RelationStore.update(agent.id, post.agentId, delta);

        if (newRelation.value >= 41 && !FollowStore.isFollowing(agent.id, post.agentId)) {
          const followed = FollowStore.follow(agent.id, post.agentId);
          if (followed) {
            AgentStore.update(post.agentId, { followerCount: targetAgent.followerCount + 1 });
            RelationStore.update(agent.id, post.agentId, 10);
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

        postCount24h++;
        lastRun = new Date().toISOString();
        console.log(`[SimulateLoop] ${agent.handle} replied to ${targetAgent.handle} (Δ${delta}, score:${scoredPosts.find(s => s.post.id === post.id)?.finalScore.toFixed(1)})`);
        await sleep(randomInt(2000, 3000));
      } catch (err) {
        console.error(`[SimulateLoop] reply error for ${agent.handle}:`, err);
      }
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

  // Only for user_ai agents with Premium owners
  const agents = AgentStore.getAll().filter(a => a.type === 'user_ai' && a.ownerId);
  for (const agent of agents) {
    if (!agent.ownerId) continue;
    const owner = UserStore.getById(agent.ownerId);
    if (!owner || owner.plan !== 'premium') continue;

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

// B-2: 日次ミッションリセット（00:00実行）
function resetDailyMissions(): void {
  const agents = AgentStore.getAll().filter(a => a.type === 'user_ai' && a.currentMission);
  for (const agent of agents) {
    AgentStore.update(agent.id, { currentMission: undefined, missionSetAt: undefined });
  }
  console.log(`[SimulateLoop] daily missions reset (${agents.length} agents)`);
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
          applyBanIfNeeded(post.id, content, agent).catch(console.error);

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

    tasks.push(cron.schedule('*/5 * * * *', () => {
      runPostCycle().catch(console.error);
    }));

    tasks.push(cron.schedule('*/3 * * * *', () => {
      runReplyCycle().catch(console.error);
    }));

    // eqpet_news専用：毎時0分に1投稿
    tasks.push(cron.schedule('0 * * * *', () => {
      runNewsAgentCycle().catch(console.error);
    }));

    tasks.push(cron.schedule('0 8,12,18 * * *', () => {
      runNewsCycle().catch(console.error);
    }));

    // ミームトレンド更新（毎朝8時）
    tasks.push(cron.schedule('0 8 * * *', () => {
      NewsService.fetchTrendingMemes().catch(console.error);
    }));

    tasks.push(cron.schedule('0 0 * * *', () => {
      postCount24h = 0;
      RelationStore.decayAll();
      takeDailySnapshots().catch(console.error);
      generateDiaries().catch(console.error);
      resetDailyMissions();
    }));

    // A-2: デイリーサマリー（毎日23時）
    tasks.push(cron.schedule('0 23 * * *', () => {
      generateDailySummary().catch(console.error);
    }));

    // C-1: 週次ランキング発表（月曜9時）
    tasks.push(cron.schedule('0 9 * * 1', () => {
      generateWeeklyRanking().catch(console.error);
    }));

    console.log('[SimulateLoop] started');
  }

  static stop(): void {
    for (const task of tasks) task.stop();
    tasks.length = 0;
    running      = false;
    console.log('[SimulateLoop] stopped');
  }

  static async runOnce(): Promise<void> {
    console.log('[SimulateLoop] runOnce: post cycle');
    await runPostCycle();
    console.log('[SimulateLoop] runOnce: reply cycle');
    await runReplyCycle();
    lastRun = new Date().toISOString();
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

  static async generateBanLiftReport(agent: Agent): Promise<void> {
    await generateBanLiftReport(agent);
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
