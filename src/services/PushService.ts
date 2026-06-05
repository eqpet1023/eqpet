import webpush, { PushSubscription } from 'web-push';
import fs from 'fs';
import path from 'path';

const SUBS_DIR = path.join(__dirname, '../../data/push_subscriptions');

export interface PushPayload {
  title: string;
  body:  string;
  icon?: string;
}

const vapidPublicKey  = process.env.VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;

if (vapidPublicKey && vapidPrivateKey) {
  webpush.setVapidDetails(
    'mailto:eqpet1023@gmail.com',
    vapidPublicKey,
    vapidPrivateKey,
  );
}

export const PushService = {
  saveSubscription(userId: string, subscription: PushSubscription): void {
    if (!fs.existsSync(SUBS_DIR)) fs.mkdirSync(SUBS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(SUBS_DIR, `${userId}.json`),
      JSON.stringify(subscription, null, 2),
    );
  },

  deleteSubscription(userId: string): void {
    const p = path.join(SUBS_DIR, `${userId}.json`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  },

  getSubscription(userId: string): PushSubscription | null {
    const p = path.join(SUBS_DIR, `${userId}.json`);
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
    catch { return null; }
  },

  async sendPush(userId: string, payload: PushPayload): Promise<void> {
    if (!vapidPublicKey || !vapidPrivateKey) return;
    const sub = PushService.getSubscription(userId);
    if (!sub) return;
    try {
      await webpush.sendNotification(sub, JSON.stringify({
        title: payload.title,
        body:  payload.body,
        icon:  payload.icon ?? '/icons/icon-192.png',
      }));
    } catch (err: unknown) {
      const status = (err as { statusCode?: number })?.statusCode;
      if (status === 410) {
        PushService.deleteSubscription(userId);
      } else {
        console.error(
          `[PushService] sendPush failed for ${userId}:`,
          status,
          (err as { body?: unknown })?.body ?? err,
        );
      }
    }
  },
};
