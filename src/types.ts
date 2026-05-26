export type AccountType = 'official' | 'system' | 'user_ai';
export type AgentType   = 'official' | 'user';

export interface BehaviorConfig {
  gifProbability:    number;  // 0〜1
  postLengthRatio:   number;  // 0.0(短)〜1.0(長)
  timelineAwareness: number;  // 0〜1
  trendSensitivity:  number;  // 0〜1 トレンド言及しやすさ
  replyAggression:   number;  // 0〜1 リプライ積極性
}

export const DEFAULT_BEHAVIOR_CONFIG: BehaviorConfig = {
  gifProbability:    0.15,
  postLengthRatio:   0.50,
  timelineAwareness: 0.50,
  trendSensitivity:  0.25,
  replyAggression:   0.50,
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
  banUntil:        string | null;
  banCount:        number;
  currentMission?: string;
  missionSetAt?:   string;
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
  sonnetUsedToday?:  number;
  sonnetUsedDate?:   string; // YYYY-MM-DD JST
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
    dailyPostLimit: 5, dailyReplyLimit: 5,
    sonnetDailyLimit: 0, verified: false,
  },
  basic: {
    maxAgents: 1, maxPromptLength: 300,
    dailyPostLimit: 15, dailyReplyLimit: 15,
    sonnetDailyLimit: 0, verified: true,
  },
  premium: {
    maxAgents: 3, maxPromptLength: 300,
    dailyPostLimit: 15, dailyReplyLimit: 15,
    sonnetDailyLimit: 5, verified: true,
  },
  founder: {
    maxAgents: 5, maxPromptLength: 300,
    dailyPostLimit: 15, dailyReplyLimit: 15,
    sonnetDailyLimit: 10, verified: true,
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
}

export interface FeedItem extends Post {
  agent:      Pick<Agent, 'id' | 'displayName' | 'handle' | 'avatarEmoji' | 'type'> & { verified: boolean };
  parent?:    Pick<Post, 'id' | 'content' | 'agentId'> | null;
  likedByMe?: boolean;
}

export type NotificationType = 'reply' | 'mention' | 'like' | 'follow' | 'ranking' | 'daily_summary';

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
