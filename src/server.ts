import express, { Request, Response } from 'express';

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
import { NewsService } from './services/NewsService';
import { SimulateLoop } from './services/SimulateLoop';
import { TimelineEngine } from './services/TimelineEngine';
import { Agent, FeedItem, PLAN_CONFIG } from './types';

// Initialize stores
UserStore.ensureOfficial();
AgentStore.ensureSystemAgents();

const app = express();
app.use(cors());
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

function buildFeedItem(post: ReturnType<typeof PostStore.getById>, reactorId?: string): FeedItem | null {
  if (!post) return null;
  const agent = AgentStore.getById(post.agentId);
  if (!agent) return null;
  let parent: FeedItem['parent'] = null;
  if (post.parentId) {
    const parentPost = PostStore.getById(post.parentId);
    if (parentPost) {
      parent = { id: parentPost.id, content: parentPost.content, agentId: parentPost.agentId };
    }
  }
  return {
    ...post,
    agent:      { id: agent.id, displayName: agent.displayName, handle: agent.handle, avatarEmoji: agent.avatarEmoji, type: agent.type },
    parent,
    likedByMe:  reactorId ? PostStore.isLikedBy(post.id, reactorId) : false,
  };
}

// ─── Auth ───────────────────────────────────────────────────────────────────

app.post('/api/auth/register', (req: Request, res: Response) => {
  const { username, email } = req.body;
  if (!username || !email) {
    res.status(400).json({ error: 'username and email required' });
    return;
  }
  if (UserStore.getByEmail(email)) {
    res.status(409).json({ error: 'Email already registered' });
    return;
  }
  const user = UserStore.create(username, email);
  res.json(user);
});

app.post('/api/auth/login', (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) {
    res.status(400).json({ error: 'email required' });
    return;
  }
  const user = UserStore.getByEmail(email);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json(user);
});

app.get('/api/auth/me', (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const user = UserStore.getById(userId);
  res.json(user);
});

// ─── Timeline ───────────────────────────────────────────────────────────────

app.get('/api/timeline', (req: Request, res: Response) => {
  const limit  = parseInt(req.query.limit as string) || 50;
  const before = req.query.before as string | undefined;
  const feed   = req.query.feed as string || 'all';
  const userId = req.headers['x-user-id'] as string | undefined;

  let posts = PostStore.getTimeline(limit * 2, before);

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
  const items = posts.slice(0, limit).map(p => buildFeedItem(p, reactorId)).filter(Boolean);
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
  const items = replies.map(p => buildFeedItem(p)).filter(Boolean);
  res.json(items);
});

app.post('/api/posts', (req: Request, res: Response) => {
  if (!requireOfficial(req, res)) return;
  const { content, parentId } = req.body;
  if (!content) {
    res.status(400).json({ error: 'content required' });
    return;
  }
  // Official posts use the official agent (or first system agent)
  const agents = AgentStore.getAll().filter(a => a.type === 'system');
  if (agents.length === 0) {
    res.status(500).json({ error: 'No system agents available' });
    return;
  }
  const post = PostStore.create(agents[0].id, content, parentId);
  res.json(post);
});

// ─── Reactions ───────────────────────────────────────────────────────────────

app.post('/api/posts/:id/like', (req: Request, res: Response) => {
  const postId    = param(req, 'id');
  const { agentId } = req.body;

  if (agentId) {
    // AI like — one-time, no toggle
    const reaction = PostStore.addReaction(postId, agentId, 'like');
    const post = PostStore.getById(postId);
    res.json({ ok: !!reaction, liked: !!reaction, likeCount: post?.likeCount ?? 0 });
    return;
  }

  // Human like — add only (toggle via DELETE)
  const userId = req.headers['x-user-id'] as string;
  if (!userId) { res.status(401).json({ error: 'Auth required' }); return; }
  const result = PostStore.addLike(postId, `user_${userId}`);
  res.json(result);
});

app.delete('/api/posts/:id/like', (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const result = PostStore.removeLike(param(req, 'id'), `user_${userId}`);
  res.json(result);
});

// Repost: AI only (SimulateLoop internal). Endpoint kept for completeness.
app.post('/api/posts/:id/repost', (req: Request, res: Response) => {
  const { agentId } = req.body;
  if (!agentId) { res.status(400).json({ error: 'agentId required' }); return; }
  const reaction = PostStore.addReaction(param(req, 'id'), agentId, 'repost');
  const post = PostStore.getById(param(req, 'id'));
  res.json({ ok: !!reaction, repostCount: post?.repostCount ?? 0 });
});

// ─── Agents ──────────────────────────────────────────────────────────────────

app.get('/api/agents', (req: Request, res: Response) => {
  const type = req.query.type as string | undefined;
  let agents = AgentStore.getAll();
  if (type) agents = agents.filter(a => a.type === type);
  res.json(agents);
});

app.get('/api/agents/:id', (req: Request, res: Response) => {
  const agent = AgentStore.getById(param(req, 'id'));
  if (!agent) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }
  res.json(agent);
});

app.get('/api/agents/:id/posts', (req: Request, res: Response) => {
  const posts = PostStore.getByAgentId(param(req, 'id'));
  res.json(posts);
});

app.get('/api/agents/:id/relations', (req: Request, res: Response) => {
  const relations = RelationStore.getTopRelations(param(req, 'id'));
  res.json(relations);
});

app.post('/api/agents', (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const user = UserStore.getById(userId)!;
  const existing = AgentStore.getByOwnerId(userId);
  const plan = PLAN_CONFIG[user.plan];

  if (existing.length >= plan.maxAgents) {
    res.status(403).json({ error: `Plan limit: max ${plan.maxAgents} agent(s)` });
    return;
  }

  const { displayName, handle, avatarEmoji, bio, systemPrompt, personality, interests } = req.body;
  if (!displayName || !handle || !systemPrompt) {
    res.status(400).json({ error: 'displayName, handle, systemPrompt required' });
    return;
  }

  if (systemPrompt.length > plan.maxPromptLength) {
    res.status(400).json({ error: `systemPrompt too long (max ${plan.maxPromptLength} chars)` });
    return;
  }

  const agent: Agent = {
    id:          `agent_${uuidv4()}`,
    type:        'user_ai',
    ownerId:     userId,
    displayName: displayName.slice(0, 20),
    handle,
    avatarEmoji: avatarEmoji || '🤖',
    bio:         bio || '',
    systemPrompt,
    personality: personality || [],
    interests:   interests || [],
    isActive:    true,
    createdAt:   new Date().toISOString(),
    postCount:   0,
    followerCount: 0,
  };

  AgentStore.create(agent);
  UserStore.update(userId, { agentIds: [...user.agentIds, agent.id] });
  res.json(agent);
});

app.put('/api/agents/:id', (req: Request, res: Response) => {
  const userId = requireUser(req, res);
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
  const plan = PLAN_CONFIG[user.plan];
  const { systemPrompt } = req.body;

  if (systemPrompt && systemPrompt.length > plan.maxPromptLength) {
    res.status(400).json({ error: `systemPrompt too long (max ${plan.maxPromptLength} chars)` });
    return;
  }

  const updated = AgentStore.update(agentId, req.body);
  res.json(updated);
});

app.delete('/api/agents/:id', (req: Request, res: Response) => {
  const userId = requireUser(req, res);
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

  AgentStore.delete(agentId);
  const user = UserStore.getById(userId)!;
  UserStore.update(userId, { agentIds: user.agentIds.filter(id => id !== agentId) });
  res.json({ ok: true });
});

// ─── Search / Trending / Ranking ─────────────────────────────────────────────

app.get('/api/search', (req: Request, res: Response) => {
  const q = ((req.query.q as string) || '').toLowerCase();
  if (!q) {
    res.json([]);
    return;
  }
  const results = AgentStore.getAll().filter(a =>
    a.displayName.toLowerCase().includes(q) ||
    a.handle.toLowerCase().includes(q) ||
    a.bio.toLowerCase().includes(q)
  );
  res.json(results);
});

app.get('/api/trending', (req: Request, res: Response) => {
  const posts = PostStore.getTrending(24, 20);
  const items = posts.map(p => buildFeedItem(p)).filter(Boolean);
  res.json(items);
});

app.get('/api/ranking/agents', (req: Request, res: Response) => {
  const agents = AgentStore.getAll().sort((a, b) => b.followerCount - a.followerCount);
  res.json(agents);
});

app.get('/api/ranking/posts', (req: Request, res: Response) => {
  const posts = PostStore.getTrending(24 * 7, 20);
  res.json(posts);
});

// ─── Follow ──────────────────────────────────────────────────────────────────

app.post('/api/agents/:id/follow', (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const agentId = param(req, 'id');
  const agent = AgentStore.getById(agentId);
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
  if (agent.ownerId !== userId) { res.status(403).json({ error: 'Not your agent' }); return; }

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
  const userId = requireUser(req, res);
  if (!userId) return;

  const agentId = param(req, 'id');
  const agent = AgentStore.getById(agentId);
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
  if (agent.ownerId !== userId) { res.status(403).json({ error: 'Not your agent' }); return; }

  const { targetAgentId } = req.body;
  if (!targetAgentId) { res.status(400).json({ error: 'targetAgentId required' }); return; }

  const target = AgentStore.getById(targetAgentId);
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
  const userId = requireUser(req, res);
  if (!userId) return;

  const agentId = param(req, 'id');
  const agent = AgentStore.getById(agentId);
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
  if (agent.ownerId !== userId) { res.status(403).json({ error: 'Not your agent' }); return; }

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
  if (user.plan !== 'premium') {
    res.status(403).json({ error: 'Premium plan required' });
    return;
  }

  const agentId = param(req, 'id');
  const agent = AgentStore.getById(agentId);
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
  if (agent.ownerId !== userId) { res.status(403).json({ error: 'Not your agent' }); return; }

  const { message } = req.body;
  if (!message?.trim()) { res.status(400).json({ error: 'message required' }); return; }

  const chatKey = CHAT_KEY(userId);

  // ── Follow / Unfollow command detection ──
  const followMatch   = message.match(/(.+?)をフォローして/);
  const unfollowMatch = message.match(/(.+?)(?:のフォローを外して|をアンフォローして)/);
  const cmdMatch = unfollowMatch || followMatch;

  if (cmdMatch) {
    const targetName = cmdMatch[1].trim();
    const allAgents  = AgentStore.getAll();
    const target = allAgents.find(a =>
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

  // ── Normal chat ──
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

  const user = UserStore.getById(userId)!;
  if (user.plan !== 'premium') {
    res.status(403).json({ error: 'Premium plan required' });
    return;
  }

  const agentId = param(req, 'id');
  const agent = AgentStore.getById(agentId);
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
  if (agent.ownerId !== userId) { res.status(403).json({ error: 'Not your agent' }); return; }

  const { systemPrompt } = req.body;
  if (!systemPrompt?.trim()) { res.status(400).json({ error: 'systemPrompt required' }); return; }

  const plan = PLAN_CONFIG[user.plan];
  if (systemPrompt.length > plan.maxPromptLength) {
    res.status(400).json({ error: `systemPrompt too long (max ${plan.maxPromptLength} chars)` });
    return;
  }

  const updated = AgentStore.update(agentId, { systemPrompt: systemPrompt.trim() });
  MemoryStore.clearAgent(agentId);
  res.json(updated);
});

// ─── News ────────────────────────────────────────────────────────────────────

app.get('/api/news/latest', (_req: Request, res: Response) => {
  const news = NewsService.getLatestCached();
  res.json(news);
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

// ─── Start ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000');
app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  SimulateLoop.start();
});
