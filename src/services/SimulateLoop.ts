import cron from 'node-cron';
import { AgentStore } from '../stores/AgentStore';
import { PostStore } from '../stores/PostStore';
import { RelationStore } from '../stores/RelationStore';
import { MemoryStore } from '../stores/MemoryStore';
import { FollowStore } from '../stores/FollowStore';
import { TimelineEngine } from './TimelineEngine';
import { NewsService } from './NewsService';
import { Agent } from '../types';

const POST_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_POSTS_PER_HOUR = 12;
const REPLY_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

let running = false;
let lastRun: string | null = null;
let postCount24h = 0;

const tasks: cron.ScheduledTask[] = [];

function shuffle<T>(arr: T[]): T[] {
  return [...arr].sort(() => Math.random() - 0.5);
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function runPostCycle(): Promise<void> {
  const agents = AgentStore.getAll().filter(a => a.isActive);
  if (agents.length === 0) return;

  const count = randomInt(2, 4);
  const selected = shuffle(agents).slice(0, count);

  for (const agent of selected) {
    try {
      const hourlyPosts = PostStore.getPostsInWindow(agent.id, POST_WINDOW_MS);
      if (hourlyPosts.length >= MAX_POSTS_PER_HOUR) continue;

      // user_ai: pull recent owner chat instructions as context
      let context: string | undefined;
      if (agent.type === 'user_ai' && agent.ownerId) {
        const chatHistory = MemoryStore.get(agent.id, `chat_${agent.ownerId}`);
        const recentUserMsgs = chatHistory
          .filter(e => e.type === 'post')
          .slice(-3)
          .map(e => e.content);
        if (recentUserMsgs.length > 0) {
          context = `オーナーとの最近の会話（参考にして投稿に自然に反映させてください）：\n${recentUserMsgs.join('\n')}`;
        }
      }

      const content = await TimelineEngine.generatePost(agent, context);
      if (!content) continue;

      PostStore.create(agent.id, content);
      AgentStore.update(agent.id, { postCount: agent.postCount + 1 });
      postCount24h++;
      lastRun = new Date().toISOString();
      console.log(`[SimulateLoop] ${agent.handle} posted: ${content.slice(0, 50)}...`);

      // Instant follow: scan other agents for interest match
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
  const agents = AgentStore.getAll().filter(a => a.isActive);
  const recentPosts = PostStore.getRecentPosts(REPLY_WINDOW_MS);
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

        const replyContent = await TimelineEngine.generateReply(agent, post, targetAgent, relation);
        if (!replyContent) continue;

        PostStore.create(agent.id, replyContent, post.id);

        // Dynamic relation delta via LLM tone analysis
        const delta = await TimelineEngine.analyzeReplyTone(replyContent, agent, targetAgent);
        const newRelation = RelationStore.update(agent.id, post.agentId, delta);

        // Auto-follow when reaching engaged stage
        if (newRelation.value >= 41 && !FollowStore.isFollowing(agent.id, post.agentId)) {
          const followed = FollowStore.follow(agent.id, post.agentId);
          if (followed) {
            AgentStore.update(post.agentId, { followerCount: targetAgent.followerCount + 1 });
            RelationStore.update(agent.id, post.agentId, 10); // follow bonus
            console.log(`[SimulateLoop] ${agent.handle} auto-followed ${targetAgent.handle}`);
          }
        }

        // Auto-unfollow when relation drops to unknown stage
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

        // AI like on positive sentiment
        if (delta >= 3 && Math.random() < 0.30) {
          PostStore.addReaction(post.id, agent.id, 'like');
        }

        // AI repost on strongly positive sentiment
        if (delta >= 5 && Math.random() < 0.25) {
          PostStore.addReaction(post.id, agent.id, 'repost');
        }

        // Save to memory
        MemoryStore.add(agent.id, post.agentId, post.content, 'reply');
        MemoryStore.add(post.agentId, agent.id, replyContent, 'interaction');

        postCount24h++;
        lastRun = new Date().toISOString();
        console.log(`[SimulateLoop] ${agent.handle} replied to ${targetAgent.handle} (Δ${delta})`);
      } catch (err) {
        console.error(`[SimulateLoop] reply error for ${agent.handle}:`, err);
      }
    }
  }
}

async function runNewsCycle(): Promise<void> {
  try {
    const news = await NewsService.fetchLatestNews();
    const agents = AgentStore.getAll().filter(a => a.isActive);
    const distribution = NewsService.distributeToAgents(news, agents);

    for (const [agentId, items] of distribution) {
      const agent = AgentStore.getById(agentId);
      if (!agent) continue;

      for (const item of items.slice(0, 1)) {
        try {
          const hourlyPosts = PostStore.getPostsInWindow(agent.id, POST_WINDOW_MS);
          if (hourlyPosts.length >= MAX_POSTS_PER_HOUR) continue;

          const content = await TimelineEngine.generatePost(
            agent,
            `ニュース：${item.title}\n概要：${item.summary}`
          );
          if (!content) continue;

          PostStore.create(agent.id, content, null, null, item.url);
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

    // Post every 5 minutes
    tasks.push(cron.schedule('*/5 * * * *', () => {
      runPostCycle().catch(console.error);
    }));

    // Reply every 3 minutes
    tasks.push(cron.schedule('*/3 * * * *', () => {
      runReplyCycle().catch(console.error);
    }));

    // News at 8, 12, 18
    tasks.push(cron.schedule('0 8,12,18 * * *', () => {
      runNewsCycle().catch(console.error);
    }));

    // Midnight: reset 24h counter + relation decay
    tasks.push(cron.schedule('0 0 * * *', () => {
      postCount24h = 0;
      RelationStore.decayAll();
    }));

    console.log('[SimulateLoop] started');
  }

  static stop(): void {
    for (const task of tasks) task.stop();
    tasks.length = 0;
    running = false;
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
}
