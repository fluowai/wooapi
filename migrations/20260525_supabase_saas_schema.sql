-- WooAPI SaaS schema for Supabase/PostgreSQL
-- Run this file in the Supabase SQL Editor or through your migration pipeline.

create extension if not exists pgcrypto;

do $$ begin
  create type account_type as enum ('owner', 'reseller', 'client');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type account_status as enum ('active', 'paused', 'blocked', 'trial', 'expired', 'cancelled');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type instance_status as enum ('created', 'qr_pending', 'connecting', 'connected', 'disconnected', 'logged_out', 'error', 'blocked', 'paused');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type webhook_delivery_status as enum ('pending', 'delivered', 'retrying', 'failed', 'cancelled');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type message_direction as enum ('inbound', 'outbound');
exception when duplicate_object then null;
end $$;

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function validate_account_parent()
returns trigger
language plpgsql
as $$
declare
  parent_type account_type;
begin
  if new.account_type = 'owner' and new.parent_account_id is not null then
    raise exception 'owner account cannot have parent_account_id';
  end if;

  if new.account_type = 'reseller' and new.parent_account_id is not null then
    select account_type into parent_type from accounts where id = new.parent_account_id and deleted_at is null;
    if parent_type is distinct from 'owner' then
      raise exception 'reseller parent must be owner';
    end if;
  end if;

  if new.account_type = 'client' and new.parent_account_id is not null then
    select account_type into parent_type from accounts where id = new.parent_account_id and deleted_at is null;
    if parent_type not in ('owner', 'reseller') then
      raise exception 'client parent must be owner or reseller';
    end if;
  end if;

  return new;
end;
$$;

create table if not exists plans (
  id bigserial primary key,
  name text not null unique,
  description text,
  price numeric(12,2) not null default 0,
  billing_cycle text not null default 'monthly',
  instance_quota integer not null default 1 check (instance_quota >= 0),
  max_client_accounts integer not null default 0 check (max_client_accounts >= 0),
  webhook_enabled boolean not null default true,
  websocket_enabled boolean not null default true,
  api_enabled boolean not null default true,
  chatwoot_enabled boolean not null default true,
  typebot_enabled boolean not null default true,
  n8n_enabled boolean not null default true,
  support_level text not null default 'standard',
  features_json jsonb not null default '[]'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists plans_set_updated_at on plans;
create trigger plans_set_updated_at
before update on plans
for each row execute function set_updated_at();

create table if not exists accounts (
  id bigserial primary key,
  name text not null,
  email text,
  document text,
  phone text,
  account_type account_type not null default 'client',
  parent_account_id bigint references accounts(id) on delete restrict,
  plan_id bigint references plans(id) on delete set null,
  status account_status not null default 'active',
  instance_quota integer check (instance_quota is null or instance_quota >= 0),
  max_client_accounts integer not null default 0 check (max_client_accounts >= 0),
  owner_name text,
  owner_email text,
  billing_status text,
  notes text,
  trial_ends_at timestamptz,
  blocked_at timestamptz,
  paused_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint account_parent_rules check (
    (account_type = 'owner' and parent_account_id is null)
    or (account_type = 'reseller')
    or (account_type = 'client')
  )
);

drop trigger if exists accounts_set_updated_at on accounts;
create trigger accounts_set_updated_at
before update on accounts
for each row execute function set_updated_at();

drop trigger if exists accounts_validate_parent on accounts;
create trigger accounts_validate_parent
before insert or update on accounts
for each row execute function validate_account_parent();

create table if not exists users (
  id bigserial primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  name text not null,
  email text not null unique,
  password text not null,
  role text not null default 'admin',
  status account_status not null default 'active',
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

drop trigger if exists users_set_updated_at on users;
create trigger users_set_updated_at
before update on users
for each row execute function set_updated_at();

create table if not exists instances (
  id bigserial primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  name text not null,
  phone text,
  phone_connected text,
  jid text,
  api_key text not null unique default ('woo_' || encode(gen_random_bytes(24), 'hex')),
  status instance_status not null default 'created',
  connection_status instance_status not null default 'created',
  engine text not null default 'wooapi_engine',
  profile_name text,
  profile_picture_url text,
  webhook_url text,
  webhook_secret text not null default ('whsec_' || encode(gen_random_bytes(24), 'hex')),
  webhook_enabled boolean not null default true,
  webhook_events jsonb not null default '[]'::jsonb,
  websocket_enabled boolean not null default true,
  last_qr text,
  qr text,
  last_qr_at timestamptz,
  connected_at timestamptz,
  disconnected_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

drop trigger if exists instances_set_updated_at on instances;
create trigger instances_set_updated_at
before update on instances
for each row execute function set_updated_at();

create table if not exists conversations (
  id bigserial primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  instance_id bigint references instances(id) on delete set null,
  type text not null default 'contact',
  remote_jid text,
  contact_phone text,
  group_jid text,
  title text,
  contact_profile_picture_url text,
  tags_json jsonb not null default '[]'::jsonb,
  status text not null default 'open',
  assigned_to text,
  last_message_preview text,
  unread_count integer not null default 0,
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

drop trigger if exists conversations_set_updated_at on conversations;
create trigger conversations_set_updated_at
before update on conversations
for each row execute function set_updated_at();

alter table conversations add column if not exists contact_profile_picture_url text;

create table if not exists messages (
  id bigserial primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  instance_id bigint references instances(id) on delete set null,
  conversation_id bigint references conversations(id) on delete set null,
  lead_id bigint,
  direction message_direction not null,
  chat_type text not null default 'contact',
  author_phone text,
  author_push_name text,
  content_type text not null default 'text',
  content_text text,
  message_id text,
  delivery_status text not null default 'received',
  from_me boolean not null default false,
  sender text,
  raw_json jsonb,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists webhook_events (
  id bigserial primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  instance_id bigint not null references instances(id) on delete cascade,
  event text not null,
  payload jsonb not null default '{}'::jsonb,
  status webhook_delivery_status not null default 'pending',
  response_status integer,
  error text,
  attempts integer not null default 0,
  retry_count integer not null default 0,
  last_attempt_at timestamptz,
  next_retry_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists api_request_logs (
  id bigserial primary key,
  account_id bigint references accounts(id) on delete set null,
  instance_id bigint references instances(id) on delete set null,
  method text,
  path text,
  status_code integer,
  ip text,
  user_agent text,
  duration_ms integer,
  error text,
  created_at timestamptz not null default now()
);

create table if not exists connection_logs (
  id bigserial primary key,
  account_id bigint references accounts(id) on delete set null,
  instance_id bigint references instances(id) on delete set null,
  event text not null,
  status text,
  details_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists message_logs (
  id bigserial primary key,
  account_id bigint references accounts(id) on delete set null,
  instance_id bigint references instances(id) on delete set null,
  message_id text,
  direction message_direction,
  status text,
  details_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists audit_logs (
  id bigserial primary key,
  account_id bigint references accounts(id) on delete set null,
  user_id bigint references users(id) on delete set null,
  action text not null,
  details_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists integration_settings (
  id bigserial primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  instance_id bigint not null references instances(id) on delete cascade,
  provider text not null check (provider in ('n8n', 'typebot', 'chatwoot')),
  enabled boolean not null default false,
  config_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (instance_id, provider)
);

drop trigger if exists integration_settings_set_updated_at on integration_settings;
create trigger integration_settings_set_updated_at
before update on integration_settings
for each row execute function set_updated_at();

create table if not exists integration_sessions (
  id bigserial primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  instance_id bigint not null references instances(id) on delete cascade,
  provider text not null check (provider in ('typebot', 'chatwoot', 'n8n')),
  contact_key text not null,
  session_id text,
  result_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (instance_id, provider, contact_key)
);

drop trigger if exists integration_sessions_set_updated_at on integration_sessions;
create trigger integration_sessions_set_updated_at
before update on integration_sessions
for each row execute function set_updated_at();

create table if not exists support_sessions (
  id bigserial primary key,
  super_admin_user_id bigint references users(id) on delete set null,
  target_account_id bigint references accounts(id) on delete cascade,
  reason text,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists usage_events (
  id bigserial primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  event text not null,
  quantity integer not null default 1,
  created_at timestamptz not null default now()
);

create table if not exists media_files (
  id bigserial primary key,
  account_id bigint references accounts(id) on delete set null,
  instance_id bigint references instances(id) on delete set null,
  original_name text,
  storage_path text not null,
  public_url text,
  mime_type text,
  size_bytes bigint,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_accounts_parent on accounts(parent_account_id);
create index if not exists idx_accounts_status on accounts(status);
create index if not exists idx_accounts_type on accounts(account_type);
create index if not exists idx_accounts_email on accounts(email);
create index if not exists idx_users_account on users(account_id);
create index if not exists idx_users_email on users(email);
create index if not exists idx_instances_account on instances(account_id);
create index if not exists idx_instances_api_key on instances(api_key);
create index if not exists idx_instances_status on instances(status);
create index if not exists idx_instances_phone on instances(phone);
create index if not exists idx_instances_phone_connected on instances(phone_connected);
create index if not exists idx_instances_jid on instances(jid);
create index if not exists idx_conversations_account_instance on conversations(account_id, instance_id);
create index if not exists idx_conversations_phone on conversations(contact_phone);
create index if not exists idx_messages_account_instance on messages(account_id, instance_id);
create index if not exists idx_messages_conversation on messages(conversation_id);
create index if not exists idx_messages_message_id on messages(message_id);
create index if not exists idx_webhook_events_instance on webhook_events(instance_id);
create index if not exists idx_webhook_events_status on webhook_events(status);
create index if not exists idx_webhook_events_next_retry on webhook_events(next_retry_at);
create index if not exists idx_api_request_logs_account on api_request_logs(account_id);
create index if not exists idx_api_request_logs_instance on api_request_logs(instance_id);
create index if not exists idx_connection_logs_instance on connection_logs(instance_id);
create index if not exists idx_message_logs_instance on message_logs(instance_id);
create index if not exists idx_audit_logs_account on audit_logs(account_id);
create index if not exists idx_integration_settings_instance on integration_settings(instance_id);
create index if not exists idx_usage_events_account on usage_events(account_id);

create or replace function get_account_quota_usage(target_account_id bigint)
returns table (
  account_id bigint,
  account_type account_type,
  instance_quota integer,
  own_instances_used integer,
  allocated_to_children integer,
  children_instances_used integer,
  available_to_allocate integer,
  available_to_create_own integer
)
language sql
stable
as $$
  with base_account as (
    select
      a.id,
      a.account_type,
      coalesce(a.instance_quota, p.instance_quota, 0) as quota
    from accounts a
    left join plans p on p.id = a.plan_id
    where a.id = target_account_id and a.deleted_at is null
  ),
  own_usage as (
    select count(*)::integer as total
    from instances
    where account_id = target_account_id and deleted_at is null
  ),
  child_allocation as (
    select coalesce(sum(coalesce(instance_quota, 0)), 0)::integer as total
    from accounts
    where parent_account_id = target_account_id and deleted_at is null
  ),
  child_usage as (
    select count(i.*)::integer as total
    from instances i
    join accounts c on c.id = i.account_id
    where c.parent_account_id = target_account_id
      and c.deleted_at is null
      and i.deleted_at is null
  )
  select
    b.id,
    b.account_type,
    b.quota,
    o.total,
    ca.total,
    cu.total,
    greatest(b.quota - o.total - ca.total, 0),
    greatest(b.quota - o.total - ca.total, 0)
  from base_account b
  cross join own_usage o
  cross join child_allocation ca
  cross join child_usage cu;
$$;

insert into plans (
  name,
  description,
  price,
  billing_cycle,
  instance_quota,
  max_client_accounts,
  webhook_enabled,
  websocket_enabled,
  api_enabled,
  chatwoot_enabled,
  typebot_enabled,
  n8n_enabled,
  support_level,
  features_json,
  is_active
) values
  ('WooAPI Starter', 'Instâncias WhatsApp com API, Webhook e WebSocket.', 97, 'monthly', 2, 0, true, true, true, false, false, true, 'standard', '["Instâncias", "API", "Webhook", "WebSocket"]'::jsonb, true),
  ('WooAPI Reseller', 'Revenda com subcontas e cotas por cliente.', 197, 'monthly', 10, 10, true, true, true, true, true, true, 'priority', '["Revenda", "Subcontas", "Cotas", "Webhooks"]'::jsonb, true),
  ('WooAPI Pro', 'Logs avançados e conectores operacionais.', 297, 'monthly', 20, 0, true, true, true, true, true, true, 'priority', '["Logs avançados", "Chatwoot", "Typebot", "n8n"]'::jsonb, true),
  ('WooAPI Enterprise', 'White-label, multi-revendedor e suporte avançado.', 697, 'monthly', 50, 50, true, true, true, true, true, true, 'enterprise', '["White-label", "Multi-revendedor", "Suporte", "Módulos extras"]'::jsonb, true)
on conflict (name) do update set
  description = excluded.description,
  price = excluded.price,
  billing_cycle = excluded.billing_cycle,
  instance_quota = excluded.instance_quota,
  max_client_accounts = excluded.max_client_accounts,
  webhook_enabled = excluded.webhook_enabled,
  websocket_enabled = excluded.websocket_enabled,
  api_enabled = excluded.api_enabled,
  chatwoot_enabled = excluded.chatwoot_enabled,
  typebot_enabled = excluded.typebot_enabled,
  n8n_enabled = excluded.n8n_enabled,
  support_level = excluded.support_level,
  features_json = excluded.features_json,
  is_active = excluded.is_active,
  updated_at = now();
