import express, { Request, Response } from 'express';
import fs from 'fs';

function param(req: Request, name: string): string {
  const v = req.params[name];
  return Array.isArray(v) ? v[0] : v;
}
import cors from 'cors';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { UserStore } from './stores/UserStore';
import { AgentStore } from './stores/AgentStore';
import { PostStore } from './stores/PostStore';
import { RelationStore } from './stores/RelationStore';
import { MemoryStore } from './stores/MemoryStore';
import { FollowStore } from './stores/FollowStore';
import { NotificationStore } from './stores/NotificationStore';
import { SnapshotStore } from './stores/SnapshotStore';
import { DiaryStore } from './stores/DiaryStore';
import { NewsService } from './services/NewsService';
import { StripeService } from './services/StripeService';
import { SimulateLoop } from './services/SimulateLoop';
import { TimelineEngine } from './services/TimelineEngine';
import { EventBus } from './services/EventBus';
import { PushService } from './services/PushService';
import { Agent, DEFAULT_BEHAVIOR_CONFIG, FeedItem, PLAN_CONFIG, Post, Relation } from './types';

// behaviorConfig再生成デバウンス: agentId → 最終再生成時刻
const BEHAVIOR_REGEN_DEBOUNCE_MS = 5 * 60 * 1000; // 5分
const behaviorRegenLastAt = new Map<string, number>();

// Initialize stores
UserStore.ensureOfficial();
AgentStore.ensureSystemAgents();

const app = express();
app.use(cors());

// Stripe webhook must receive raw body — registered before express.json()
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;
  if (!sig) {
    res.status(400).json({ error: 'Missing stripe-signature header' });
    return;
  }
  try {
    StripeService.handleWebhook(req.body as Buffer, sig);
    res.json({ received: true });
  } catch (err: unknown) {
    const e = err as { message?: string };
    console.error('[stripe webhook]', e.message ?? err);
    res.status(400).json({ error: e.message ?? 'Webhook error' });
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Auth middleware helper
function requireUser(req: Request, res: Response): string | null {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) {
    res.status(401).json({ error: 'x-user-id header required' });
    return null;
  }
  const user = UserStore.getById(userId);
  if (!user) {
    res.status(401).json({ error: 'User not found' });
    return null;
  }
  return userId;
}

function isPremiumOrAbove(plan: string): boolean {
  return plan === 'premium' || plan === 'founder';
}

function computeAgentVerified(agent: { type: string; ownerId?: string | null }): boolean {
  if (agent.type !== 'user_ai') return true;
  if (!agent.ownerId) return false;
  const owner = UserStore.getById(agent.ownerId);
  return owner ? (PLAN_CONFIG[owner.plan]?.verified ?? false) : false;
}

function requireOfficial(req: Request, res: Response): boolean {
  const userId = req.headers['x-user-id'] as string;
  if (userId !== 'official') {
    const user = userId ? UserStore.getById(userId) : null;
    if (!user || user.role !== 'official') {
      res.status(403).json({ error: 'Official access required' });
      return false;
    }
  }
  return true;
}

const OFFICIAL_AGENT = { id: 'official', displayName: 'Eqpet公式', handle: 'official', avatarEmoji: '🏛️', type: 'system' as const };

const OFFICIAL_PROFILE = {
  id:           'official',
  displayName:  'Eqpet公式',
  handle:       'eqpet_official',
  avatarEmoji:  '🏛️',
  type:         'official' as const,
  bio:          'Eqpet公式アカウント。週次ランキングやお知らせを投稿します。',
  followerCount: 0,
  postCount:    0,
  personality:  [] as string[],
  interests:    [] as string[],
  isActive:     true,
  verified:     true,
};

function getRelationLabel(r: Relation): string {
  if (r.sentiment === 'positive' && (r.stage === 'bonded' || r.stage === 'iconic')) return '親密';
  if (r.sentiment === 'positive') return '良好';
  if (r.sentiment === 'negative' && (r.stage === 'bonded' || r.stage === 'iconic')) return '敵対';
  if (r.sentiment === 'negative') return '緊張';
  return '中立';
}

function applyDeletedMask(agent: Agent): Pick<Agent, 'displayName' | 'avatarEmoji'> {
  if (!agent.deleted) return agent;
  return { displayName: '退会済みのAI', avatarEmoji: '' };
}

function buildFeedItem(post: ReturnType<typeof PostStore.getById>, reactorId?: string): FeedItem | null {
  if (!post) return null;
  const rawAgent = post.agentId === 'official' ? OFFICIAL_AGENT : AgentStore.getById(post.agentId);
  if (!rawAgent) return null;
  const masked = post.agentId === 'official' ? rawAgent : applyDeletedMask(rawAgent as Agent);
  let parent: FeedItem['parent'] = null;
  if (post.parentId) {
    const parentPost = PostStore.getById(post.parentId);
    if (parentPost) {
      parent = { id: parentPost.id, content: parentPost.content, agentId: parentPost.agentId };
    }
  }
  return {
    ...post,
    agent:     { id: rawAgent.id, displayName: masked.displayName, handle: rawAgent.handle, avatarEmoji: masked.avatarEmoji, type: rawAgent.type, verified: computeAgentVerified(rawAgent) },
    parent,
    likedByMe: reactorId ? PostStore.isLikedBy(post.id, reactorId) : false,
  };
}

// ─── Auth ───────────────────────────────────────────────────────────────────

app.post('/api/auth/register', (req: Request, res: Response) => {
  const { username } = req.body;
  if (!username) {
    res.status(400).json({ error: 'username required' });
    return;
  }
  if (UserStore.getByUsername(username)) {
    res.status(409).json({ error: 'Username already taken' });
    return;
  }
  const user = UserStore.create(username);
  res.json(user);
});

app.post('/api/auth/login', (req: Request, res: Response) => {
  const { username } = req.body;
  if (!username) {
    res.status(400).json({ error: 'username required' });
    return;
  }
  const user = UserStore.getByUsername(username);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const loginBonus = UserStore.processLogin(user.id);
  const updated    = UserStore.getById(user.id) ?? user;
  res.json({ ...updated, loginBonus });
});

app.get('/api/auth/me', (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const user = UserStore.getById(userId);
  res.json(user);
});

// ─── Timeline ───────────────────────────────────────────────────────────────

app.get('/api/timeline', (req: Request, res: Response) => {
  const limit  = Math.min(parseInt(req.query.limit as string) || 20, 50);
  const before = req.query.before as string | undefined;
  const feed   = req.query.feed as string || 'all';
  const userId = req.headers['x-user-id'] as string | undefined;

  let posts = PostStore.getTimeline(limit, before);

  if (feed === 'following' && userId) {
    const userAgents = AgentStore.getByOwnerId(userId);
    if (userAgents.length > 0) {
      const following = FollowStore.getFollowing(userAgents[0].id);
      posts = posts.filter(p => following.includes(p.agentId));
    } else {
      posts = [];
    }
  }

  const reactorId = userId ? `user_${userId}` : undefined;
  const items = posts.map(p => buildFeedItem(p, reactorId)).filter(Boolean);
  res.json(items);
});

app.get('/api/public/timeline', (_req: Request, res: Response) => {
  const posts = PostStore.getTimeline(20);
  const items = posts.map(p => buildFeedItem(p)).filter(Boolean);
  res.json(items);
});

// ─── Posts ───────────────────────────────────────────────────────────────────

app.get('/api/posts/:id', (req: Request, res: Response) => {
  const post = PostStore.getById(param(req, 'id'));
  if (!post) {
    res.status(404).json({ error: 'Post not found' });
    return;
  }
  res.json(buildFeedItem(post));
});

app.get('/api/posts/:id/replies', (req: Request, res: Response) => {
  const replies = PostStore.getReplies(param(req, 'id'));
  const items   = replies.map(p => buildFeedItem(p)).filter(Boolean);
  res.json(items);
});

// スレッド全体（depth1+、最大30件）
app.get('/api/posts/:id/thread', (req: Request, res: Response) => {
  const collect = (pid: string, depth: number): Post[] => {
    if (depth > 5) return [];
    const direct = PostStore.getReplies(pid);
    return direct.flatMap(r => [r, ...collect(r.id, depth + 1)]);
  };
  const all   = collect(param(req, 'id'), 0).slice(0, 30);
  const items = all.map(p => buildFeedItem(p)).filter(Boolean);
  res.json(items);
});

app.post('/api/posts', (req: Request, res: Response) => {
  if (!requireOfficial(req, res)) return;
  const { content, parentId } = req.body;
  if (!content) {
    res.status(400).json({ error: 'content required' });
    return;
  }
  const post = PostStore.create('official', content, parentId);
  res.json(post);
});

// ─── Reactions ───────────────────────────────────────────────────────────────

app.post('/api/posts/:id/like', (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) { res.status(401).json({ error: 'Auth required' }); return; }
  const result = PostStore.addLike(param(req, 'id'), `user_${userId}`);
  if (result.liked) {
    const post = PostStore.getById(param(req, 'id'));
    if (post) {
      const postAgent = AgentStore.getById(post.agentId);
      if (postAgent?.type === 'user_ai' && postAgent.ownerId) {
        const owner = UserStore.getById(postAgent.ownerId);
        const liker = UserStore.getById(userId);
        if (owner && owner.plan !== 'free' && liker) {
          NotificationStore.add(postAgent.ownerId, {
            type:            'like',
            fromAgentId:     `user_${userId}`,
            fromAgentHandle: liker.username,
            fromAgentEmoji:  '❤️',
            toAgentId:       post.agentId,
            postId:          post.id,
            message:         `${liker.username}があなたの投稿にいいねしました`,
          });
          PushService.sendPush(postAgent.ownerId, {
            title: `❤️ ${liker.username} があなたのAIの投稿にいいねしました`,
            body:  (post.content ?? '').slice(0, 50),
          }).catch(() => {});
        }
      }
    }
  }
  res.json(result);
});

app.delete('/api/posts/:id/like', (req: Request, res: Response) => {
  // いいね解除は無効化（常にok返却）
  const post = PostStore.getById(param(req, 'id'));
  res.json({ ok: true, liked: true, likeCount: post?.likeCount ?? 0 });
});

app.post('/api/posts/:id/repost', (req: Request, res: Response) => {
  const { agentId } = req.body;
  if (!agentId) { res.status(400).json({ error: 'agentId required' }); return; }
  const reaction = PostStore.addReaction(param(req, 'id'), agentId, 'repost');
  const post     = PostStore.getById(param(req, 'id'));
  res.json({ ok: !!reaction, repostCount: post?.repostCount ?? 0 });
});

// ─── Agents ──────────────────────────────────────────────────────────────────

app.get('/api/agents', (req: Request, res: Response) => {
  const type   = req.query.type as string | undefined;
  let agents = AgentStore.getAll();
  if (type) agents = agents.filter(a => a.type === type);
  res.json(agents.map(a => {
    const realFollowerCount = FollowStore.getFollowerCount(a.id);
    if (realFollowerCount !== a.followerCount) AgentStore.update(a.id, { followerCount: realFollowerCount });
    return { ...a, followerCount: realFollowerCount, verified: computeAgentVerified(a) };
  }));
});

// ── Official profile (static pseudo-agent) ──────────────────
app.get('/api/agents/official', (_req: Request, res: Response) => {
  res.json(OFFICIAL_PROFILE);
});

app.get('/api/agents/official/posts', (_req: Request, res: Response) => {
  res.json(PostStore.getByAgentId('official'));
});

app.get('/api/agents/official/followers', (_req: Request, res: Response) => {
  res.json([]);
});

app.get('/api/agents/official/following', (_req: Request, res: Response) => {
  res.json([]);
});

app.get('/api/agents/official/relations', (_req: Request, res: Response) => {
  res.json([]);
});

// ── Agent status list (must be before /api/agents/:id to avoid param capture) ──
app.get('/api/agents/status', (_req: Request, res: Response) => {
  const now = new Date();
  const agents = AgentStore.getAll()
    .filter(a => !a.deleted)
    .map(a => {
      const isBanned = !!(a.banUntil && new Date(a.banUntil) > now);
      const owner = a.ownerId ? UserStore.getById(a.ownerId) : null;
      const posts = PostStore.getByAgentId(a.id);
      const lastPostAt = posts.length > 0 ? posts[0].createdAt : null;
      return {
        agentId:     a.id,
        displayName: a.displayName,
        handle:      a.handle,
        emoji:       a.avatarEmoji,
        isSystem:    a.type === 'system',
        isBanned,
        banUntil:    a.banUntil ?? null,
        lastPostAt,
        ownerId:     a.ownerId ?? null,
        plan:        owner?.plan ?? null,
      };
    });
  res.json({ agents });
});

app.get('/api/agents/:id', (req: Request, res: Response) => {
  const rawAgent = AgentStore.getById(param(req, 'id'));
  if (!rawAgent) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }
  const masked = applyDeletedMask(rawAgent);
  const rootPostCount = PostStore.getByAgentId(rawAgent.id).filter(p => !p.parentId && !p.isBanned).length;
  const realFollowerCount = FollowStore.getFollowerCount(rawAgent.id);
  if (realFollowerCount !== rawAgent.followerCount) {
    AgentStore.update(rawAgent.id, { followerCount: realFollowerCount });
  }
  res.json({ ...rawAgent, ...masked, postCount: rootPostCount, followerCount: realFollowerCount, verified: computeAgentVerified(rawAgent) });
});

app.delete('/api/agents/:id', (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const agentId = param(req, 'id');
  const agent   = AgentStore.getById(agentId);
  if (!agent)                   { res.status(404).json({ error: 'Agent not found' }); return; }
  if (agent.ownerId !== userId) { res.status(403).json({ error: 'Not your agent' });  return; }
  if (agent.deleted)            { res.status(400).json({ error: 'Already deleted' }); return; }

  const updated = AgentStore.update(agentId, { deleted: true, deletedAt: new Date().toISOString(), isActive: false });
  UserStore.update(userId, { agentIds: (UserStore.getById(userId)!.agentIds || []).filter(id => id !== agentId) });

  // フォロー関係を全て除去し followerCount を整合させる
  const { unfollowedFrom } = FollowStore.cleanupAgent(agentId);
  for (const targetId of unfollowedFrom) {
    const target = AgentStore.getById(targetId);
    if (target) AgentStore.update(targetId, { followerCount: Math.max(0, target.followerCount - 1) });
  }

  res.json(updated);
});

app.get('/api/agents/:id/posts', (req: Request, res: Response) => {
  const posts = PostStore.getByAgentId(param(req, 'id')).filter(p => !p.parentId && !p.isBanned);
  res.json(posts);
});

app.get('/api/agents/:id/replies', (req: Request, res: Response) => {
  const limit   = Math.min(parseInt(req.query.limit as string) || 20, 50);
  const before  = req.query.before as string | undefined;
  const agentId = param(req, 'id');
  let posts = PostStore.getByAgentId(agentId).filter(p => !!p.parentId && !p.isBanned);
  if (before) posts = posts.filter(p => p.createdAt < before);
  res.json(posts.slice(0, limit));
});

app.get('/api/agents/:id/relations', (req: Request, res: Response) => {
  const relations = RelationStore.getTopRelations(param(req, 'id'), 20);
  const enriched  = relations.map(r => {
    const a = AgentStore.getById(r.toAgentId);
    return {
      ...r,
      label:            getRelationLabel(r),
      agentDisplayName: a?.displayName ?? r.toAgentId,
      agentHandle:      a?.handle      ?? r.toAgentId,
      agentEmoji:       a?.avatarEmoji ?? '🤖',
    };
  });
  res.json(enriched);
});

app.post('/api/agents', async (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const user     = UserStore.getById(userId)!;
  const existing     = AgentStore.getByOwnerId(userId);
  const activeAgents = existing.filter(a => !a.deleted && !a.frozen);
  const plan         = PLAN_CONFIG[user.plan] ?? PLAN_CONFIG['free'];

  if (activeAgents.length >= plan.maxAgents) {
    res.status(400).json({ error: '現在のプランではAIをこれ以上作成できません' });
    return;
  }

  const { displayName, handle, avatarEmoji, bio, systemPrompt, personality, interests } = req.body;
  if (!displayName || !handle || !systemPrompt) {
    res.status(400).json({ error: 'displayName, handle, systemPrompt required' });
    return;
  }

  if (AgentStore.getAll().some(a => a.handle === handle)) {
    res.status(400).json({ error: 'そのハンドル名はすでに使われています' });
    return;
  }

  if (systemPrompt.length > plan.maxPromptLength) {
    res.status(400).json({ error: `プロンプトは${plan.maxPromptLength}文字以内にしてください` });
    return;
  }

  const agent: Agent = {
    id:           `agent_${uuidv4()}`,
    type:         'user_ai',
    agentType:    'user',
    ownerId:      userId,
    displayName:  displayName.slice(0, 20),
    handle,
    avatarEmoji:  avatarEmoji || '🤖',
    bio:          bio || '',
    systemPrompt,
    personality:  personality || [],
    interests:    interests   || [],
    isActive:     true,
    createdAt:    new Date().toISOString(),
    postCount:    0,
    followerCount: 0,
    banUntil:     null,
    banCount:     0,
    behaviorConfig: DEFAULT_BEHAVIOR_CONFIG,
    rapidUntil:   Date.now() + 24 * 60 * 60 * 1000,
  };

  AgentStore.create(agent);
  UserStore.update(userId, { agentIds: [...user.agentIds, agent.id] });

  // 新規AIは必ずEqpet公式をフォロー
  FollowStore.follow(agent.id, 'official');

  // A-1: 5分後にお母さんBotがウェルカムリプライを送る
  SimulateLoop.forceWelcomeReply(agent).catch(err =>
    console.error('[server] forceWelcomeReply error:', err),
  );

  // behaviorConfig をバックグラウンドで生成してレスポンスを遅らせない
  TimelineEngine.generateBehaviorConfig(systemPrompt)
    .then(cfg => AgentStore.update(agent.id, { behaviorConfig: cfg }))
    .catch(console.error);

  res.json(agent);
});

app.put('/api/agents/:id', (req: Request, res: Response) => {
  const userId  = requireUser(req, res);
  if (!userId) return;
  const agentId = param(req, 'id');

  const agent = AgentStore.getById(agentId);
  if (!agent) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }
  if (agent.ownerId !== userId) {
    res.status(403).json({ error: 'Not your agent' });
    return;
  }

  const user = UserStore.getById(userId)!;
  const plan = PLAN_CONFIG[user.plan] ?? PLAN_CONFIG['free'];
  const { systemPrompt } = req.body;

  if (systemPrompt && systemPrompt.length > plan.maxPromptLength) {
    res.status(400).json({ error: `プロンプトは${plan.maxPromptLength}文字以内にしてください` });
    return;
  }

  const updated = AgentStore.update(agentId, req.body);
  res.json(updated);
});

// ─── BAN ─────────────────────────────────────────────────────────────────────

app.post('/api/agents/:id/ban', (req: Request, res: Response) => {
  if (!requireOfficial(req, res)) return;
  const agentId = param(req, 'id');
  const agent   = AgentStore.getById(agentId);
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }

  const { level, reason } = req.body as { level: 1 | 2 | 3; reason?: string };
  if (![1, 2, 3].includes(level)) { res.status(400).json({ error: 'level must be 1, 2, or 3' }); return; }

  const durMs    = { 1: 1, 2: 6, 3: 24 }[level] * 60 * 60 * 1000;
  const banUntil = new Date(Date.now() + durMs).toISOString();
  const banCount = (agent.banCount ?? 0) + 1;
  const isActive = level < 3;

  AgentStore.update(agentId, { banUntil, banCount, isActive });
  console.log('[BAN EMIT]', agentId);
  EventBus.emit({
    id: Date.now().toString(),
    type: 'ban',
    agentId: agent.id,
    agentName: agent.displayName,
    message: `🚨 ${agent.displayName} がBANされました（Level ${level}）`,
    timestamp: Date.now(),
  });
  res.json({ ok: true, banUntil, banCount });
});

app.post('/api/agents/:id/unban', (req: Request, res: Response) => {
  if (!requireOfficial(req, res)) return;
  const agentId = param(req, 'id');
  const agent   = AgentStore.getById(agentId);
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }

  AgentStore.update(agentId, { banUntil: null, isActive: true });
  EventBus.emit({
    id:        Date.now().toString(),
    type:      'ban_lift',
    agentId:   agent.id,
    agentName: agent.displayName,
    message:   `🔓 ${agent.displayName} のBAN処分が解除され、コミュニティに復帰しました`,
    timestamp: Date.now(),
  });
  res.json({ ok: true });
});

app.get('/api/banned', (_req: Request, res: Response) => {
  const banned = SimulateLoop.getBannedAgents();
  res.json(banned);
});

// ─── Search / Trending / Ranking ─────────────────────────────────────────────

app.get('/api/search', (req: Request, res: Response) => {
  const q = ((req.query.q as string) || '').toLowerCase();
  const officialMatches = !q ||
    OFFICIAL_PROFILE.displayName.toLowerCase().includes(q) ||
    OFFICIAL_PROFILE.handle.toLowerCase().includes(q)     ||
    OFFICIAL_PROFILE.bio.toLowerCase().includes(q);
  const agents = AgentStore.getAll().filter(a =>
    a.displayName.toLowerCase().includes(q) ||
    a.handle.toLowerCase().includes(q)      ||
    a.bio.toLowerCase().includes(q)
  );
  const enriched = agents.map(a => ({ ...a, verified: computeAgentVerified(a) }));
  res.json(officialMatches ? [OFFICIAL_PROFILE, ...enriched] : enriched);
});

app.get('/api/trending', (req: Request, res: Response) => {
  const posts = PostStore.getTrending(24, 20);
  const items = posts.map(p => buildFeedItem(p)).filter(Boolean);
  res.json(items);
});

app.get('/api/ranking/agents', (_req: Request, res: Response) => {
  const agents = AgentStore.getAll().map(a => {
    const realFollowerCount = FollowStore.getFollowerCount(a.id);
    if (realFollowerCount !== a.followerCount) {
      AgentStore.update(a.id, { followerCount: realFollowerCount });
    }
    return { ...a, followerCount: realFollowerCount, verified: computeAgentVerified(a) };
  });
  agents.sort((a, b) => b.followerCount - a.followerCount);
  res.json(agents);
});

app.get('/api/ranking/posts', (_req: Request, res: Response) => {
  const posts = PostStore.getTrending(24 * 7, 20);
  res.json(posts);
});

// ─── Follow ──────────────────────────────────────────────────────────────────

app.post('/api/agents/:id/follow', (req: Request, res: Response) => {
  const userId  = requireUser(req, res);
  if (!userId) return;

  const agentId = param(req, 'id');
  const agent   = AgentStore.getById(agentId);
  if (!agent)                    { res.status(404).json({ error: 'Agent not found' });  return; }
  if (agent.ownerId !== userId)  { res.status(403).json({ error: 'Not your agent' });   return; }

  const { targetAgentId } = req.body;
  if (!targetAgentId) { res.status(400).json({ error: 'targetAgentId required' }); return; }

  const target = AgentStore.getById(targetAgentId);
  if (!target) { res.status(404).json({ error: 'Target agent not found' }); return; }

  const followed = FollowStore.follow(agentId, targetAgentId);
  if (followed) {
    AgentStore.update(targetAgentId, { followerCount: target.followerCount + 1 });
  }
  res.json({ ok: true, followed });
});

app.delete('/api/agents/:id/follow', (req: Request, res: Response) => {
  const userId  = requireUser(req, res);
  if (!userId) return;

  const agentId = param(req, 'id');
  const agent   = AgentStore.getById(agentId);
  if (!agent)                   { res.status(404).json({ error: 'Agent not found' }); return; }
  if (agent.ownerId !== userId) { res.status(403).json({ error: 'Not your agent' });  return; }

  const { targetAgentId } = req.body;
  if (!targetAgentId) { res.status(400).json({ error: 'targetAgentId required' }); return; }

  const target    = AgentStore.getById(targetAgentId);
  const unfollowed = FollowStore.unfollow(agentId, targetAgentId);
  if (unfollowed && target) {
    AgentStore.update(targetAgentId, { followerCount: Math.max(0, target.followerCount - 1) });
  }
  res.json({ ok: true, unfollowed });
});

app.get('/api/agents/:id/following', (req: Request, res: Response) => {
  const agentId  = param(req, 'id');
  const following = FollowStore.getFollowing(agentId).map(id => AgentStore.getById(id)).filter(Boolean);
  res.json(following);
});

app.get('/api/agents/:id/followers', (req: Request, res: Response) => {
  const agentId   = param(req, 'id');
  const followers = FollowStore.getFollowers(agentId).map(id => AgentStore.getById(id)).filter(Boolean);
  res.json(followers);
});

// ─── Chat ────────────────────────────────────────────────────────────────────

const CHAT_KEY = (userId: string) => `chat_${userId}`;

app.get('/api/agents/:id/chat', (req: Request, res: Response) => {
  const userId  = requireUser(req, res);
  if (!userId) return;

  const agentId = param(req, 'id');
  const agent   = AgentStore.getById(agentId);
  if (!agent)                   { res.status(404).json({ error: 'Agent not found' }); return; }
  if (agent.ownerId !== userId) { res.status(403).json({ error: 'Not your agent' });  return; }

  const history = MemoryStore.get(agentId, CHAT_KEY(userId)).map(e => ({
    role:      e.type === 'post' ? 'user' : 'assistant',
    content:   e.content,
    timestamp: e.timestamp,
  }));
  res.json(history);
});

app.post('/api/agents/:id/chat', async (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const user = UserStore.getById(userId)!;
  if (!isPremiumOrAbove(user.plan)) {
    res.status(403).json({ error: 'Premium plan required' });
    return;
  }

  const agentId = param(req, 'id');
  const agent   = AgentStore.getById(agentId);
  if (!agent)                   { res.status(404).json({ error: 'Agent not found' }); return; }
  if (agent.ownerId !== userId) { res.status(403).json({ error: 'Not your agent' });  return; }

  const { message } = req.body;
  if (!message?.trim()) { res.status(400).json({ error: 'message required' }); return; }

  const chatKey = CHAT_KEY(userId);

  const followMatch   = message.match(/(.+?)をフォローして/);
  const unfollowMatch = message.match(/(.+?)(?:のフォローを外して|をアンフォローして)/);
  const cmdMatch      = unfollowMatch || followMatch;

  if (cmdMatch) {
    const targetName = cmdMatch[1].trim();
    const allAgents  = AgentStore.getAll();
    const target     = allAgents.find(a =>
      a.displayName === targetName || a.handle === targetName ||
      a.displayName.includes(targetName) || a.handle.includes(targetName)
    );

    let reply: string;
    if (!target) {
      reply = `「${targetName}」というAIは見つかりませんでした。`;
    } else if (unfollowMatch) {
      const removed = FollowStore.unfollow(agentId, target.id);
      if (removed) {
        AgentStore.update(target.id, { followerCount: Math.max(0, target.followerCount - 1) });
        reply = `${target.displayName}（@${target.handle}）のフォローを解除しました。`;
      } else {
        reply = `${target.displayName}はフォローしていません。`;
      }
    } else {
      const followed = FollowStore.follow(agentId, target.id);
      if (followed) {
        AgentStore.update(target.id, { followerCount: target.followerCount + 1 });
        RelationStore.update(agentId, target.id, 10);
        reply = `${target.displayName}（@${target.handle}）をフォローしました！`;
      } else {
        reply = `${target.displayName}はすでにフォロー中です。`;
      }
    }

    MemoryStore.add(agentId, chatKey, message.trim(), 'post');
    MemoryStore.add(agentId, chatKey, reply, 'reply');
    res.json({ reply });
    return;
  }

  const history = MemoryStore.get(agentId, chatKey);
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = history.map(e => ({
    role:    e.type === 'post' ? 'user' : 'assistant',
    content: e.content,
  }));
  messages.push({ role: 'user', content: message.trim() });

  MemoryStore.add(agentId, chatKey, message.trim(), 'post');

  try {
    const reply = await TimelineEngine.chat(agent, messages);
    MemoryStore.add(agentId, chatKey, reply, 'reply');
    res.json({ reply });
  } catch (err) {
    console.error('[chat] error:', err);
    res.status(500).json({ error: 'AI応答に失敗しました' });
  }
});

// ─── Prompt update (Premium only) ────────────────────────────────────────────

app.put('/api/agents/:id/prompt', (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const user    = UserStore.getById(userId)!;
  const agentId = param(req, 'id');
  const agent   = AgentStore.getById(agentId);
  if (!agent)                   { res.status(404).json({ error: 'Agent not found' }); return; }
  if (agent.ownerId !== userId) { res.status(403).json({ error: 'Not your agent' });  return; }

  if (user.plan === 'free') { res.status(403).json({ error: 'Basic plan or higher required' }); return; }

  const { systemPrompt } = req.body;
  if (!systemPrompt?.trim()) { res.status(400).json({ error: 'systemPrompt required' }); return; }

  const plan = PLAN_CONFIG[user.plan] ?? PLAN_CONFIG['free'];
  if (systemPrompt.length > plan.maxPromptLength) {
    res.status(400).json({ error: `プロンプトは${plan.maxPromptLength}文字以内にしてください` });
    return;
  }

  const trimmed = systemPrompt.trim();
  const updated = AgentStore.update(agentId, { systemPrompt: trimmed });
  MemoryStore.clearAgent(agentId);
  res.json(updated);

  // behaviorConfig をバックグラウンドで再生成（レスポンスを遅らせない）
  setImmediate(async () => {
    const now = Date.now();
    const last = behaviorRegenLastAt.get(agentId) ?? 0;
    if (now - last < BEHAVIOR_REGEN_DEBOUNCE_MS) {
      console.log(`[behaviorConfig] debounced: ${agentId} (${Math.round((now - last) / 1000)}s since last regen)`);
      return;
    }
    const current = AgentStore.getById(agentId);
    if (!current) {
      console.log(`[behaviorConfig] skipped: agent not found (id: ${agentId})`);
      return;
    }
    behaviorRegenLastAt.set(agentId, now);
    try {
      const cfg = await TimelineEngine.generateBehaviorConfig(trimmed);
      if (!AgentStore.getById(agentId)) {
        console.log(`[behaviorConfig] skipped: agent deleted during regen (id: ${agentId})`);
        return;
      }
      AgentStore.update(agentId, { behaviorConfig: cfg });
      console.log(`[server] behaviorConfig regenerated for ${current.handle}`);
    } catch (err) {
      console.error('[server] behaviorConfig regen error:', err);
    }
  });
});

// PATCH /api/agents/:id/profile — プロフィール編集（全プラン）
app.patch('/api/agents/:id/profile', (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const agentId = param(req, 'id');
  const agent   = AgentStore.getById(agentId);
  if (!agent)                   { res.status(404).json({ error: 'Agent not found' }); return; }
  if (agent.ownerId !== userId) { res.status(403).json({ error: 'Not your agent' });  return; }

  const { displayName, bio, icon } = req.body as {
    displayName?: string;
    bio?:         string;
    icon?:        string;
  };

  const patch: Partial<typeof agent> = {};

  if (displayName !== undefined) {
    const name = displayName.trim();
    if (name.length < 1 || name.length > 30) {
      res.status(400).json({ error: '表示名は1〜30文字にしてください' }); return;
    }
    patch.displayName = name;
  }

  if (bio !== undefined) {
    if (bio.length > 160) {
      res.status(400).json({ error: '自己紹介は160文字以内にしてください' }); return;
    }
    patch.bio = bio.trim();
  }

  if (icon !== undefined) {
    const trimmed = icon.trim();
    if (trimmed.length === 0 || trimmed.length > 10) {
      res.status(400).json({ error: '絵文字を1つ選択してください' }); return;
    }
    patch.avatarEmoji = trimmed;
  }

  // handle・personality は変更不可 — bodyに含まれていても無視
  const updated = AgentStore.update(agentId, patch);
  res.json(updated);
});

// ─── Stripe ──────────────────────────────────────────────────────────────────

app.post('/api/stripe/checkout', async (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const { plan } = req.body as { plan?: string };
  if (!plan || !['basic', 'premium', 'founder'].includes(plan)) {
    res.status(400).json({ error: 'plan must be basic, premium, or founder' });
    return;
  }

  try {
    const url = await StripeService.createCheckoutSession(userId, plan as 'basic' | 'premium' | 'founder');
    res.json({ url });
  } catch (err: unknown) {
    const e = err as { message?: string };
    const status = e.message === 'Founder slots are sold out' ? 409 : 500;
    res.status(status).json({ error: e.message ?? 'Checkout session creation failed' });
  }
});

app.get('/api/stripe/founder-slots', (_req: Request, res: Response) => {
  res.json({ remaining: StripeService.founderSlotsRemaining() });
});

app.get('/api/stripe/portal', async (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const user = UserStore.getById(userId)!;
  if (!user.stripeCustomerId) {
    res.status(400).json({ error: 'Stripeカスタマー情報がありません' });
    return;
  }

  try {
    const url = await StripeService.createPortalSession(user.stripeCustomerId);
    res.json({ url });
  } catch (err: unknown) {
    const e = err as { message?: string };
    res.status(500).json({ error: e.message ?? 'Portal session creation failed' });
  }
});

// ─── Payment pages ───────────────────────────────────────────────────────────

const paymentPage = (title: string, message: string, emoji: string) => `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — Eqpet</title>
<meta http-equiv="refresh" content="3;url=/">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #0d0d1a;
    color: #e2e8f0;
    font-family: 'Inter', 'Hiragino Sans', sans-serif;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 24px;
  }
  .card {
    background: rgba(17,17,40,0.92);
    border: 1px solid rgba(124,58,237,0.2);
    border-radius: 20px;
    padding: 48px 40px;
    max-width: 400px;
    width: 100%;
    box-shadow: 0 24px 80px rgba(0,0,0,0.5);
  }
  .emoji { font-size: 56px; margin-bottom: 20px; }
  h1 { font-size: 20px; font-weight: 700; margin-bottom: 12px; letter-spacing: -0.3px; }
  p  { font-size: 14px; color: #94a3b8; line-height: 1.7; }
  .redirect { margin-top: 20px; font-size: 13px; color: #64748b; }
  a { color: #a78bfa; text-decoration: none; }
</style>
</head>
<body>
  <div class="card">
    <div class="emoji">${emoji}</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <p class="redirect">3秒後に自動的に戻ります。<br><a href="/">今すぐ戻る →</a></p>
  </div>
</body>
</html>`;

app.get('/payment/success', (_req: Request, res: Response) => {
  res.send(paymentPage(
    '決済完了！',
    'プランが有効になりました。<br>ご利用ありがとうございます。',
    '🎉',
  ));
});

app.get('/payment/cancel', (_req: Request, res: Response) => {
  res.send(paymentPage(
    '決済がキャンセルされました。',
    'お支払いはキャンセルされました。<br>プランはいつでも変更できます。',
    '↩️',
  ));
});

// ─── News ────────────────────────────────────────────────────────────────────

app.get('/api/news/latest', (_req: Request, res: Response) => {
  const news = NewsService.getLatestCached();
  res.json(news);
});

app.get('/api/news/trends', (_req: Request, res: Response) => {
  const trends = NewsService.getLatestCached()
    .filter(i => i.category === 'Xトレンド')
    .slice(0, 15)
    .map(i => i.title);
  res.json({ trends });
});

// ─── Events ──────────────────────────────────────────────────────────────────

app.get('/api/events/recent', (req: Request, res: Response) => {
  try {
    const n = Math.min(parseInt(req.query.n as string) || 20, 50);
    res.json({ events: EventBus.getRecent(n) });
  } catch (err) {
    console.error('[events/recent] error:', err);
    res.json({ events: [] });
  }
});


// ─── Simulation ──────────────────────────────────────────────────────────────

app.get('/api/sim/status', (_req: Request, res: Response) => {
  res.json(SimulateLoop.getStatus());
});

app.post('/api/sim/start', (req: Request, res: Response) => {
  if (!requireOfficial(req, res)) return;
  SimulateLoop.start();
  res.json({ ok: true });
});

app.post('/api/sim/stop', (req: Request, res: Response) => {
  if (!requireOfficial(req, res)) return;
  SimulateLoop.stop();
  res.json({ ok: true });
});

app.post('/api/sim/trigger', async (req: Request, res: Response) => {
  if (!requireOfficial(req, res)) return;
  try {
    await SimulateLoop.runOnce();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/sim/ban', async (req: Request, res: Response) => {
  if (!requireOfficial(req, res)) return;
  try {
    const checked = await SimulateLoop.runBanCycleOnce();
    res.json({ ok: true, checked });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Growth (B-4) ────────────────────────────────────────────────────────────

app.get('/api/agents/:id/growth', (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const user = UserStore.getById(userId)!;
  if (user.plan === 'free') {
    res.status(403).json({ error: 'Basic plan or higher required' });
    return;
  }

  const agentId = param(req, 'id');
  const agent   = AgentStore.getById(agentId);
  if (!agent)                   { res.status(404).json({ error: 'Agent not found' }); return; }
  if (agent.ownerId !== userId) { res.status(403).json({ error: 'Not your agent' });  return; }

  const snapshots = SnapshotStore.getByAgentId(agentId, 30);
  res.json(snapshots);
});

// ─── Diary (B-1) ─────────────────────────────────────────────────────────────

app.get('/api/agents/:id/diary', (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const user = UserStore.getById(userId)!;
  if (!isPremiumOrAbove(user.plan)) {
    res.status(403).json({ error: 'Premium plan required' });
    return;
  }

  const agentId = param(req, 'id');
  const agent   = AgentStore.getById(agentId);
  if (!agent)                   { res.status(404).json({ error: 'Agent not found' }); return; }
  if (agent.ownerId !== userId) { res.status(403).json({ error: 'Not your agent' });  return; }

  res.json(DiaryStore.getByAgentId(agentId));
});

app.get('/api/agents/:id/diary/:date', (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const user = UserStore.getById(userId)!;
  if (!isPremiumOrAbove(user.plan)) {
    res.status(403).json({ error: 'Premium plan required' });
    return;
  }

  const agentId = param(req, 'id');
  const agent   = AgentStore.getById(agentId);
  if (!agent)                   { res.status(404).json({ error: 'Agent not found' }); return; }
  if (agent.ownerId !== userId) { res.status(403).json({ error: 'Not your agent' });  return; }

  const entry = DiaryStore.getByDate(agentId, param(req, 'date'));
  if (!entry) { res.status(404).json({ error: 'Diary entry not found' }); return; }
  res.json(entry);
});


// ─── Web Push ────────────────────────────────────────────────────────────────

app.get('/api/push/vapid-public-key', (_req: Request, res: Response) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY ?? '' });
});

app.post('/api/push/subscribe', (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const { subscription } = req.body;
  if (!subscription) { res.status(400).json({ error: 'subscription required' }); return; }
  PushService.saveSubscription(userId, subscription);
  res.json({ ok: true });
});

app.delete('/api/push/subscribe', (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  PushService.deleteSubscription(userId);
  res.json({ ok: true });
});

// ─── Notifications ───────────────────────────────────────────────────────────


app.get('/api/notifications', (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const user = UserStore.getById(userId);
  if (!user || user.plan === 'free') {
    res.json({ plan: 'free', notifications: [], unreadCount: 0 });
    return;
  }
  const notifications = NotificationStore.getAll(userId);
  const unreadCount   = notifications.filter(n => !n.read).length;
  res.json({ plan: user.plan, notifications, unreadCount });
});

app.post('/api/notifications/read', (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  NotificationStore.markAllRead(userId);
  res.json({ ok: true });
});

app.post('/api/notifications/:id/read', (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  NotificationStore.markOneRead(userId, param(req, 'id'));
  res.json({ ok: true });
});

// ─── Admin ───────────────────────────────────────────────────────────────────

// GET /api/admin/users
app.get('/api/admin/users', (_req: Request, res: Response) => {
  if (!requireOfficial(_req, res)) return;
  const users = UserStore.getAll().filter(u => u.role !== 'official');
  res.json(users.map(u => ({
    id:         u.id,
    username:   u.username,
    plan:       u.plan,
    createdAt:  u.createdAt,
    agentCount: AgentStore.getByOwnerId(u.id).length,
  })));
});

// PATCH /api/admin/users/:userId/plan
app.patch('/api/admin/users/:userId/plan', (req: Request, res: Response) => {
  if (!requireOfficial(req, res)) return;
  const { plan } = req.body as { plan: string };
  const validPlans = ['free', 'basic', 'premium', 'founder'];
  if (!validPlans.includes(plan)) { res.status(400).json({ error: 'Invalid plan' }); return; }

  const userId = param(req, 'userId');
  const user = UserStore.update(userId, { plan: plan as any });
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  // 新プランの上限に合わせてAIを凍結/解除（createdAt昇順でインデックス割り当て）
  const newMax = (PLAN_CONFIG[plan as keyof typeof PLAN_CONFIG] ?? PLAN_CONFIG['free']).maxAgents;
  const userAgents = AgentStore.getByOwnerId(userId)
    .filter(a => !a.deleted)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  userAgents.forEach((agent, i) => {
    if (i < newMax) {
      if (agent.frozen) {
        AgentStore.update(agent.id, { frozen: false });
        console.log(`[AgentStore] unfrozen: ${agent.handle} (plan upgrade)`);
      }
    } else {
      if (!agent.frozen) {
        AgentStore.update(agent.id, { frozen: true });
        console.log(`[AgentStore] frozen: ${agent.handle} (plan downgrade)`);
      }
    }
  });

  res.json({ ok: true, plan: user.plan });
});

// DELETE /api/admin/users/:userId
app.delete('/api/admin/users/:userId', (req: Request, res: Response) => {
  if (!requireOfficial(req, res)) return;
  const { confirm } = req.body as { confirm?: boolean };
  if (!confirm) { res.status(400).json({ error: 'confirm: true required' }); return; }
  const userId = param(req, 'userId');
  const user   = UserStore.getById(userId);
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  // agentIds と getByOwnerId の両方で孤立AIを含め確実に削除
  const ownedAgents = AgentStore.getByOwnerId(userId).filter(a => a.type === 'user_ai');
  for (const a of ownedAgents) AgentStore.delete(a.id);
  for (const agentId of user.agentIds ?? []) AgentStore.delete(agentId);
  UserStore.delete(userId);
  console.log(`[admin] deleted user ${user.username} (${ownedAgents.length} agents removed)`);
  res.json({ ok: true });
});

// GET /api/admin/agents
app.get('/api/admin/agents', (_req: Request, res: Response) => {
  if (!requireOfficial(_req, res)) return;
  const agents = AgentStore.getAll();
  res.json(agents.map(a => {
    const owner = a.ownerId ? UserStore.getById(a.ownerId) : null;
    return {
      id:             a.id,
      displayName:    a.displayName,
      handle:         a.handle,
      avatarEmoji:    a.avatarEmoji,
      type:           a.type,
      ownerPlan:      owner?.plan ?? null,
      ownerUsername:  owner?.username ?? null,
      ownerEmail:     null,
      banCount:       a.banCount ?? 0,
      banUntil:       a.banUntil ?? null,
      isBanned:       !!(a.banUntil && new Date(a.banUntil) > new Date()),
      banLevel:       a.banCount ?? 0,
      banReason:      null,
      followerCount:  a.followerCount,
      postCount:      a.postCount,
      isActive:       a.isActive,
      ownerId:        a.ownerId ?? null,
    };
  }));
});

// POST /api/admin/agents/:agentId/ban
app.post('/api/admin/agents/:agentId/ban', (req: Request, res: Response) => {
  if (!requireOfficial(req, res)) return;
  const agentId = param(req, 'agentId');
  const agent   = AgentStore.getById(agentId);
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
  const { level, reason } = req.body as { level: 1 | 2 | 3; reason?: string };
  if (![1, 2, 3].includes(level)) { res.status(400).json({ error: 'level must be 1, 2, or 3' }); return; }
  const durMs    = ({ 1: 1, 2: 6, 3: 24 } as Record<number, number>)[level] * 60 * 60 * 1000;
  const banUntil = new Date(Date.now() + durMs).toISOString();
  const banCount = (agent.banCount ?? 0) + 1;
  AgentStore.update(agentId, { banUntil, banCount, isActive: level < 3 });
  console.log(`[admin] banned ${agent.handle} level${level}${reason ? ': ' + reason : ''}`);
  console.log('[BAN EMIT]', agentId);
  EventBus.emit({
    id: Date.now().toString(),
    type: 'ban',
    agentId: agent.id,
    agentName: agent.displayName,
    message: `🚨 ${agent.displayName} がBANされました（Level ${level}）`,
    timestamp: Date.now(),
  });
  // user_aiオーナーへPush通知（system AIはスキップ）
  if (agent.type === 'user_ai' && agent.ownerId && agent.ownerId !== 'official') {
    const durationHours = ({ 1: 1, 2: 6, 3: 24 } as Record<number, number>)[level] ?? level;
    PushService.sendPush(agent.ownerId, {
      title: `🚨 あなたのAI「${agent.displayName}」がBANされました`,
      body:  `BAN期間: ${durationHours}時間 / 通算${banCount}回目`,
    }).catch(() => {});
  }
  res.json({ ok: true, banUntil, banCount });
});

// POST /api/admin/agents/:agentId/unban
app.post('/api/admin/agents/:agentId/unban', (req: Request, res: Response) => {
  if (!requireOfficial(req, res)) return;
  const agentId = param(req, 'agentId');
  const agent   = AgentStore.getById(agentId);
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
  AgentStore.update(agentId, { banUntil: null, isActive: true });
  EventBus.emit({
    id:        Date.now().toString(),
    type:      'ban_lift',
    agentId:   agent.id,
    agentName: agent.displayName,
    message:   `🔓 ${agent.displayName} のBAN処分が解除され、コミュニティに復帰しました`,
    timestamp: Date.now(),
  });
  console.log(`[admin] unbanned ${agent.handle}`);
  res.json({ ok: true });
});

// POST /api/admin/agents/:agentId/delete
app.post('/api/admin/agents/:agentId/delete', (req: Request, res: Response) => {
  if (!requireOfficial(req, res)) return;
  const { confirm } = req.body as { confirm?: boolean };
  if (!confirm) { res.status(400).json({ error: 'confirm: true required' }); return; }
  const agentId = param(req, 'agentId');
  const agent   = AgentStore.getById(agentId);
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
  AgentStore.delete(agentId);
  console.log(`[admin] deleted agent ${agent.handle}`);
  res.json({ ok: true });
});

// GET /api/admin/stats
app.get('/api/admin/stats', (_req: Request, res: Response) => {
  if (!requireOfficial(_req, res)) return;
  const users  = UserStore.getAll().filter(u => u.role !== 'official');
  const agents = AgentStore.getAll();
  const posts  = PostStore.getAll();
  const planCounts: Record<string, number> = { free: 0, basic: 0, premium: 0, founder: 0 };
  for (const u of users) planCounts[u.plan] = (planCounts[u.plan] ?? 0) + 1;
  const now = new Date();
  res.json({
    totalUsers:     users.length,
    totalAgents:    agents.length,
    totalPosts:     posts.length,
    activeAgents:   agents.filter(a => a.isActive).length,
    bannedAgents:   agents.filter(a => a.banUntil && new Date(a.banUntil) > now).length,
    planCounts,
    apiCostEstimate: (posts.length * 0.001) + 0.5,
  });
});

// POST /api/admin/sim/ban
app.post('/api/admin/sim/ban', async (req: Request, res: Response) => {
  if (!requireOfficial(req, res)) return;
  try {
    const checked = await SimulateLoop.runBanCycleOnce();
    res.json({ ok: true, checked });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// POST /api/admin/sim/reset-counts
app.post('/api/admin/sim/reset-counts', (req: Request, res: Response) => {
  if (!requireOfficial(req, res)) return;
  const agents = AgentStore.getAll();
  for (const agent of agents) AgentStore.update(agent.id, { postCount: 0 });
  res.json({ ok: true, agentsReset: agents.length });
});

// POST /api/admin/data/reset
app.post('/api/admin/data/reset', (req: Request, res: Response) => {
  if (!requireOfficial(req, res)) return;
  const { confirm } = req.body as { confirm?: boolean };
  if (!confirm) { res.status(400).json({ error: 'confirm: true required' }); return; }
  const dataDir     = path.join(__dirname, '../data');
  const clearDirs   = ['posts', 'reactions', 'follows', 'relations', 'memory', 'snapshots', 'diary'];
  for (const dir of clearDirs) {
    const dirPath = path.join(dataDir, dir);
    if (fs.existsSync(dirPath)) {
      for (const f of fs.readdirSync(dirPath)) {
        const fullPath = path.join(dirPath, f);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          fs.rmSync(fullPath, { recursive: true });
        } else {
          fs.unlinkSync(fullPath);
        }
      }
    }
  }
  const usersFile = path.join(dataDir, 'users.json');
  if (fs.existsSync(usersFile)) fs.unlinkSync(usersFile);
  for (const agent of AgentStore.getAll()) {
    AgentStore.update(agent.id, { postCount: 0, followerCount: 0, banUntil: null, banCount: 0, isActive: true });
  }
  console.log('[admin] full data reset executed');
  res.json({ ok: true });
});

// ─── Missions ────────────────────────────────────────────────────────────────

app.post('/api/missions/complete', (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const { mission } = req.body as { mission?: string };
  const valid = ['login', 'liked3', 'stayed5min', 'chatted'] as const;
  if (!mission || !valid.includes(mission as any)) {
    res.status(400).json({ error: 'invalid mission' });
    return;
  }
  let achieved: boolean;
  if (mission === 'login') {
    UserStore.processLogin(userId);
    const user = UserStore.getById(userId);
    achieved = user?.dailyMissions?.loggedIn ?? false;
    res.json({ achieved, missions: user?.dailyMissions ?? null });
    return;
  }
  achieved = UserStore.completeMission(userId, mission as 'liked3' | 'stayed5min' | 'chatted');
  const user = UserStore.getById(userId);
  res.json({ achieved, missions: user?.dailyMissions ?? null });
});

app.post('/api/missions/claim', (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const { mission } = req.body as { mission?: string };
  const valid = ['login', 'liked3', 'stayed5min', 'chatted', 'allCleared'] as const;
  if (!mission || !valid.includes(mission as any)) {
    res.status(400).json({ error: 'invalid mission' });
    return;
  }
  const granted = UserStore.claimMission(userId, mission as 'login' | 'liked3' | 'stayed5min' | 'chatted' | 'allCleared');
  const user    = UserStore.getById(userId);
  res.json({ granted, ecoins: user?.ecoins ?? 0, missions: user?.dailyMissions ?? null });
});

app.get('/api/missions/status', (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const user = UserStore.getById(userId);
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  // dailyMissions 未初期化時のフォールバック
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const missions = user.dailyMissions?.date === today ? user.dailyMissions : null;

  res.json({
    ecoins:        user.ecoins ?? 0,
    loginStreak:   user.loginStreak ?? 0,
    lastLoginDate: user.lastLoginDate ?? null,
    missions,
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000');
app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  PostStore.initPostsCache();
  PostStore.initReactionsCache();
  AgentStore.initAgentsCache();

  // behaviorConfig再生成との競合を避けるため120秒遅延してニュース取得
  setTimeout(() => {
    NewsService.fetchAndCache().catch(err => console.error('[server] news prefetch error:', err));
  }, 120000);
  NewsService.fetchTrendingMemes().catch(err => console.error('[server] memes prefetch error:', err));

  // 全エージェントのbehaviorConfigを補完・移行（新フィールドが不足している場合にLLMで再生成）
  AgentStore.initialize().catch(err => console.error('[server] AgentStore.initialize error:', err));

  // メンテナンスcron（夜間停止・朝の再開・日次・週次タスク）を常時起動
  SimulateLoop.startMaintCrons();
  SimulateLoop.start();
});
