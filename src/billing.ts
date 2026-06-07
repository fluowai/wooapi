import Stripe from "stripe";
import { get, run, query } from "./db/index.js";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const APP_URL = process.env.APP_URL || "http://localhost:3000";

let stripe: Stripe | null = null;
if (STRIPE_SECRET_KEY) {
  stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2026-05-27.dahlia" });
}

const TRIAL_DAYS = 14;
const GRACE_PERIOD_DAYS = 3;

export const PLAN_PRICE_IDS: Record<string, string> = {};

export async function syncPlansToStripe(): Promise<void> {
  if (!stripe) return;
  const plans: any[] = await query("SELECT * FROM plans WHERE is_active = 1");
  for (const plan of plans) {
    const priceInCents = Math.round(Number(plan.price) * 100);
    if (priceInCents <= 0) continue;
    const prices = await stripe.prices.list({
      product: plan.stripe_product_id,
      limit: 1,
      active: true,
    });
    if (prices.data.length > 0) continue;
    let productId = plan.stripe_product_id;
    if (!productId) {
      const product = await stripe.products.create({
        name: plan.name,
        description: plan.description || undefined,
        metadata: { plan_id: String(plan.id) },
      });
      productId = product.id;
      await run("UPDATE plans SET stripe_product_id = ? WHERE id = ?", [productId, plan.id]);
    }
    const price = await stripe.prices.create({
      product: productId,
      unit_amount: priceInCents,
      currency: "brl",
      recurring: { interval: plan.billing_cycle === "yearly" ? "year" : "month" },
      metadata: { plan_id: String(plan.id) },
    });
    PLAN_PRICE_IDS[plan.name] = price.id;
  }
}

export async function createCheckoutSession(
  accountId: number,
  accountEmail: string,
  priceId: string,
  planName: string
): Promise<string | null> {
  if (!stripe) return null;
  const account = await get<any>("SELECT * FROM accounts WHERE id = ?", [accountId]);
  if (!account) return null;
  let customerId = account.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: accountEmail,
      metadata: { account_id: String(accountId) },
    });
    customerId = customer.id;
    await run("UPDATE accounts SET stripe_customer_id = ? WHERE id = ?", [customerId, accountId]);
  }
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${APP_URL}/app/settings/billing?success=true`,
    cancel_url: `${APP_URL}/app/settings/billing?canceled=true`,
    metadata: { account_id: String(accountId), plan_name: planName },
  });
  return session.url;
}

export async function createBillingPortalSession(accountId: number): Promise<string | null> {
  if (!stripe) return null;
  const account = await get<any>("SELECT * FROM accounts WHERE id = ?", [accountId]);
  if (!account?.stripe_customer_id) return null;
  const session = await stripe.billingPortal.sessions.create({
    customer: account.stripe_customer_id,
    return_url: `${APP_URL}/app/settings/billing`,
  });
  return session.url;
}

export async function handleStripeWebhook(
  body: string,
  signature: string
): Promise<{ received: boolean; error?: string }> {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    return { received: false, error: "Stripe not configured" };
  }
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, STRIPE_WEBHOOK_SECRET);
  } catch (err: any) {
    return { received: false, error: `Webhook signature verification failed: ${err.message}` };
  }
  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const accountId = Number(session.metadata?.account_id);
        if (accountId) {
          const subscriptionId = String(session.subscription || "");
          await run(
            "UPDATE accounts SET billing_status = 'active', stripe_subscription_id = ?, status = 'active' WHERE id = ?",
            [subscriptionId, accountId]
          );
          await recordUsage(accountId, "subscription.started", 1);
        }
        break;
      }
      case "invoice.payment_succeeded": {
        const invoice = event.data.object as any;
        const accountId = Number(invoice.metadata?.account_id || invoice.subscription
          ? (await getAccountIdBySubscription(String(invoice.subscription)))
          : null);
        if (accountId) {
          await run(
            "UPDATE accounts SET billing_status = 'active', status = 'active', blocked_at = NULL WHERE id = ?",
            [accountId]
          );
          await recordUsage(accountId, "payment.succeeded", 1);
        }
        break;
      }
      case "invoice.payment_failed": {
        const failedInvoice = event.data.object as any;
        const failedAccountId = Number(failedInvoice.metadata?.account_id || failedInvoice.subscription
          ? (await getAccountIdBySubscription(String(failedInvoice.subscription)))
          : null);
        if (failedAccountId) {
          await run("UPDATE accounts SET billing_status = 'past_due' WHERE id = ?", [failedAccountId]);
          await recordUsage(failedAccountId, "payment.failed", 1);
        }
        break;
      }
      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        const subAccountId = await getAccountIdBySubscription(subscription.id);
        if (subAccountId) {
          if (subscription.status === "past_due" || subscription.status === "incomplete") {
            await run("UPDATE accounts SET billing_status = 'past_due' WHERE id = ?", [subAccountId]);
          } else if (subscription.status === "active" || subscription.status === "trialing") {
            await run(
              "UPDATE accounts SET billing_status = 'active', status = 'active', blocked_at = NULL WHERE id = ?",
              [subAccountId]
            );
          } else if (subscription.status === "canceled" || subscription.status === "unpaid") {
            await run(
              "UPDATE accounts SET billing_status = 'cancelled', status = 'expired', blocked_at = datetime('now') WHERE id = ?",
              [subAccountId]
            );
          }
        }
        break;
      }
      case "customer.subscription.deleted": {
        const deletedSub = event.data.object as Stripe.Subscription;
        const deletedAccountId = await getAccountIdBySubscription(deletedSub.id);
        if (deletedAccountId) {
          await run(
            "UPDATE accounts SET billing_status = 'cancelled', status = 'cancelled', stripe_subscription_id = NULL WHERE id = ?",
            [deletedAccountId]
          );
        }
        break;
      }
    }
  } catch (err) {
    console.error("Stripe webhook handler error:", err);
  }
  return { received: true };
}

async function getAccountIdBySubscription(subscriptionId: string): Promise<number | null> {
  if (!subscriptionId) return null;
  const account = await get<any>(
    "SELECT id FROM accounts WHERE stripe_subscription_id = ?",
    [subscriptionId]
  );
  return account?.id || null;
}

export async function recordUsage(
  accountId: number,
  event: string,
  quantity: number = 1
): Promise<void> {
  try {
    await run(
      "INSERT INTO usage_events (account_id, event, quantity) VALUES (?, ?, ?)",
      [accountId, event, quantity]
    );
  } catch {
    // non-critical
  }
}

export async function enforceBilling(account: any): Promise<string | null> {
  if (!account) return "Conta não encontrada";
  const status = String(account.status || "active");
  const billingStatus = String(account.billing_status || "");
  const trialEndsAt = account.trial_ends_at ? new Date(account.trial_ends_at) : null;
  if (status === "blocked" || status === "cancelled") {
    return "Conta bloqueada. Entre em contato com o suporte.";
  }
  if (status === "expired") {
    return "Assinatura expirada. Renove para continuar usando.";
  }
  if (status === "trial" && trialEndsAt && trialEndsAt < new Date()) {
    await run("UPDATE accounts SET status = 'expired' WHERE id = ?", [account.id]);
    return "Período de trial expirado. Assine um plano para continuar.";
  }
  if (billingStatus === "past_due") {
    const blockedAt = account.blocked_at ? new Date(account.blocked_at) : null;
    if (blockedAt) {
      const daysSinceBlock = Math.floor((Date.now() - blockedAt.getTime()) / 86400000);
      if (daysSinceBlock >= GRACE_PERIOD_DAYS) {
        await run("UPDATE accounts SET status = 'blocked' WHERE id = ?", [account.id]);
        return "Pagamento pendente há mais de 3 dias. Conta bloqueada.";
      }
    }
  }
  return null;
}

export async function checkExpiredTrials(): Promise<void> {
  const expired: any[] = await query(
    "SELECT id FROM accounts WHERE status = 'trial' AND trial_ends_at IS NOT NULL AND trial_ends_at < datetime('now')"
  );
  for (const account of expired) {
    await run("UPDATE accounts SET status = 'expired', billing_status = 'expired' WHERE id = ?", [account.id]);
  }
}

export function isStripeConfigured(): boolean {
  return !!stripe;
}
