-- WooAPI production schema for Supabase/PostgreSQL.
-- Run this in Supabase SQL Editor on a clean project database.
-- This schema intentionally uses text/integer flags instead of PostgreSQL
-- enums/booleans because the current API code sends SQLite-compatible values
-- such as is_active = 1, success = 0, status = 'open', 'qr', 'none', etc.

begin;

create extension if not exists pgcrypto;

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = current_timestamp;
  return new;
end;
$$;

create table if not exists plans (
  id bigserial primary key,
  name text not null unique,
  description text,
  price numeric(12,2) not null default 0,
  billing_cycle text not null default 'monthly',
  instance_quota integer default 1,
  max_instances integer default 1,
  max_users integer default 2,
  max_messages integer default 5000,
  max_agents integer default 0,
  max_campaigns integer default 0,
  max_leads integer default 0,
  max_client_accounts integer default 0,
  webhook_enabled integer not null default 1,
  websocket_enabled integer not null default 1,
  api_enabled integer not null default 1,
  chatwoot_enabled integer not null default 1,
  typebot_enabled integer not null default 1,
  n8n_enabled integer not null default 1,
  support_level text not null default 'standard',
  stripe_product_id text,
  api_rate_limit_per_minute integer not null default 60,
  instance_rate_limit_per_minute integer not null default 30,
  message_rate_limit_per_minute integer not null default 20,
  features_json text not null default '[]',
  is_active integer not null default 1,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

drop trigger if exists plans_set_updated_at on plans;
create trigger plans_set_updated_at
before update on plans
for each row execute function set_updated_at();

alter table plans add column if not exists api_rate_limit_per_minute integer not null default 60;
alter table plans add column if not exists instance_rate_limit_per_minute integer not null default 30;
alter table plans add column if not exists message_rate_limit_per_minute integer not null default 20;

create table if not exists accounts (
  id bigserial primary key,
  parent_account_id bigint references accounts(id) on delete restrict,
  account_type text not null default 'client',
  name text not null,
  email text,
  document text,
  phone text,
  plan_id bigint references plans(id) on delete set null,
  instance_quota integer,
  max_client_accounts integer default 0,
  status text not null default 'active',
  owner_name text,
  owner_email text,
  notes text,
  billing_status text,
  trial_ends_at timestamptz,
  paused_at timestamptz,
  blocked_at timestamptz,
  stripe_customer_id text,
  stripe_subscription_id text,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  deleted_at timestamptz
);

drop trigger if exists accounts_set_updated_at on accounts;
create trigger accounts_set_updated_at
before update on accounts
for each row execute function set_updated_at();

create table if not exists users (
  id bigserial primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  name text not null,
  email text not null unique,
  password text not null,
  role text not null default 'admin',
  status text not null default 'active',
  last_login_at timestamptz,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
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
  api_key text unique default ('woo_' || encode(gen_random_bytes(24), 'hex')),
  status text not null default 'created',
  connection_status text not null default 'created',
  operational_status text default 'unknown',
  engine text not null default 'wooapi',
  profile_name text,
  profile_picture_url text,
  webhook_url text,
  webhook_secret text default ('whsec_' || encode(gen_random_bytes(24), 'hex')),
  webhook_enabled integer not null default 1,
  webhook_events text not null default '[]',
  websocket_enabled integer not null default 1,
  qr text,
  last_qr text,
  last_qr_at timestamptz,
  connected_at timestamptz,
  disconnected_at timestamptz,
  last_seen_at timestamptz,
  last_event_at timestamptz,
  connection_uptime_seconds integer default 0,
  disconnection_count_24h integer default 0,
  message_sent_count_24h integer default 0,
  message_failed_count_24h integer default 0,
  avg_send_latency_ms integer default 0,
  last_error text,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  deleted_at timestamptz
);

drop trigger if exists instances_set_updated_at on instances;
create trigger instances_set_updated_at
before update on instances
for each row execute function set_updated_at();

create table if not exists leads (
  id bigserial primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  name text,
  phone text,
  address text,
  niche text,
  status text default 'pending',
  kanban_status text default 'new',
  campaign_id bigint,
  last_interaction_type text,
  created_at timestamptz not null default current_timestamp
);

create table if not exists agents (
  id bigserial primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  name text not null,
  system_instruction text,
  personality text,
  faq_json text,
  handoff_trigger text,
  created_at timestamptz not null default current_timestamp
);

create table if not exists campaigns (
  id bigserial primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  instance_id bigint references instances(id) on delete set null,
  name text not null,
  agent_id bigint references agents(id) on delete set null,
  initial_method text default 'direct',
  transition_rules text default '{}',
  status text default 'draft',
  message_template text,
  media_url text,
  min_delay_ms integer default 1000,
  max_delay_ms integer default 3000,
  scheduled_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  total_count integer default 0,
  sent_count integer default 0,
  delivered_count integer default 0,
  read_count integer default 0,
  failed_count integer default 0,
  limit_per_instance integer default 1,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

create table if not exists campaign_recipients (
  id bigserial primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  campaign_id bigint not null references campaigns(id) on delete cascade,
  instance_id bigint references instances(id) on delete set null,
  phone text,
  jid text,
  variables_json text default '{}',
  status text default 'pending',
  job_id text,
  message_id text,
  error text,
  scheduled_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);

alter table campaigns add column if not exists instance_id bigint references instances(id) on delete set null;
alter table campaigns add column if not exists status text default 'draft';
alter table campaigns add column if not exists message_template text;
alter table campaigns add column if not exists media_url text;
alter table campaigns add column if not exists min_delay_ms integer default 1000;
alter table campaigns add column if not exists max_delay_ms integer default 3000;
alter table campaigns add column if not exists scheduled_at timestamptz;
alter table campaigns add column if not exists started_at timestamptz;
alter table campaigns add column if not exists completed_at timestamptz;
alter table campaigns add column if not exists total_count integer default 0;
alter table campaigns add column if not exists sent_count integer default 0;
alter table campaigns add column if not exists delivered_count integer default 0;
alter table campaigns add column if not exists read_count integer default 0;
alter table campaigns add column if not exists failed_count integer default 0;
alter table campaigns add column if not exists limit_per_instance integer default 1;
alter table campaigns add column if not exists updated_at timestamptz default current_timestamp;

create table if not exists quick_replies (
  id bigserial primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  shortcut text not null,
  title text,
  content text not null,
  media_url text,
  is_active integer default 1,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  unique(account_id, shortcut)
);

create table if not exists lead_notes (
  id bigserial primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  lead_id bigint not null references leads(id) on delete cascade,
  user_id bigint references users(id) on delete set null,
  note text not null,
  created_at timestamptz not null default current_timestamp
);

create table if not exists lead_tags (
  id bigserial primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  lead_id bigint not null references leads(id) on delete cascade,
  tag text not null,
  created_at timestamptz not null default current_timestamp,
  unique(account_id, lead_id, tag)
);

create table if not exists lead_custom_fields (
  id bigserial primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  lead_id bigint not null references leads(id) on delete cascade,
  field_key text not null,
  field_value text,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  unique(account_id, lead_id, field_key)
);

create table if not exists system_settings (
  id bigserial primary key,
  setting_key text not null unique,
  setting_value text,
  updated_at timestamptz not null default current_timestamp
);

alter table leads add column if not exists custom_fields_json text default '{}';
alter table leads add column if not exists tags_json text default '[]';

create table if not exists team_members (
  id bigserial primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  name text,
  role text,
  email text,
  created_at timestamptz not null default current_timestamp
);

create table if not exists schedules (
  id bigserial primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  name text,
  agent_id bigint references agents(id) on delete set null,
  member_id bigint references team_members(id) on delete set null,
  description text,
  created_at timestamptz not null default current_timestamp
);

create table if not exists llm_credentials (
  id bigserial primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  provider text,
  name text,
  api_key text,
  model_name text,
  is_active integer default 0,
  created_at timestamptz not null default current_timestamp
);

create table if not exists conversations (
  id bigserial primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  instance_id bigint references instances(id) on delete set null,
  type text default 'contact',
  remote_jid text,
  contact_phone text,
  group_jid text,
  title text,
  contact_profile_picture_url text,
  tags_json text default '[]',
  status text default 'open',
  assigned_to text,
  last_message_preview text,
  unread_count integer default 0,
  last_message_at timestamptz default current_timestamp,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
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
  lead_id bigint references leads(id) on delete set null,
  direction text,
  chat_type text,
  author_phone text,
  author_push_name text,
  content_type text default 'text',
  content_text text,
  message_id text,
  delivery_status text default 'received',
  from_me integer default 0,
  sender text,
  raw_json text,
  created_at timestamptz not null default current_timestamp,
  deleted_at timestamptz
);

create table if not exists wooapi_events (
  id bigserial primary key,
  account_id bigint references accounts(id) on delete cascade,
  instance_id bigint references instances(id) on delete cascade,
  event_id text not null unique,
  event text not null,
  payload text default '{}',
  created_at timestamptz not null default current_timestamp
);

create table if not exists instance_webhooks (
  id bigserial primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  instance_id bigint not null references instances(id) on delete cascade,
  name text,
  url text not null,
  secret text not null default ('whsec_' || encode(gen_random_bytes(24), 'hex')),
  events text default '[]',
  is_active integer default 1,
  retry_enabled integer default 1,
  max_attempts integer default 5,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  unique (instance_id, url)
);

drop trigger if exists instance_webhooks_set_updated_at on instance_webhooks;
create trigger instance_webhooks_set_updated_at
before update on instance_webhooks
for each row execute function set_updated_at();

create table if not exists webhook_events (
  id bigserial primary key,
  account_id bigint references accounts(id) on delete cascade,
  instance_id bigint references instances(id) on delete cascade,
  webhook_id bigint references instance_webhooks(id) on delete set null,
  url text,
  event text,
  payload text default '{}',
  status text default 'pending',
  response_status integer,
  error text,
  attempts integer default 0,
  retry_count integer default 0,
  last_attempt_at timestamptz,
  next_retry_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default current_timestamp
);

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
  success integer default 0,
  attempt integer default 1,
  request_payload text,
  response_body text,
  error text,
  duration_ms integer,
  created_at timestamptz not null default current_timestamp
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
  created_at timestamptz not null default current_timestamp
);

create table if not exists connection_logs (
  id bigserial primary key,
  account_id bigint references accounts(id) on delete set null,
  instance_id bigint references instances(id) on delete set null,
  event text,
  status text,
  details_json text default '{}',
  created_at timestamptz not null default current_timestamp
);

create table if not exists message_logs (
  id bigserial primary key,
  account_id bigint references accounts(id) on delete set null,
  instance_id bigint references instances(id) on delete set null,
  message_id text,
  direction text,
  status text,
  details_json text default '{}',
  created_at timestamptz not null default current_timestamp
);

create table if not exists support_alerts (
  id bigserial primary key,
  account_id bigint references accounts(id) on delete set null,
  instance_id bigint references instances(id) on delete set null,
  severity text not null,
  type text not null,
  title text not null,
  description text,
  status text default 'open',
  metadata text default '{}',
  opened_at timestamptz not null default current_timestamp,
  acknowledged_at timestamptz,
  resolved_at timestamptz
);

create table if not exists support_tickets (
  id bigserial primary key,
  account_id bigint references accounts(id) on delete cascade,
  instance_id bigint references instances(id) on delete set null,
  alert_id bigint references support_alerts(id) on delete set null,
  subject text not null,
  status text default 'open',
  priority text default 'normal',
  source text default 'support_chat',
  assigned_to text,
  ai_summary text,
  ai_resolution text,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  escalated_at timestamptz,
  resolved_at timestamptz
);

drop trigger if exists support_tickets_set_updated_at on support_tickets;
create trigger support_tickets_set_updated_at
before update on support_tickets
for each row execute function set_updated_at();

create table if not exists support_ticket_messages (
  id bigserial primary key,
  ticket_id bigint references support_tickets(id) on delete cascade,
  account_id bigint references accounts(id) on delete cascade,
  user_id bigint references users(id) on delete set null,
  sender text not null,
  message text not null,
  metadata text default '{}',
  created_at timestamptz not null default current_timestamp
);

create table if not exists support_ai_actions (
  id bigserial primary key,
  account_id bigint references accounts(id) on delete cascade,
  instance_id bigint references instances(id) on delete set null,
  ticket_id bigint references support_tickets(id) on delete cascade,
  alert_id bigint references support_alerts(id) on delete set null,
  action text not null,
  status text default 'completed',
  details_json text default '{}',
  created_at timestamptz not null default current_timestamp
);

create table if not exists integration_settings (
  id bigserial primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  instance_id bigint not null references instances(id) on delete cascade,
  provider text not null,
  enabled integer default 0,
  config_json text default '{}',
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
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
  provider text,
  contact_key text,
  session_id text,
  result_id text,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp,
  unique (instance_id, provider, contact_key)
);

drop trigger if exists integration_sessions_set_updated_at on integration_sessions;
create trigger integration_sessions_set_updated_at
before update on integration_sessions
for each row execute function set_updated_at();

create table if not exists audit_logs (
  id bigserial primary key,
  account_id bigint references accounts(id) on delete set null,
  user_id bigint references users(id) on delete set null,
  action text,
  details_json text default '{}',
  created_at timestamptz not null default current_timestamp
);

create table if not exists support_sessions (
  id bigserial primary key,
  super_admin_user_id bigint references users(id) on delete set null,
  target_account_id bigint references accounts(id) on delete cascade,
  reason text,
  expires_at timestamptz,
  created_at timestamptz not null default current_timestamp
);

create table if not exists usage_events (
  id bigserial primary key,
  account_id bigint not null references accounts(id) on delete cascade,
  event text,
  quantity integer default 1,
  created_at timestamptz not null default current_timestamp
);

create table if not exists media_files (
  id bigserial primary key,
  account_id bigint references accounts(id) on delete set null,
  instance_id bigint references instances(id) on delete set null,
  original_name text,
  storage_path text,
  public_url text,
  mime_type text,
  size_bytes bigint,
  created_at timestamptz not null default current_timestamp,
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
create index if not exists idx_instances_connection_status on instances(connection_status);
create index if not exists idx_instances_phone on instances(phone);
create index if not exists idx_instances_phone_connected on instances(phone_connected);
create index if not exists idx_instances_jid on instances(jid);
create index if not exists idx_leads_account on leads(account_id);
create index if not exists idx_agents_account on agents(account_id);
create index if not exists idx_campaigns_account on campaigns(account_id);
create index if not exists idx_team_members_account on team_members(account_id);
create index if not exists idx_schedules_account on schedules(account_id);
create index if not exists idx_llm_credentials_account on llm_credentials(account_id);
create index if not exists idx_conversations_account_instance on conversations(account_id, instance_id);
create index if not exists idx_conversations_phone on conversations(contact_phone);
create index if not exists idx_messages_account_instance on messages(account_id, instance_id);
create index if not exists idx_messages_conversation on messages(conversation_id);
create index if not exists idx_messages_message_id on messages(message_id);
create index if not exists idx_wooapi_events_instance on wooapi_events(instance_id);
create index if not exists idx_wooapi_events_event_id on wooapi_events(event_id);
create index if not exists idx_instance_webhooks_instance on instance_webhooks(instance_id);
create index if not exists idx_instance_webhooks_active on instance_webhooks(instance_id, is_active);
create index if not exists idx_webhook_events_instance on webhook_events(instance_id);
create index if not exists idx_webhook_events_status on webhook_events(status);
create index if not exists idx_webhook_events_next_retry on webhook_events(next_retry_at);
create index if not exists idx_webhook_events_webhook on webhook_events(webhook_id);
create index if not exists idx_webhook_delivery_logs_instance on webhook_delivery_logs(instance_id);
create index if not exists idx_webhook_delivery_logs_webhook on webhook_delivery_logs(webhook_id);
create index if not exists idx_webhook_delivery_logs_event on webhook_delivery_logs(webhook_event_id);
create index if not exists idx_api_request_logs_account on api_request_logs(account_id);
create index if not exists idx_api_request_logs_instance on api_request_logs(instance_id);
create index if not exists idx_connection_logs_instance on connection_logs(instance_id);
create index if not exists idx_message_logs_instance on message_logs(instance_id);
create index if not exists idx_support_alerts_status on support_alerts(status);
create index if not exists idx_support_alerts_instance on support_alerts(instance_id);
create index if not exists idx_support_tickets_account on support_tickets(account_id);
create index if not exists idx_support_tickets_status on support_tickets(status);
create index if not exists idx_support_tickets_instance on support_tickets(instance_id);
create index if not exists idx_support_ticket_messages_ticket on support_ticket_messages(ticket_id);
create index if not exists idx_support_ai_actions_ticket on support_ai_actions(ticket_id);
create index if not exists idx_integration_settings_instance on integration_settings(instance_id);
create index if not exists idx_integration_sessions_instance on integration_sessions(instance_id);
create index if not exists idx_audit_logs_account on audit_logs(account_id);
create index if not exists idx_usage_events_account on usage_events(account_id);

insert into plans (
  name,
  description,
  price,
  billing_cycle,
  instance_quota,
  max_instances,
  max_users,
  max_messages,
  max_agents,
  max_campaigns,
  max_leads,
  max_client_accounts,
  webhook_enabled,
  websocket_enabled,
  api_enabled,
  chatwoot_enabled,
  typebot_enabled,
  n8n_enabled,
	  support_level,
	  features_json,
	  api_rate_limit_per_minute,
	  instance_rate_limit_per_minute,
	  message_rate_limit_per_minute,
	  is_active
	) values
	  ('WooAPI Starter', 'Instancias WhatsApp com API, Webhook e WebSocket.', 97, 'monthly', 2, 2, 2, 5000, 0, 0, 0, 0, 1, 1, 1, 0, 0, 1, 'standard', '["Instancias WhatsApp","API","Webhook","WebSocket"]', 60, 30, 20, 1),
	  ('WooAPI Reseller', 'Revenda com subcontas e cotas por cliente.', 197, 'monthly', 10, 10, 5, 20000, 0, 0, 0, 10, 1, 1, 1, 1, 1, 1, 'priority', '["Revenda","Subcontas","Cotas por cliente","Webhooks"]', 120, 60, 40, 1),
	  ('WooAPI Pro', 'Logs avancados e conectores operacionais.', 297, 'monthly', 20, 20, 10, 50000, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 'priority', '["Logs avancados","Chatwoot","Typebot","n8n"]', 180, 90, 60, 1),
	  ('WooAPI Enterprise', 'White-label, multi-revendedor e suporte prioritario.', 697, 'monthly', 50, 50, 25, 200000, 0, 0, 0, 50, 1, 1, 1, 1, 1, 1, 'enterprise', '["White-label","Multi-revendedor","Suporte prioritario","Modulos extras"]', 300, 150, 100, 1)
on conflict (name) do update set
  description = excluded.description,
  price = excluded.price,
  billing_cycle = excluded.billing_cycle,
  instance_quota = excluded.instance_quota,
  max_instances = excluded.max_instances,
  max_users = excluded.max_users,
  max_messages = excluded.max_messages,
  max_agents = excluded.max_agents,
  max_campaigns = excluded.max_campaigns,
  max_leads = excluded.max_leads,
  max_client_accounts = excluded.max_client_accounts,
  webhook_enabled = excluded.webhook_enabled,
  websocket_enabled = excluded.websocket_enabled,
  api_enabled = excluded.api_enabled,
  chatwoot_enabled = excluded.chatwoot_enabled,
  typebot_enabled = excluded.typebot_enabled,
  n8n_enabled = excluded.n8n_enabled,
  support_level = excluded.support_level,
  features_json = excluded.features_json,
  api_rate_limit_per_minute = excluded.api_rate_limit_per_minute,
  instance_rate_limit_per_minute = excluded.instance_rate_limit_per_minute,
  message_rate_limit_per_minute = excluded.message_rate_limit_per_minute,
  is_active = excluded.is_active,
  updated_at = current_timestamp;

-- Optional initial super admin.
-- For production, edit email/password before running this block.
-- The API accepts a plaintext password once and upgrades it to PBKDF2 after login.
--
-- with owner_plan as (
--   select id from plans where name = 'WooAPI Enterprise' limit 1
-- ), owner_account as (
--   insert into accounts (
--     name, email, account_type, plan_id, instance_quota, max_client_accounts,
--     status, owner_name, owner_email
--   )
--   select
--     'WooAPI Admin', 'admin@seu-dominio.com', 'owner', id, 50, 50,
--     'active', 'Administrador', 'admin@seu-dominio.com'
--   from owner_plan
--   where not exists (select 1 from accounts where account_type = 'owner')
--   returning id
-- )
-- insert into users (account_id, name, email, password, role, status)
-- select id, 'Administrador', 'admin@seu-dominio.com', 'troque-esta-senha', 'super_admin', 'active'
-- from owner_account
-- on conflict (email) do nothing;

alter table instances add column if not exists assigned_node_id text;
alter table instances add column if not exists ip_pool_id text default 'default';
alter table instances add column if not exists risk_profile text default 'low-risk';
alter table instances add column if not exists risk_score integer default 100;

create table if not exists core_nodes (
  id text primary key,
  region text default 'br-south',
  profile text default 'low-risk',
  ip_pool_id text default 'default',
  status text default 'ACTIVE',
  drain_mode integer default 0,
  max_instances integer default 150,
  active_instances integer default 0,
  cpu_percent numeric default 0,
  memory_percent numeric default 0,
  error_rate numeric default 0,
  avg_latency_ms integer default 0,
  last_heartbeat_at timestamp default current_timestamp,
  created_at timestamp default current_timestamp,
  updated_at timestamp default current_timestamp
);

create table if not exists instance_assignments (
  id bigserial primary key,
  account_id bigint,
  instance_id bigint,
  node_id text,
  ip_pool_id text,
  profile text,
  reason text,
  created_at timestamp default current_timestamp
);

create table if not exists instance_state_events (
  id bigserial primary key,
  account_id bigint,
  instance_id bigint,
  from_state text,
  to_state text,
  trigger text,
  metadata_json text default '{}',
  created_at timestamp default current_timestamp
);

create table if not exists reputation_scores (
  id bigserial primary key,
  scope text,
  subject_id text,
  score integer default 100,
  metadata_json text default '{}',
  created_at timestamp default current_timestamp,
  updated_at timestamp default current_timestamp,
  unique(scope, subject_id)
);

create table if not exists traffic_buckets (
  id bigserial primary key,
  bucket_key text unique,
  count integer default 0,
  reset_at timestamp,
  updated_at timestamp default current_timestamp
);

create table if not exists traffic_decisions (
  id bigserial primary key,
  account_id bigint,
  instance_id bigint,
  node_id text,
  decision text,
  reason text,
  delay_ms integer default 0,
  score integer,
  metadata_json text default '{}',
  created_at timestamp default current_timestamp
);

create index if not exists idx_core_nodes_status on core_nodes(status);
create index if not exists idx_core_nodes_profile on core_nodes(profile);
create index if not exists idx_instance_assignments_instance on instance_assignments(instance_id);
create index if not exists idx_instance_state_events_instance on instance_state_events(instance_id);
create index if not exists idx_reputation_scores_scope on reputation_scores(scope, score);
create index if not exists idx_traffic_decisions_instance on traffic_decisions(instance_id);
create index if not exists idx_traffic_decisions_created on traffic_decisions(created_at);

commit;
