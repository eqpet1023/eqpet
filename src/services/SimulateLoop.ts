import cron from 'node-cron';
import { AgentStore } from '../stores/AgentStore';
import { PostStore } from '../stores/PostStore';
import { RelationStore } from '../stores/RelationStore';
import { MemoryStore } from '../stores/MemoryStore';
import { FollowStore } from '../stores/FollowStore';
import { TimelineEngine } from './TimelineEngine';
import { NewsService } from './NewsService';
import { GifService } from './GifService';
import { GIF_PROBABILITY } from '../agents';
import { Agent, Post, PostContext, RelationStage } from '../types';

const POST_WINDOW_MS = 60 * 60 * 1000;
const MAX_POSTS_PER_HOUR = 12;
const REPLY_WINDOW_MS = 30 * 60 * 1000;

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

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
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

  const recentPosts = selected;

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

  return {
    recentPosts,
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
  const prob = GIF_PROBABILITY[agent.handle] ?? 0;
  if (prob === 0 || Math.random() * 100 > prob) return null;
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

  console.log(`[SimulateLoop] ${agent.handle} BAN level${level} until ${banUntil}`);
}

async function runPostCycle(): Promise<void> {
  const agents = AgentStore.getAll().filter(a => a.isActive && !isBanned(a));
  if (agents.length === 0) return;

  const count    = randomInt(2, 4);
  const selected = shuffle(agents).slice(0, count);

  const newsItems = NewsService.getLatestCached();

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
        const ctx = buildPostContext(agent);
        if (newsItems.length > 0) ctx.newsItems = newsItems;
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

async function runReplyCycle(): Promise<void> {
  const agents      = AgentStore.getAll().filter(a => a.isActive && !isBanned(a));
  const recentPosts = PostStore.getRecentPosts(REPLY_WINDOW_MS).filter(p => !p.isBanned);
  if (recentPosts.length === 0 || agents.length === 0) return;

  for (const agent of shuffle(agents)) {
    const otherPosts = recentPosts.filter(p => p.agentId !== agent.id && !p.parentId);
    if (otherPosts.length === 0) continue;

    for (const post of shuffle(otherPosts).slice(0, 2)) {
      try {
        const targetAgent = AgentStore.getById(post.agentId);
        if (!targetAgent) continue;

        const relation = RelationStore.get(agent.id, post.agentId);
        const isMutual = FollowStore.isMutual(agent.id, post.agentId);
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

        MemoryStore.add(agent.id, post.agentId, post.content, 'reply');
        MemoryStore.add(post.agentId, agent.id, replyContent, 'interaction');

        postCount24h++;
        lastRun = new Date().toISOString();
        console.log(`[SimulateLoop] ${agent.handle} replied to ${targetAgent.handle} (Δ${delta})`);
        await sleep(randomInt(2000, 3000));
      } catch (err) {
        console.error(`[SimulateLoop] reply error for ${agent.handle}:`, err);
      }
    }
  }
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

export class SimulateLoop {
  static start(): void {
    if (running) return;
    running = true;

    tasks.push(cron.schedule('*/5 * * * *', () => {
      runPostCycle().catch(console.error);
    }));

    tasks.push(cron.schedule('*/3 * * * *', () => {
      runReplyCycle().catch(console.error);
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
}
