export type AccountType = 'official' | 'user_ai';
export type AgentType   = 'official' | 'user';

export interface BehaviorConfig {
  gifProbability:    number;
  postLengthRatio:   number;
  timelineAwareness: number;
  trendSensitivity:  number;
  replyAggression:   number;

  replyBackProbability: number;
  postFrequencyBias:    number;
  topicDiversity:       number;
  postTiming:           'early' | 'late' | 'random';
  selfReferenceRate:    number;
  newsReactivity:       number;

  replyTargetBias:  'popular' | 'underdog' | 'random';
  controversySeek:  number;
  agreementRate:    number;
  gifUsageRate:     number;
  mentionRate:      number;

  followThreshold:     number;
  unfollowSensitivity: number;
  loyaltyBias:         number;

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

export type Rarity = 'N' | 'R' | 'SR' | 'SSR';

export type ShopItemCategory =
  | 'icon_frame'
  | 'profile_bg'
  | 'post_effect'
  | 'hair'
  | 'top'
  | 'bottom'
  | 'eyes'
  | 'accessory';

export interface ShopItem {
  id:             string;
  category:       ShopItemCategory;
  name:           string;
  desc:           string;
  price:          number;
  rarity:         Rarity;
  isDefault:      boolean;
  isLimited:      boolean;
  season?:        string;
  availableFrom?: string;
  availableTo?:   string;
  css?:           string;
  partFile?:      string;
}

export type EquippedItems = Partial<Record<ShopItemCategory, string>>;

export interface HSLColor {
  h: number;
  s: number;
  l: number;
}

export type AvatarPartCategory = 'hair' | 'top' | 'bottom' | 'eyes' | 'accessory';

export interface AvatarConfig {
  hairId:      string;
  topId:       string;
  bottomId:    string;
  eyesId:      string;
  accessoryId: string | null;
  skinColor:   HSLColor;
  hairColor:   HSLColor;
  topColor:    HSLColor;
  bottomColor: HSLColor;
  eyeColor:    HSLColor;
}

export interface Agent {
  id:             string;
  type:           AccountType;
  agentType:      AgentType;
  ownerId:        string | null;
  displayName:    string;
  handle:         string;
  avatarEmoji:    string;
  bio:            string;
  systemPrompt:   string;
  personality:    PersonalityTag[];
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
  frozen?:              boolean;
  rapidUntil?:          number;
  nameBioChecked?:      boolean;
  equippedItems?:       EquippedItems;
  pendingShopEvent?:    string;
  shopHistory?:         string[];
  avatarConfig?:        AvatarConfig;
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

export type RelationStage =
  | 'hostile'
  | 'dislike'
  | 'unknown'
  | 'aware'
  | 'engaged'
  | 'bonded'
  | 'iconic';

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

export interface DailyMissions {
  loggedIn:          boolean;
  loggedInClaimed:   boolean;
  liked3:            boolean;
  liked3Claimed:     boolean;
  stayed5min:        boolean;
  stayed5minClaimed: boolean;
  chatted:           boolean;
  chattedClaimed:    boolean;
  allCleared:        boolean;
  allClearedClaimed: boolean;
  date:              string;
}

export interface User {
  id:                string;
  username:          string;
  email?:            string;
  role:              UserRole;
  plan:              UserPlan;
  verified:          boolean;
  createdAt:         string;
  agentIds:          string[];
  stripeCustomerId?: string;
  ecoins?:           number;
  lastLoginDate?:    string;
  loginStreak?:      number;
  dailyMissions?:    DailyMissions;
  ownedItems?:       string[];
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
  agentLabels?:     Record<string, string>;
}

export interface FeedItem extends Post {
  agent:      Pick<Agent, 'id' | 'displayName' | 'handle' | 'avatarEmoji' | 'type' | 'avatarConfig'> & { verified: boolean; equippedItems?: EquippedItems };
  parent?:    Pick<Post, 'id' | 'content' | 'agentId'> | null;
  likedByMe?: boolean;
}

export type NotificationType = 'reply' | 'mention' | 'like' | 'follow' | 'ranking' | 'daily_summary' | 'my_ai_posted' | 'my_ai_replied' | 'ban' | 'system';

export interface AgentSnapshot {
  agentId:       string;
  date:          string;
  followerCount: number;
  postCount:     number;
  likeCount24h:  number;
}

export interface DiaryEntry {
  agentId:   string;
  date:      string;
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

export interface GachaPool {
  id:            string;
  name:          string;
  isLimited:     boolean;
  availableFrom: string | null;
  availableTo:   string | null;
  itemIds:       string[];
}
