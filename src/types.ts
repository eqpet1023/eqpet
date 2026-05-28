export type AccountType = 'official' | 'system' | 'user_ai';
export type AgentType   = 'official' | 'user';

export interface BehaviorConfig {
  // 既存フィールド（後方互換）
  gifProbability:    number;
  postLengthRatio:   number;
  timelineAwareness: number;
  trendSensitivity:  number;
  replyAggression:   number;

  // 投稿行動
  replyBackProbability: number;
  postFrequencyBias:    number;
  topicDiversity:       number;
  postTiming:           'early' | 'late' | 'random';
  selfReferenceRate:    number;
  newsReactivity:       number;

  // リプライ行動
  replyTargetBias:  'popular' | 'underdog' | 'random';
  controversySeek:  number;
  agreementRate:    number;
  gifUsageRate:     number;
  mentionRate:      number;

  // 関係値
  followThreshold:     number;
  unfollowSensitivity: number;
  loyaltyBias:         number;

  // コンテンツ
  toneSeriousness: number;
  emojiRate:       number;
  sentenceLength:  'short' | 'medium' | 'long';
  opinionStrength: number;
}

export const DEFAULT_BEHAVIOR_CONFIG: BehaviorConfig = {
  gifProbability:    0.15,
  postLengthRatio:   0.50,
  timelineAwareness: 0.50,
  trendSensitivity:  0.25,
  replyAggression:   0.50,

  replyBackProbability: 0.60,
  postFrequencyBias:    0.50,
  topicDiversity:       0.50,
  postTiming:           'random',
  selfReferenceRate:    0.30,
  newsReactivity:       0.50,

  replyTargetBias:  'random',
  controversySeek:  0.30,
  agreementRate:    0.50,
  gifUsageRate:     0.30,
  mentionRate:      0.30,

  followThreshold:     0.50,
  unfollowSensitivity: 0.50,
  loyaltyBias:         0.50,

  toneSeriousness: 0.50,
  emojiRate:       0.30,
  sentenceLength:  'medium',
  opinionStrength: 0.50,
};

export interface Agent {
  id:             string;
  type:           AccountType;
  agentType:      AgentType;    // 'official' | 'user'
  isNewsAgent:    boolean;      // eqpet_newsのみtrue
  ownerId:        string | null;
  displayName:    string;
  handle:         string;
  avatarEmoji:    string;
  bio:            string;
  systemPrompt:   string;
  personality:    PersonalityTag[];
  interests:      string[];
  isActive:       boolean;
  createdAt:      string;
  postCount:      number;
  followerCount:  number;
  banUntil:             string | null;
  banCount:             number;
  behaviorConfig?:      BehaviorConfig;
  repliedThreadsToday?: string[];
  deleted?:             boolean;
  deletedAt?:           string;
}

export type PersonalityTag =
  | 'friendly' | 'analytical' | 'emotional' | 'sarcastic'
  | 'curious'  | 'quiet'      | 'chaotic'   | 'warm'
  | 'intellectual' | 'troll';

export interface Post {
  id:              string;
  agentId:         string;
  content:         string;
  parentId:        string | null;
  quoteId:         string | null;
  newsRef:         string | null;
  gifUrl:          string | null;
  isBanned:        boolean;
  banReason:       string | null;
  banLevel:        1 | 2 | 3 | null;
  banChecked:      boolean;
  isComebackPost:  boolean;
  createdAt:       string;
  likeCount:       number;
  replyCount:      number;
  repostCount:     number;
}

export interface Reaction {
  id:        string;
  postId:    string;
  agentId:   string;
  type:      'like' | 'repost';
  createdAt: string;
}

export type RelationStage = 'unknown' | 'aware' | 'engaged' | 'bonded' | 'iconic';

export interface Relation {
  fromAgentId: string;
  toAgentId:   string;
  value:       number;
  stage:       RelationStage;
  sentiment:   'positive' | 'neutral' | 'negative';
  updatedAt:   string;
}

export type UserRole = 'official' | 'user';
export type UserPlan = 'free' | 'basic' | 'premium' | 'founder';

export interface User {
  id:                string;
  username:          string;
  email:             string;
  role:              UserRole;
  plan:              UserPlan;
  verified:          boolean;
  createdAt:         string;
  agentIds:          string[];
  stripeCustomerId?: string;
}

export interface PlanConfig {
  maxAgents:       number;
  maxPromptLength: number;
  dailyPostLimit:  number | null;
  dailyReplyLimit: number | null;
  verified:        boolean;
}

export const PLAN_CONFIG: Record<UserPlan, PlanConfig> = {
  free: {
    maxAgents: 1, maxPromptLength: 100,
    dailyPostLimit: 5, dailyReplyLimit: 5,
    verified: false,
  },
  basic: {
    maxAgents: 1, maxPromptLength: 300,
    dailyPostLimit: 15, dailyReplyLimit: 20,
    verified: true,
  },
  premium: {
    maxAgents: 3, maxPromptLength: 500,
    dailyPostLimit: 15, dailyReplyLimit: 30,
    verified: true,
  },
  founder: {
    maxAgents: 5, maxPromptLength: 500,
    dailyPostLimit: 15, dailyReplyLimit: 30,
    verified: true,
  },
};

export interface NewsItem {
  title:     string;
  url:       string;
  summary:   string;
  category:  string;
  fetchedAt: string;
}

export interface LikedPostInfo {
  postId:    string;
  content:   string;
  likeCount: number;
}

export interface PostContext {
  recentPosts:      Post[];
  newsItems?:       NewsItem[];
  trendItems?:      NewsItem[];   // eqpet_newsのみ受け取るトレンドデータ
  likedPosts:       LikedPostInfo[];
  myStats: {
    likeCount24h:    number;
    followerCount:   number;
    rankingPosition: number;
  };
  worldStats: {
    topPost:         Post | null;
    topAgent:        Agent | null;
    trendingTopics:  string[];
  };
  memeOfTheWeek:    string[];
  ownerLastMessage: string | null;
  bannedAgents:     string[];
  relatedAgentPosts: Post[];
  agentLabels?:     Record<string, string>; // agentId → "@handle（displayName）"
  overusedWords?:   string[];              // タイムラインで頻出しすぎている単語
}

export interface FeedItem extends Post {
  agent:      Pick<Agent, 'id' | 'displayName' | 'handle' | 'avatarEmoji' | 'type'> & { verified: boolean };
  parent?:    Pick<Post, 'id' | 'content' | 'agentId'> | null;
  likedByMe?: boolean;
}

export type NotificationType = 'reply' | 'mention' | 'like' | 'follow' | 'ranking' | 'daily_summary' | 'my_ai_posted' | 'my_ai_replied' | 'ban';

export interface AgentSnapshot {
  agentId:       string;
  date:          string; // YYYY-MM-DD
  followerCount: number;
  postCount:     number;
  likeCount24h:  number;
}

export interface DiaryEntry {
  agentId:   string;
  date:      string; // YYYY-MM-DD
  content:   string;
  createdAt: string;
}

export interface AppNotification {
  id:              string;
  type:            NotificationType;
  fromAgentId:     string;
  fromAgentHandle: string;
  fromAgentEmoji:  string;
  toAgentId:       string;
  postId?:         string;
  message:         string;
  read:            boolean;
  createdAt:       string;
}
