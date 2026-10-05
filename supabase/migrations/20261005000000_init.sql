-- PropOps initial schema.
-- Single owner, property-keyed. RLS is on for every table: the owner (via
-- app_owner) may read and modify; workers use the service role. audit_log and
-- agent_steps are append-only; events allows status changes only.
-- Money is integer cents. PII columns are plain text for now (see docs/decisions.md D2).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- People and property
-- ---------------------------------------------------------------------------

create table app_owner (
  user_id uuid primary key references auth.users (id) on delete cascade,
  phone text not null unique,
  email text not null unique,
  verified_at timestamptz
);

create table contacts (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('tenant', 'vendor', 'owner', 'agency', 'utility', 'hoa')),
  display_name text not null,
  first_name text,
  phone text unique,
  email text unique,
  preferred_channel text not null default 'sms' check (preferred_channel in ('sms', 'email')),
  preferred_language text not null default 'en',
  is_allowlisted boolean not null default false,
  created_by text not null default 'owner' check (created_by in ('owner', 'system', 'agent')),
  created_at timestamptz not null default now()
);

create table properties (
  id uuid primary key default gen_random_uuid(),
  nickname text not null,
  address text not null,
  county text,
  jurisdiction_flags jsonb not null default '{}'::jsonb,
  hoa_contact_id uuid references contacts (id),
  created_at timestamptz not null default now()
);

create table tenants (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null unique references contacts (id),
  property_id uuid not null references properties (id),
  status text not null default 'active' check (status in ('active', 'former', 'applicant'))
);

create table leases (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties (id),
  start_date date not null,
  end_date date not null check (end_date > start_date),
  monthly_rent_cents integer not null check (monthly_rent_cents > 0),
  due_day integer not null default 1 check (due_day between 1 and 28),
  grace_days integer not null default 0 check (grace_days >= 0),
  late_fee_rule_id text,
  deposit_cents integer not null default 0 check (deposit_cents >= 0),
  status text not null default 'active' check (status in ('draft', 'active', 'ended')),
  doc_storage_path text
);

create table lease_tenants (
  lease_id uuid not null references leases (id) on delete cascade,
  tenant_id uuid not null references tenants (id),
  primary key (lease_id, tenant_id)
);

create table vendors (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null unique references contacts (id),
  trades text[] not null default '{}',
  preapproved boolean not null default false,
  auto_spend_limit_cents integer not null default 0 check (auto_spend_limit_cents >= 0),
  rating integer check (rating between 1 and 5),
  notes text
);

-- ---------------------------------------------------------------------------
-- Ingress
-- ---------------------------------------------------------------------------

create table events (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  source text not null check (source in ('twilio', 'gmail', 'tick', 'dashboard')),
  external_id text not null,
  contact_id uuid references contacts (id),
  property_id uuid references properties (id),
  payload jsonb not null,
  redacted_summary text,
  status text not null default 'received'
    check (status in ('received', 'queued', 'processing', 'done', 'failed', 'suppressed')),
  emergency_hit boolean not null default false,
  received_at timestamptz not null default now(),
  -- Idempotency: a provider retry inserts nothing.
  unique (source, external_id)
);

create table threads (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('sms', 'email')),
  contact_id uuid not null references contacts (id),
  external_thread_id text,
  classification text,
  summary text,
  last_message_at timestamptz,
  unique (channel, contact_id, external_thread_id)
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references threads (id),
  event_id uuid references events (id),
  direction text not null check (direction in ('inbound', 'outbound')),
  channel text not null check (channel in ('sms', 'email')),
  contact_id uuid not null references contacts (id),
  body text not null,
  redacted_body text not null,
  provider_id text unique,
  template_id text,
  is_auto_reply boolean not null default false,
  created_at timestamptz not null default now()
);
create index messages_thread_created_idx on messages (thread_id, created_at);
-- Rate limits count outbound messages per contact per day from this table.
create index messages_contact_outbound_idx on messages (contact_id, created_at)
  where direction = 'outbound';

-- ---------------------------------------------------------------------------
-- Maintenance and money
-- ---------------------------------------------------------------------------

create table maintenance_requests (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties (id),
  tenant_id uuid references tenants (id),
  title text not null,
  category text not null,
  urgency text not null check (urgency in ('emergency', 'urgent', 'routine', 'cosmetic')),
  urgency_reason text,
  status text not null default 'new' check (status in (
    'new', 'info_needed', 'vendor_requested', 'quoted', 'scheduled',
    'in_progress', 'done', 'closed', 'cancelled')),
  missing_info text[] not null default '{}',
  vendor_id uuid references vendors (id),
  quote_cents integer check (quote_cents >= 0),
  scheduled_start timestamptz,
  calendar_event_id uuid,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create table ledger_entries (
  id uuid primary key default gen_random_uuid(),
  lease_id uuid not null references leases (id),
  kind text not null check (kind in ('rent_charge', 'payment', 'late_fee', 'credit', 'deposit')),
  -- Signed: charges are positive, payments and credits negative. Balance owed
  -- is the sum over non-deposit rows. Deposits are held funds, tracked apart.
  amount_cents integer not null check (
    (kind in ('rent_charge', 'late_fee', 'deposit') and amount_cents > 0)
    or (kind in ('payment', 'credit') and amount_cents < 0)),
  period text not null check (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  effective_date date not null,
  method text,
  note text,
  created_by text not null default 'owner' check (created_by in ('owner', 'system', 'agent'))
);
create index ledger_lease_period_idx on ledger_entries (lease_id, period);

create table expenses (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties (id),
  request_id uuid references maintenance_requests (id),
  vendor_id uuid references vendors (id),
  category text not null,
  amount_cents integer not null check (amount_cents > 0),
  incurred_on date not null,
  receipt_path text
);

create table calendar_events (
  id uuid primary key default gen_random_uuid(),
  google_event_id text unique,
  kind text not null check (kind in ('vendor_visit', 'lease_date', 'notice_deadline')),
  request_id uuid references maintenance_requests (id),
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at)
);
alter table maintenance_requests
  add constraint maintenance_requests_calendar_event_fk
  foreign key (calendar_event_id) references calendar_events (id);

-- ---------------------------------------------------------------------------
-- Agent runs, actions, approvals
-- ---------------------------------------------------------------------------

create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events (id),
  prompt_name text not null,
  prompt_version integer not null,
  policy_hash text not null,
  model text not null,
  status text not null default 'running' check (status in ('running', 'finished')),
  outcome text check (outcome in ('completed', 'escalated', 'failed', 'capped')),
  escalation_reason text,
  steps integer not null default 0,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd numeric(10, 4) not null default 0,
  latency_ms integer,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
-- The daily spend cap sums cost_usd by start time.
create index agent_runs_started_idx on agent_runs (started_at);

create table request_history (
  id bigint generated always as identity primary key,
  request_id uuid not null references maintenance_requests (id),
  from_status text,
  to_status text not null,
  actor text not null check (actor in ('agent', 'owner', 'system')),
  run_id uuid references agent_runs (id),
  at timestamptz not null default now()
);

create table agent_steps (
  id bigint generated always as identity primary key,
  run_id uuid not null references agent_runs (id),
  idx integer not null,
  type text not null check (type in ('thought', 'tool_call', 'tool_result', 'final')),
  tool_name text,
  redacted_input jsonb,
  redacted_output jsonb,
  effective_tier integer check (effective_tier between 0 and 3),
  tier_reasons text[] not null default '{}',
  duration_ms integer,
  input_tokens integer,
  output_tokens integer,
  created_at timestamptz not null default now(),
  unique (run_id, idx)
);

-- Outbox. Every side effect the agent wants is a row here before it happens.
create table actions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references agent_runs (id),
  tool_name text not null,
  args jsonb not null,
  effective_tier integer not null check (effective_tier between 0 and 3),
  tier_reasons text[] not null default '{}',
  status text not null check (status in (
    'proposed', 'held', 'pending_approval', 'approved', 'rejected', 'revising',
    'executing', 'executed', 'failed', 'undone', 'expired', 'blocked_paused', 'refused')),
  approval_code text check (approval_code ~ '^\d{4}$'),
  code_expires_at timestamptz,
  send_at timestamptz,
  idempotency_key text not null unique,
  executed_result jsonb,
  parent_action_id uuid references actions (id),
  created_at timestamptz not null default now()
);
-- A code identifies exactly one open action, whether it is awaiting approval
-- (Y-/N-) or held in the undo window (U-).
create unique index actions_open_code_idx on actions (approval_code)
  where status in ('held', 'pending_approval');
create index actions_due_idx on actions (send_at) where status = 'held';

create table approvals (
  id uuid primary key default gen_random_uuid(),
  action_id uuid not null references actions (id),
  channel text not null check (channel in ('sms', 'dashboard')),
  decision text not null check (decision in ('approve', 'reject', 'edit', 'undo')),
  owner_text text,
  decided_at timestamptz not null default now()
);

create table memory_facts (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('tenant', 'property', 'vendor')),
  subject_id uuid not null,
  category text not null,
  fact text not null,
  source_run_id uuid references agent_runs (id),
  -- Only 'active' facts are loaded into agent context. Agent writes land as 'proposed'.
  status text not null default 'proposed'
    check (status in ('proposed', 'active', 'rejected', 'archived')),
  owner_edited boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Control plane
-- ---------------------------------------------------------------------------

create table policy_overrides (
  id uuid primary key default gen_random_uuid(),
  path text not null unique,
  value jsonb not null,
  changed_by uuid not null references auth.users (id),
  changed_at timestamptz not null default now(),
  reason text
);

create table system_state (
  id boolean primary key default true check (id),
  paused boolean not null default false,
  paused_at timestamptz,
  paused_by text
);
insert into system_state default values;

create table audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor text not null,
  action text not null,
  entity text not null,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  run_id uuid references agent_runs (id)
);

create table dead_letters (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  event_id uuid references events (id),
  error text not null,
  attempts integer not null default 1,
  payload_ref text,
  resolved boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Append-only enforcement. Triggers apply to every role, including the service
-- role and the table owner, so a bug in worker code cannot rewrite history.
-- ---------------------------------------------------------------------------

create function forbid_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '% is append-only (% not allowed)', tg_table_name, tg_op
    using errcode = 'insufficient_privilege';
end $$;

create trigger audit_log_append_only before update or delete on audit_log
  for each row execute function forbid_mutation();
create trigger audit_log_no_truncate before truncate on audit_log
  for each statement execute function forbid_mutation();
create trigger agent_steps_append_only before update or delete on agent_steps
  for each row execute function forbid_mutation();
create trigger agent_steps_no_truncate before truncate on agent_steps
  for each statement execute function forbid_mutation();

-- events: what arrived never changes; only processing state moves.
create function events_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op <> 'UPDATE' then
    raise exception 'events rows cannot be removed (% not allowed)', tg_op
      using errcode = 'insufficient_privilege';
  end if;
  if (to_jsonb(new) - 'status' - 'emergency_hit') is distinct from
     (to_jsonb(old) - 'status' - 'emergency_hit') then
    raise exception 'events: only status and emergency_hit may change'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger events_guard_row before update or delete on events
  for each row execute function events_guard();
create trigger events_no_truncate before truncate on events
  for each statement execute function events_guard();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

create function is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_owner where user_id = (select auth.uid()));
$$;
revoke all on function is_owner() from public, anon;
grant execute on function is_owner() to authenticated, service_role;

do $$
declare
  t text;
  read_only text[] := array['audit_log', 'agent_steps', 'events'];
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
    -- The anon key is public. It gets nothing, regardless of policies.
    execute format('revoke all on public.%I from anon', t);
    if t = any (read_only) then
      execute format(
        'create policy owner_select on public.%I for select to authenticated using (public.is_owner())', t);
      execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
    else
      execute format(
        'create policy owner_all on public.%I for all to authenticated '
        'using (public.is_owner()) with check (public.is_owner())', t);
    end if;
  end loop;
end $$;

-- Tables added by later migrations must not inherit anon access by default.
alter default privileges in schema public revoke all on tables from anon;
