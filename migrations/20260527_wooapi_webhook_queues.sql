-- WooAPI webhook queues, per-instance webhooks and delivery logs.

create table if not exists wooapi_events (
  id bigserial primary key,
  account_id bigint references accounts(id) on delete cascade,
  instance_id bigint references instances(id) on delete cascade,
  event_id text not null unique,
  event text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists instance_webhooks (
  id bigserial primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  instance_id bigint not null references instances(id) on delete cascade,
  name text,
  url text not null,
  secret text not null default ('whsec_' || encode(gen_random_bytes(24), 'hex')),
  events jsonb not null default '[]'::jsonb,
  is_active boolean not null default true,
  retry_enabled boolean not null default true,
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists instance_webhooks_set_updated_at on instance_webhooks;
create trigger instance_webhooks_set_updated_at
before update on instance_webhooks
for each row execute function set_updated_at();

alter table webhook_events add column if not exists webhook_id bigint references instance_webhooks(id) on delete set null;
alter table webhook_events add column if not exists url text;

create table if not exists webhook_delivery_logs (
  id bigserial primary key,
  account_id bigint references accounts(id) on delete set null,
  tenant_id text,
  instance_id bigint references instances(id) on delete set null,
  webhook_id bigint references instance_webhooks(id) on delete set null,
  webhook_event_id bigint references webhook_events(id) on delete set null,
  event text not null,
  url text not null,
  status_code integer,
  success boolean not null default false,
  attempt integer not null default 1,
  request_payload jsonb,
  response_body text,
  error text,
  duration_ms integer,
  created_at timestamptz not null default now()
);

create index if not exists idx_wooapi_events_instance on wooapi_events(instance_id);
create index if not exists idx_wooapi_events_event_id on wooapi_events(event_id);
create index if not exists idx_instance_webhooks_instance on instance_webhooks(instance_id);
create index if not exists idx_instance_webhooks_active on instance_webhooks(instance_id, is_active);
create index if not exists idx_webhook_events_webhook on webhook_events(webhook_id);
create index if not exists idx_webhook_delivery_logs_instance on webhook_delivery_logs(instance_id);
create index if not exists idx_webhook_delivery_logs_webhook on webhook_delivery_logs(webhook_id);
create index if not exists idx_webhook_delivery_logs_event on webhook_delivery_logs(webhook_event_id);
