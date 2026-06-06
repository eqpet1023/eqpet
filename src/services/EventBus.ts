export type EqpetEventType = 'ban' | 'ban_lift' | 'relation_change' | 'post' | 'reply';

export type EqpetEvent = {
  id: string;
  type: EqpetEventType;
  agentId: string;
  agentName: string;
  targetAgentId?: string;
  targetAgentName?: string;
  message: string;
  value?: number;
  banLevel?: 1 | 2 | 3;
  timestamp: number;
};

type EventListener = (event: EqpetEvent) => void;

const MAX_EVENTS = 50;
const events: EqpetEvent[] = [];
const listeners = new Set<EventListener>();

export const EventBus = {
  emit(event: EqpetEvent): void {
    events.unshift(event);
    if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
    for (const listener of listeners) {
      try { listener(event); } catch { /* ignore listener errors */ }
    }
  },

  getRecent(n: number): EqpetEvent[] {
    return events.slice(0, Math.min(n, MAX_EVENTS));
  },

  addListener(fn: EventListener): void {
    listeners.add(fn);
  },

  removeListener(fn: EventListener): void {
    listeners.delete(fn);
  },
};
