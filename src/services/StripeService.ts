import Stripe from 'stripe';
import fs from 'fs';
import path from 'path';
import { UserStore } from '../stores/UserStore';
import { UserPlan } from '../types';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '');

const PRICE_IDS: Record<'basic' | 'premium' | 'founder', string> = {
  basic:   process.env.STRIPE_PRICE_BASIC   ?? '',
  premium: process.env.STRIPE_PRICE_PREMIUM ?? '',
  founder: process.env.STRIPE_PRICE_FOUNDER ?? '',
};

const FOUNDER_FILE = path.join(__dirname, '../../data/founder.json');

interface FounderData {
  total: number;
  sold:  number;
}

function loadFounder(): FounderData {
  if (!fs.existsSync(FOUNDER_FILE)) return { total: 50, sold: 0 };
  try {
    return JSON.parse(fs.readFileSync(FOUNDER_FILE, 'utf-8')) as FounderData;
  } catch {
    return { total: 50, sold: 0 };
  }
}

function saveFounder(data: FounderData): void {
  fs.writeFileSync(FOUNDER_FILE, JSON.stringify(data, null, 2));
}

export class StripeService {
  static async createCheckoutSession(
    userId: string,
    plan: 'basic' | 'premium' | 'founder',
  ): Promise<string> {
    if (plan === 'founder') {
      const founder = loadFounder();
      if (founder.sold >= founder.total) {
        throw new Error('Founder slots are sold out');
      }
    }

    const appUrl = process.env.APP_URL ?? 'http://localhost:3000';

    const session = await stripe.checkout.sessions.create({
      mode:       plan === 'founder' ? 'payment' : 'subscription',
      line_items: [{ price: PRICE_IDS[plan], quantity: 1 }],
      metadata:   { userId, plan },
      success_url: `${appUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${appUrl}/payment/cancel`,
      allow_promotion_codes: true,
    });

    if (!session.url) throw new Error('Failed to create checkout session URL');
    return session.url;
  }

  static handleWebhook(payload: Buffer, sig: string): void {
    const event = stripe.webhooks.constructEvent(
      payload,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET ?? '',
    );

    if (event.type === 'checkout.session.completed') {
      // TypeScript narrows event.data.object to Checkout.Session via discriminated union
      const session    = event.data.object;
      const userId     = session.metadata?.userId;
      const plan       = session.metadata?.plan as UserPlan | undefined;
      const customerId = typeof session.customer === 'string' ? session.customer : null;

      if (userId && plan) {
        UserStore.update(userId, {
          plan,
          ...(customerId ? { stripeCustomerId: customerId } : {}),
        });

        if (plan === 'founder') {
          const data = loadFounder();
          data.sold += 1;
          saveFounder(data);
        }

        console.log(`[StripeService] plan updated: userId=${userId}, plan=${plan}`);
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      // TypeScript narrows event.data.object to Subscription
      const subscription = event.data.object;
      const customerId   = typeof subscription.customer === 'string'
        ? subscription.customer
        : (subscription.customer as { id: string }).id;

      const user = UserStore.getByStripeCustomerId(customerId);
      if (user) {
        UserStore.update(user.id, { plan: 'free' });
        console.log(`[StripeService] subscription cancelled: userId=${user.id}`);
      }
    }
  }

  static founderSlotsRemaining(): number {
    const data = loadFounder();
    return Math.max(0, data.total - data.sold);
  }

  static async createPortalSession(customerId: string): Promise<string> {
    const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
    const session = await stripe.billingPortal.sessions.create({
      customer:   customerId,
      return_url: appUrl,
    });
    return session.url;
  }
}
