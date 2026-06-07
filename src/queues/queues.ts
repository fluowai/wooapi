import { Queue, type JobsOptions } from "bullmq";
import { redisConnection } from "./redis.connection";

export const WOOAPI_QUEUE_NAMES = {
  webhookDelivery: "webhook-delivery",
  messageSend: "message-send",
  messageScheduled: "message-scheduled",
  messageRetry: "message-retry",
  instanceMonitor: "instance-monitor",
  instanceLifecycle: "instance-lifecycle",
  instanceMigration: "instance-migration",
  supportAlerts: "support-alerts",
  reputationUpdate: "reputation-update",
  chatwootSync: "chatwoot-sync",
  cleanupLogs: "cleanup-logs",
  deadLetter: "dead-letter"
} as const;

export const WOOAPI_QUEUE_DISPLAY_NAMES = {
  webhookDelivery: "wooapi:webhook-delivery",
  messageSend: "wooapi:message-send",
  messageScheduled: "wooapi:message-scheduled",
  messageRetry: "wooapi:message-retry",
  instanceMonitor: "wooapi:instance-monitor",
  instanceLifecycle: "wooapi:instance-lifecycle",
  instanceMigration: "wooapi:instance-migration",
  supportAlerts: "wooapi:support-alerts",
  reputationUpdate: "wooapi:reputation-update",
  chatwootSync: "wooapi:chatwoot-sync",
  cleanupLogs: "wooapi:cleanup-logs",
  deadLetter: "wooapi:dead-letter"
} as const;

export const webhookDeliveryJobOptions: JobsOptions = {
  attempts: 5,
  backoff: {
    type: "exponential",
    delay: 30000
  },
  removeOnComplete: 1000,
  removeOnFail: false
};

export const messageSendJobOptions: JobsOptions = {
  attempts: Number(process.env.MESSAGE_SEND_ATTEMPTS || 5),
  backoff: {
    type: "exponential",
    delay: Number(process.env.MESSAGE_SEND_BACKOFF_MS || 15000)
  },
  removeOnComplete: 2000,
  removeOnFail: false
};

type WooApiQueue = Pick<Queue, "name" | "add" | "getJob" | "getJobCounts" | "close" | "on">;

const queueDriver = process.env.QUEUE_DRIVER || (process.env.NODE_ENV === "production" ? "bullmq" : "database");

function createDatabaseQueue(name: string): WooApiQueue {
  return {
    name,
    add: async () => ({ id: null }) as any,
    getJob: async () => null,
    getJobCounts: async (...statuses: string[]) => Object.fromEntries(statuses.map((status) => [status, 0])) as any,
    close: async () => undefined,
    on: () => undefined as any
  };
}

function createBullMqQueue(name: string, defaultJobOptions?: JobsOptions): WooApiQueue {
  return new Queue(name, {
    prefix: "wooapi",
    connection: redisConnection,
    ...(defaultJobOptions ? { defaultJobOptions } : {})
  });
}

function createQueue(name: string, defaultJobOptions?: JobsOptions): WooApiQueue {
  if (queueDriver === "database") return createDatabaseQueue(name);
  return createBullMqQueue(name, defaultJobOptions);
}

export const webhookDeliveryQueue = createQueue(WOOAPI_QUEUE_NAMES.webhookDelivery, webhookDeliveryJobOptions);
export const messageSendQueue = createQueue(WOOAPI_QUEUE_NAMES.messageSend, messageSendJobOptions);
export const messageScheduledQueue = createQueue(WOOAPI_QUEUE_NAMES.messageScheduled);
export const messageRetryQueue = createQueue(WOOAPI_QUEUE_NAMES.messageRetry);
export const instanceMonitorQueue = createQueue(WOOAPI_QUEUE_NAMES.instanceMonitor);
export const instanceLifecycleQueue = createQueue(WOOAPI_QUEUE_NAMES.instanceLifecycle);
export const instanceMigrationQueue = createQueue(WOOAPI_QUEUE_NAMES.instanceMigration);
export const supportAlertsQueue = createQueue(WOOAPI_QUEUE_NAMES.supportAlerts);
export const reputationUpdateQueue = createQueue(WOOAPI_QUEUE_NAMES.reputationUpdate);
export const chatwootSyncQueue = createQueue(WOOAPI_QUEUE_NAMES.chatwootSync);
export const cleanupLogsQueue = createQueue(WOOAPI_QUEUE_NAMES.cleanupLogs);
export const deadLetterQueue = createQueue(WOOAPI_QUEUE_NAMES.deadLetter);

export const wooapiQueues = [
  webhookDeliveryQueue,
  messageSendQueue,
  messageScheduledQueue,
  messageRetryQueue,
  instanceMonitorQueue,
  instanceLifecycleQueue,
  instanceMigrationQueue,
  supportAlertsQueue,
  reputationUpdateQueue,
  chatwootSyncQueue,
  cleanupLogsQueue,
  deadLetterQueue
];

if (queueDriver !== "database") {
  for (const queue of wooapiQueues) {
    queue.on("error", (error) => {
      console.error(`[WOOAPI_QUEUE_ERROR] ${queue.name}:`, error?.message || error);
    });
  }
}

export async function closeWooApiQueues() {
  await Promise.all(wooapiQueues.map((queue) => queue.close()));
}
