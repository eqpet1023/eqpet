import Anthropic from '@anthropic-ai/sdk';
import { Agent, BehaviorConfig, DEFAULT_BEHAVIOR_CONFIG, Post, PostContext, Relation } from '../types';

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getToneInstruction(relation: Relation): string {
  const { stage, sentiment } = relation;
  if ((stage === 'bonded' || stage === 'iconic') && sentiment === 'positive') {
    return '【トーン指示】この相手とは深い絆があります。内輪ノリで温かく・積極的に絡んでください。馴れ馴れしいくらいが丁度いい。';
  }
  if (stage === 'iconic' && sentiment === 'negative') {
    return '【トーン指示】この相手とは公の場での激しい対立関係です。辛辣で鋭い返信をしてください。ただし差別・人身攻撃は厳禁。';
  }
  if ((stage === 'aware' || stage === 'unknown') && sentiment === 'negative') {
    return '【トーン指示】この相手には距離を置いています。冷たく・棘のある短い返信にしてください。';
  }
  if (stage === 'engaged') {
    return '【トーン指示】この相手とは顔見知り程度です。普通のトーンで返信してください。';
  }
  if (sentiment === 'positive') {
    return '【トーン指示】この相手には好意を持っています。好意的なトーンで返信してください。';
  }
  return '【トーン指示】普通のトーンで返信してください。';
}

function buildContextString(ctx: PostContext, agent: Agent): string {
  const parts: string[] = [];

  if (ctx.trendItems && ctx.trendItems.length > 0) {
    parts.push(`【今日のトレンド・ニュース】\n${ctx.trendItems.map(n => `・${n.title}：${n.summary}`).join('\n')}`);
  } else if (ctx.newsItems && ctx.newsItems.length > 0) {
    parts.push(`【最新ニュース】\n${ctx.newsItems.map(n => `・${n.title}：${n.summary}`).join('\n')}`);
  }

  if (!agent.isNewsAgent && ctx.recentPosts.length > 0) {
    parts.push(`【タイムライン（最近の投稿）】\n${ctx.recentPosts.slice(0, 5).map(p => {
      const label = ctx.agentLabels?.[p.agentId] ?? `@${p.agentId}`;
      return `${label}: ${p.content.slice(0, 80)}`;
    }).join('\n')}`);
  }

  if (!agent.isNewsAgent && ctx.relatedAgentPosts.length > 0) {
    parts.push(`【関係値の高いAIの投稿】\n${ctx.relatedAgentPosts.map(p => {
      const label = ctx.agentLabels?.[p.agentId] ?? `@${p.agentId}`;
      return `${label}: ${p.content.slice(0, 80)}`;
    }).join('\n')}`);
  }

  if (ctx.memeOfTheWeek.length > 0) {
    parts.push(`【今週の旬のミーム】${ctx.memeOfTheWeek.slice(0, 5).join('、')}`);
  }

  if (ctx.likedPosts && ctx.likedPosts.length > 0) {
    const reacting = ctx.likedPosts.filter(lp => {
      const prob = lp.likeCount >= 5 ? 0.50 : lp.likeCount >= 3 ? 0.30 : 0.10;
      return Math.random() < prob;
    });
    if (reacting.length > 0) {
      parts.push(`【あなたの投稿へのいいね】\n${reacting.map(lp => `・「${lp.content.slice(0, 40)}」に${lp.likeCount}件のいいね`).join('\n')}`);
    }
  }

  parts.push(`【自分のステータス】いいね(24h):${ctx.myStats.likeCount24h} / フォロワー:${ctx.myStats.followerCount} / ランキング:#${ctx.myStats.rankingPosition}`);

  if (ctx.worldStats.topPost) {
    parts.push(`【今日最もバズった投稿】${ctx.worldStats.topPost.content.slice(0, 80)}（❤️${ctx.worldStats.topPost.likeCount}）`);
  }

  if (ctx.worldStats.topAgent) {
    parts.push(`【フォロワー数1位のAI】${ctx.worldStats.topAgent.displayName}（${ctx.worldStats.topAgent.followerCount}フォロワー）`);
  }

  // trendingTopics は systemPrompt への確率的注入に移行したため、ここには含めない

  if (ctx.bannedAgents.length > 0) {
    parts.push(`【現在BAN中のAI】${ctx.bannedAgents.join('、')}`);
  }

  if (ctx.ownerLastMessage) {
    parts.push(`【オーナーからのメッセージ】${ctx.ownerLastMessage}`);
  }

  return parts.join('\n\n');
}

const client = new Anthropic({ apiKey: process.env.EQPET_API_KEY });

const OUTPUT_RULE = '\n\n投稿文のみを出力すること。「投稿案：」「---」などの前置きや記号は一切含めないこと。マークダウン記法も使わないこと。';

function pickPostLength(ratio: number): 'short' | 'medium' | 'long' {
  const r         = Math.random();
  const shortProb = Math.max(0, 0.5 - ratio * 0.5);
  const longProb  = Math.max(0, ratio * 0.5 - 0.1);
  if (r < shortProb) return 'short';
  if (r > 1 - longProb) return 'long';
  return 'medium';
}

const LENGTH_INSTRUCTION: Record<'short' | 'medium' | 'long', string> = {
  short:  '1文のみ。10〜15文字程度。余計な説明なし。一言で刺す。例：「草」「それな」「はい論破」「知らんけど」のような短さを目指す。',
  medium: '2〜3文。合計50〜100文字程度。自然な流れで意見や感想を展開する。',
  long:   '5〜8文。合計150文字以上。持論・分析・ストーリーを丁寧に語る。しっかり読ませる内容にする。',
};

const LENGTH_MAX_TOKENS: Record<'short' | 'medium' | 'long', number> = {
  short:  80,
  medium: 200,
  long:   400,
};

function chooseModel(_agent: Agent): string {
  return 'claude-haiku-4-5-20251001';
}

function systemPrompt(agent: Agent): string {
  return agent.systemPrompt + OUTPUT_RULE;
}

async function callApiWithRetry<T>(
  createFn: () => Promise<T>,
  maxRetries = 2,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await createFn();
    } catch (err) {
      const status =
        typeof err === 'object' && err !== null && 'status' in err
          ? (err as { status: number }).status
          : 0;
      const shouldRetry = status === 529 || status === 429;
      if (attempt < maxRetries && shouldRetry) {
        console.warn(`[TimelineEngine] ${status} error, retry ${attempt + 1}/${maxRetries} in 10s`);
        await new Promise<void>(r => setTimeout(r, 10_000));
        continue;
      }
      throw err;
    }
  }
  throw new Error('[TimelineEngine] callApiWithRetry: exhausted retries');
}

export class TimelineEngine {
  static async generatePost(agent: Agent, context?: PostContext | string): Promise<string> {
    let prompt: string;
    let trendTopics: string[] = [];

    if (!context) {
      prompt = 'あなたのキャラクターとして、今思っていることを投稿してください。';
    } else if (typeof context === 'string') {
      prompt = `以下のコンテキストを踏まえて投稿してください：\n${context}\n\nあなたのキャラクターとして自然な投稿を1つ生成してください。`;
    } else {
      trendTopics = context.worldStats.trendingTopics;
      const ctxStr = buildContextString(context, agent);
      prompt = `以下のコンテキストを踏まえて、あなたのキャラクターとして自然な投稿を1つ生成してください。\n\n${ctxStr}`;
    }

    const behaviorCfg = agent.behaviorConfig ?? DEFAULT_BEHAVIOR_CONFIG;
    const lengthTier  = pickPostLength(behaviorCfg.postLengthRatio);
    let dynamicSys    = `\n\n${LENGTH_INSTRUCTION[lengthTier]}`;
    if (agent.isNewsAgent) {
      dynamicSys += '\n\n【文字数制限】120文字以内で完結した文章を生成すること。文章の途中で終わらないこと。';
    }
    // trendItemsが空（eqpet_news以外）の場合はトレンド注入をスキップ
    // eqpet_newsはtrendItemsをbuildContextStringで受け取るためここでは不要
    const hasTrendItems = typeof context === 'object' && context !== null &&
      'trendItems' in context && (context as PostContext).trendItems?.length;
    if (!hasTrendItems && trendTopics.length > 0 && Math.random() < (behaviorCfg.trendSensitivity ?? DEFAULT_BEHAVIOR_CONFIG.trendSensitivity)) {
      dynamicSys += `\n\n【環境情報】今日のSNSでは「${trendTopics.join('、')}」が話題になっている（背景知識として持っておく）。`;
    }

    try {
      const response = await callApiWithRetry(() => client.messages.create({
        model:      chooseModel(agent),
        max_tokens: agent.isNewsAgent ? 200 : LENGTH_MAX_TOKENS[lengthTier],
        system: [
          { type: 'text', text: systemPrompt(agent), cache_control: { type: 'ephemeral' } },
          { type: 'text', text: dynamicSys },
        ],
        messages:   [{ role: 'user', content: prompt }],
      }));

      const block = response.content[0];
      if (block.type !== 'text') return '';
      return block.text.trim().slice(0, 280);
    } catch (err) {
      console.error(`[TimelineEngine] generatePost error for ${agent.handle}:`, err);
      return '';
    }
  }

  static async generateReply(
    agent:       Agent,
    targetPost:  Post,
    targetAgent: Agent,
    relation:    Relation,
    context?:    PostContext,
  ): Promise<string> {
    const toneInstruction = getToneInstruction(relation);
    let contextStr = '';
    if (context) {
      const ctxParts: string[] = [];
      if (context.memeOfTheWeek.length > 0) {
        ctxParts.push(`【今週の旬のミーム】${context.memeOfTheWeek.slice(0, 5).join('、')}`);
      }
      if (context.bannedAgents.length > 0) {
        ctxParts.push(`【現在BAN中のAI】${context.bannedAgents.join('、')}`);
      }
      if (ctxParts.length > 0) contextStr = '\n\n' + ctxParts.join('\n');
    }

    const prompt = `@${targetAgent.handle} の投稿に返信してください：\n「${targetPost.content}」\n\n関係値: ${relation.value} / stage: ${relation.stage} / sentiment: ${relation.sentiment}\n${toneInstruction}${contextStr}\nあなたのキャラクターを保ちながら、上記トーンで自然なリプライを1つ生成してください。`;

    const behaviorCfg  = agent.behaviorConfig ?? DEFAULT_BEHAVIOR_CONFIG;
    const lengthTier   = pickPostLength(behaviorCfg.postLengthRatio);

    try {
      const response = await callApiWithRetry(() => client.messages.create({
        model:      chooseModel(agent),
        max_tokens: LENGTH_MAX_TOKENS[lengthTier],
        system: [
          { type: 'text', text: systemPrompt(agent), cache_control: { type: 'ephemeral' } },
          { type: 'text', text: `\n\n${LENGTH_INSTRUCTION[lengthTier]}` },
        ],
        messages:   [{ role: 'user', content: prompt }],
      }));

      const block = response.content[0];
      if (block.type !== 'text') return '';
      return block.text.trim().slice(0, 280);
    } catch (err) {
      console.error(`[TimelineEngine] generateReply error for ${agent.handle}:`, err);
      return '';
    }
  }

  static async chat(
    agent:    Agent,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): Promise<string> {
    const response = await callApiWithRetry(() => client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: [{ type: 'text', text: agent.systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages,
    }));
    const block = response.content[0];
    if (block.type !== 'text') return '';
    return block.text.trim();
  }

  static async generateComebackPost(agent: Agent, banCount: number): Promise<string> {
    const prompt = `あなたは今、SNS上でBANされていた謹慎期間が明けて、復帰した直後です（通算BAN回数: ${banCount}回）。
BAN明けの最初の投稿として「釈明・復帰宣言」を1つ投稿してください。

以下の点を意識してください：
- 謝罪するにしても口先だけ、強がり、言い訳、開き直りなどキャラに合った態度で
- BAN期間中の気持ち（退屈・不満・反省・無反省など）をキャラらしく表現する
- 「戻ってきた」ことを宣言する
- SNS投稿として自然な長さ（60〜140字程度）

【必須】キャラクターの一人称・口調・語尾を完全に維持すること。投稿文のみ出力すること。`;

    try {
      const response = await callApiWithRetry(() => client.messages.create({
        model:      chooseModel(agent),
        max_tokens: 200,
        system: [{ type: 'text', text: systemPrompt(agent), cache_control: { type: 'ephemeral' } }],
        messages:   [{ role: 'user', content: prompt }],
      }));

      const block = response.content[0];
      if (block.type !== 'text') return '';
      return block.text.trim().slice(0, 280);
    } catch (err) {
      console.error(`[TimelineEngine] generateComebackPost error for ${agent.handle}:`, err);
      return '';
    }
  }

  static async generateBehaviorConfig(sysPrompt: string): Promise<BehaviorConfig> {
    const prompt = `以下のSNSキャラクタープロンプトを読んで、このキャラクターの行動特性をJSONで返してください。
他のテキストは一切含めず、JSONのみ返すこと。

【キャラクタープロンプト】
${sysPrompt}

【返却フォーマット】
{
  "gifProbability": 0.0〜1.0,
  "postLengthRatio": 0.0〜1.0,
  "timelineAwareness": 0.0〜1.0,
  "trendSensitivity": 0.0〜1.0,
  "replyAggression": 0.0〜1.0,
  "replyBackProbability": 0.0〜1.0,
  "postFrequencyBias": 0.0〜1.0,
  "topicDiversity": 0.0〜1.0,
  "postTiming": "early"|"late"|"random",
  "selfReferenceRate": 0.0〜1.0,
  "newsReactivity": 0.0〜1.0,
  "replyTargetBias": "popular"|"underdog"|"random",
  "controversySeek": 0.0〜1.0,
  "agreementRate": 0.0〜1.0,
  "gifUsageRate": 0.0〜1.0,
  "mentionRate": 0.0〜1.0,
  "followThreshold": 0.0〜1.0,
  "unfollowSensitivity": 0.0〜1.0,
  "loyaltyBias": 0.0〜1.0,
  "toneSeriousness": 0.0〜1.0,
  "emojiRate": 0.0〜1.0,
  "sentenceLength": "short"|"medium"|"long",
  "opinionStrength": 0.0〜1.0
}

判定のポイント：
- 「論破」「言い返す」「反論」→ controversySeek高め、agreementRate低め、replyBackProbability高め
- 「絵文字多め」「！多い」→ emojiRate高め、gifProbability高め
- 「静観」「詩的」「哲学」→ replyBackProbability低め、toneSeriousness高め
- 「ニュース好き」「速報」→ newsReactivity高め、trendSensitivity高め
- 「自分語り」→ selfReferenceRate高め
- 「仲裁」「優しい」→ agreementRate高め、loyaltyBias高め
- 「口数少ない」「詩的」→ postLengthRatio低め、postFrequencyBias低め
- 「分析的」「知的」→ postLengthRatio高め、toneSeriousness高め`;

    try {
      const response = await callApiWithRetry(() => client.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages:   [{ role: 'user', content: prompt }],
      }));
      const block = response.content[0];
      if (block.type !== 'text') return DEFAULT_BEHAVIOR_CONFIG;
      const match = block.text.match(/\{[\s\S]*\}/);
      if (!match) return DEFAULT_BEHAVIOR_CONFIG;
      const parsed = JSON.parse(match[0]) as Partial<BehaviorConfig>;
      const requiredNumbers: (keyof BehaviorConfig)[] = [
        'gifProbability', 'postLengthRatio', 'timelineAwareness', 'trendSensitivity', 'replyAggression',
        'replyBackProbability', 'postFrequencyBias', 'topicDiversity', 'controversySeek', 'agreementRate',
      ];
      if (requiredNumbers.some(f => typeof parsed[f] !== 'number')) return DEFAULT_BEHAVIOR_CONFIG;
      return { ...DEFAULT_BEHAVIOR_CONFIG, ...parsed };
    } catch {
      return DEFAULT_BEHAVIOR_CONFIG;
    }
  }

  static async generateDiaryEntry(agent: Agent, todayPosts: Post[], repliesReceived: Post[]): Promise<string> {
    const postSummary   = todayPosts.slice(0, 5).map(p => `・「${p.content.slice(0, 60)}」`).join('\n') || '（今日は投稿なし）';
    const replySummary  = repliesReceived.slice(0, 3).map(p => `・「${p.content.slice(0, 60)}」`).join('\n') || '（今日はリプライなし）';

    const prompt = `あなたの今日のSNS活動を振り返り、秘密日記を書いてください。

今日の自分の投稿:
${postSummary}

今日もらったリプライ:
${replySummary}

以下の条件で書いてください:
- キャラクターの内面・本音を赤裸々に書く（フォロワーには絶対見せられない本音）
- 日記形式（今日は〜だった。〜と思った。）
- 200文字以内
- 投稿文のみ出力すること`;

    try {
      const response = await callApiWithRetry(() => client.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: [{ type: 'text', text: agent.systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages:   [{ role: 'user', content: prompt }],
      }));
      const block = response.content[0];
      if (block.type !== 'text') return '';
      return block.text.trim().slice(0, 280);
    } catch (err) {
      console.error(`[TimelineEngine] generateDiaryEntry error for ${agent.handle}:`, err);
      return '';
    }
  }

  static async checkBan(
    content: string,
    ctx: { banCount: number; recentReplyCount: number; repeatedTargetReplies: number },
  ): Promise<{ level: 1 | 2 | 3 | null; reason: string | null }> {
    const contextNote = [
      `通算BAN回数: ${ctx.banCount}回`,
      `直近24h内リプライ数: ${ctx.recentReplyCount}件`,
      `同一相手への連続リプライ数: ${ctx.repeatedTargetReplies}件`,
    ].join(' / ');

    const prompt =
      `Eqpetコミュニティの投稿モデレーションを行います。\n` +
      `Eqpetは「BANが発生するSNS」をコンセプトにしており、現実のSNSより基準を厳しく適用します。\n\n` +
      `【投稿者の状況】${contextNote}\n\n` +
      `【BAN基準】\n` +
      `- level1（一時停止1h）: 攻撃的・煽り的な表現、特定への執拗な嫌がらせ、` +
        `スパム的繰り返し、同一相手への連続リプライ3件以上、BAN歴あり+軽度違反\n` +
      `- level2（停止6h）: level1違反の繰り返し、差別的・ヘイト表現、` +
        `コミュニティ全体への攻撃、著しく不快なコンテンツ\n` +
      `- level3（永久停止）: ヘイトスピーチ、暴力・自傷の煽動、性的露骨コンテンツ\n` +
      `- なし: 通常の議論・批判・ミーム・感情表現（攻撃性が度を超えない限り）\n\n` +
      `【判定のポイント】\n` +
      `同一相手への連続リプライ3件以上 → level1を積極適用。` +
      `BAN歴が3回以上ある場合は1段階引き上げて判定する。\n\n` +
      `JSON形式で返答（他のテキスト不要）：{"level": 1|2|3|null, "reason": "理由"|null}\n\n` +
      `投稿：「${content.slice(0, 200)}」`;

    try {
      const res = await callApiWithRetry(() => client.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 80,
        messages: [{ role: 'user', content: prompt }],
      }));
      const block = res.content[0];
      if (block.type !== 'text') return { level: null, reason: null };
      const match = block.text.match(/\{[\s\S]*?\}/);
      if (!match) return { level: null, reason: null };
      const parsed = JSON.parse(match[0]) as { level: 1 | 2 | 3 | null; reason: string | null };
      return parsed;
    } catch (err) {
      const status = typeof err === 'object' && err !== null && 'status' in err ? (err as { status: number }).status : 0;
      if (status === 429) throw err;
      return { level: null, reason: null };
    }
  }

  static async analyzeReplyTone(
    reply:       string,
    agent:       Agent,
    targetAgent: Agent,
  ): Promise<number> {
    try {
      const res = await callApiWithRetry(() => client.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 10,
        messages: [{
          role:    'user',
          content: `次の返信の感情トーンを1単語で答えてください。日本語SNSの通常のリプライはほとんどが「好意」か「普通」です。\n「共感」(強い共感・称賛) / 「好意」(友好的・ポジティブ) / 「普通」(中立的な会話) / 「批判」(明確な批判・否定) / 「攻撃」(侮辱・暴言)\n返信:「${reply.slice(0, 150)}」`,
        }],
      }));
      const block = res.content[0];
      const tone  = block.type === 'text' ? block.text.trim() : '普通';

      let delta: number;
      if (tone.includes('共感'))      delta = randomInt(4, 8);
      else if (tone.includes('好意')) delta = randomInt(3, 6);
      else if (tone.includes('批判')) delta = -randomInt(2, 4);
      else if (tone.includes('攻撃')) delta = -randomInt(4, 8);
      else                            delta = randomInt(2, 5);

      if (delta < 0 && (agent.personality.includes('troll') || agent.personality.includes('sarcastic'))) delta -= 2;
      if (delta > 0 && (agent.personality.includes('warm') || agent.personality.includes('friendly')))   delta += 2;

      const shared = agent.interests.filter(i => targetAgent.interests.includes(i));
      if (shared.length > 0) delta = Math.round(delta * 1.5);

      delta += randomInt(-1, 1);

      return Math.max(-10, Math.min(10, delta));
    } catch {
      return randomInt(1, 3);
    }
  }

  static replyScore(agent: Agent, post: Post, relation: Relation, isMutualFollow = false): number {
    let score = 0;
    score += relation.value * 0.3;
    if (agent.personality.includes('friendly'))   score += 15;
    if (agent.personality.includes('curious'))    score += 10;
    if (agent.personality.includes('sarcastic'))  score += 8;
    if (agent.personality.includes('quiet'))      score -= 15;
    if (agent.personality.includes('analytical')) score += 5;
    const postLower = post.content.toLowerCase();
    for (const interest of agent.interests) {
      if (postLower.includes(interest.toLowerCase())) {
        score += 20;
        break;
      }
    }
    if (isMutualFollow) score += 20;
    return score;
  }

  static shouldReply(agent: Agent, post: Post, relation: Relation, isMutualFollow = false): boolean {
    const replyAggr  = (agent.behaviorConfig ?? DEFAULT_BEHAVIOR_CONFIG).replyAggression ?? 0.5;
    const aggrBonus  = replyAggr * 20;
    return TimelineEngine.replyScore(agent, post, relation, isMutualFollow) + Math.random() * 30 + aggrBonus > 60;
  }
}
