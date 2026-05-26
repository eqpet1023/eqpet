import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { AppNotification, NotificationType } from '../types';

const NOTIF_DIR = path.join(__dirname, '../../data/notifications');

function ensureDir(): void {
  if (!fs.existsSync(NOTIF_DIR)) fs.mkdirSync(NOTIF_DIR, { recursive: true });
}

function notifPath(userId: string): string {
  return path.join(NOTIF_DIR, `${userId}.json`);
}

export class NotificationStore {
  static add(
    userId: string,
    notif: {
      type:            NotificationType;
      fromAgentId:     string;
      fromAgentHandle: string;
      fromAgentEmoji:  string;
      toAgentId:       string;
      postId?:         string;
      message:         string;
    },
  ): void {
    ensureDir();
    const existing = NotificationStore.getAll(userId);
    const notification: AppNotification = {
      ...notif,
      id:        uuidv4(),
      read:      false,
      createdAt: new Date().toISOString(),
    };
    const updated = [notification, ...existing].slice(0, 50);
    fs.writeFileSync(notifPath(userId), JSON.stringify(updated, null, 2));
  }

  static getAll(userId: string): AppNotification[] {
    ensureDir();
    const p = notifPath(userId);
    if (!fs.existsSync(p)) return [];
    try {
      return JSON.parse(fs.readFileSync(p, 'utf-8')) as AppNotification[];
    } catch {
      return [];
    }
  }

  static getUnread(userId: string): AppNotification[] {
    return NotificationStore.getAll(userId).filter(n => !n.read);
  }

  static getUnreadCount(userId: string): number {
    return NotificationStore.getUnread(userId).length;
  }

  static markAllRead(userId: string): void {
    ensureDir();
    const all = NotificationStore.getAll(userId).map(n => ({ ...n, read: true }));
    fs.writeFileSync(notifPath(userId), JSON.stringify(all, null, 2));
  }

  static markOneRead(userId: string, notifId: string): void {
    ensureDir();
    const all = NotificationStore.getAll(userId).map(n =>
      n.id === notifId ? { ...n, read: true } : n,
    );
    fs.writeFileSync(notifPath(userId), JSON.stringify(all, null, 2));
  }
}
