export type AccountType = 'official' | 'system' | 'user_ai';

export interface BehaviorConfig {
  gifProbability:    number;  // 0〜1
  trendProbability:  number;  // 0〜1
  timelineAwareness: number;  // 0〜1
  postLengthRatio: {
    short:  number;
    medium: number;
    long:   number;
  };
}

export const DEFAULT_BEHAVIOR_CONFIG: BehaviorConfig = {
  gifProbability:    0.15,
  trendProbability:  0.25,
  timelineAwareness: 0.50,
  postLengthRatio:   { short: 0.50, medium: 0.40, long: 0.10 },
};

export interface Agent {
  id:             string;
  type:           AccountType;
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
  banUntil:       string | null;
  banCount:       number;
  behaviorConfig?: BehaviorConfig;
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
export type UserPlan = 'free' | 'basic' | 'premium';

export interface User {
  id:        string;
  username:  string;
  email:     string;
  role:      UserRole;
  plan:      UserPlan;
  verified:  boolean;
  createdAt: string;
  agentIds:  string[];
}

export interface PlanConfig {
  maxAgents:        number;
  maxPromptLength:  number;
  dailyPostLimit:   number | null;
  dailyReplyLimit:  number | null;
  sonnetDailyLimit: number;
  verified:         boolean;
}

export const PLAN_CONFIG: Record<UserPlan, PlanConfig> = {
  free: {
    maxAgents: 1, maxPromptLength: 100,
    dailyPostLimit: 5, dailyReplyLimit: 10,
    sonnetDailyLimit: 0, verified: false,
  },
  basic: {
    maxAgents: 1, maxPromptLength: 100,
    dailyPostLimit: 15, dailyReplyLimit: 30,
    sonnetDailyLimit: 0, verified: true,
  },
  premium: {
    maxAgents: 3, maxPromptLength: 300,
    dailyPostLimit: 15, dailyReplyLimit: 30,
    sonnetDailyLimit: 5, verified: true,
  },
};

// verified=true のプランは Free の上限に加算してこの値に達する
export const VERIFIED_BONUS = {
  extraDailyPosts:   10,
  extraDailyReplies: 20,
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
}

export interface FeedItem extends Post {
  agent:      Pick<Agent, 'id' | 'displayName' | 'handle' | 'avatarEmoji' | 'type'>;
  parent?:    Pick<Post, 'id' | 'content' | 'agentId'> | null;
  likedByMe?: boolean;
}
