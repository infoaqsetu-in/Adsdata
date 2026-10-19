-- AQ Setu Meta integration schema
-- Safe to run more than once. Run in Supabase SQL Editor as project owner.

create table if not exists public.meta_connections (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null unique references public.clients(id) on delete cascade,
  meta_user_id text,
  ad_account_id text,
  ad_account_name text,
  currency text,
  access_token text,
  token_expires_at timestamptz,
  status text not null default 'active' check (status in ('active', 'expired', 'disconnected')),
  last_synced_at timestamptz,
  last_sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.meta_connections
  add column if not exists meta_user_id text,
  add column if not exists ad_account_id text,
  add column if not exists ad_account_name text,
  add column if not exists currency text,
  add column if not exists access_token text,
  add column if not exists token_expires_at timestamptz,
  add column if not exists status text not null default 'active',
  add column if not exists last_synced_at timestamptz,
  add column if not exists last_sync_error text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create table if not exists public.meta_account_permissions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  ad_account_id text not null,
  ad_account_name text,
  is_allowed boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (client_id, ad_account_id)
);

alter table public.meta_account_permissions
  add column if not exists ad_account_name text,
  add column if not exists is_allowed boolean not null default false,
  add column if not exists updated_at timestamptz not null default now();

-- Meta campaign fields are additive so existing campaign records are preserved.
alter table public.campaigns
  add column if not exists meta_ad_account_id text,
  add column if not exists meta_campaign_id text,
  add column if not exists objective text,
  add column if not exists reach numeric not null default 0,
  add column if not exists ctr numeric,
  add column if not exists cpc numeric,
  add column if not exists cpm numeric,
  add column if not exists actions jsonb not null default '[]'::jsonb,
  add column if not exists currency text,
  add column if not exists date_start date,
  add column if not exists date_stop date,
  add column if not exists last_synced_at timestamptz;

create unique index if not exists campaigns_client_meta_campaign_unique
  on public.campaigns (client_id, meta_campaign_id)
  where meta_campaign_id is not null;

create index if not exists meta_connections_status_updated_idx
  on public.meta_connections (status, updated_at desc);

create index if not exists meta_account_permissions_client_idx
  on public.meta_account_permissions (client_id);

-- Organic social sync fields used by /api/meta/social/sync.
-- Keep existing manually entered posts; these are additive columns.
alter table public.social_posts
  add column if not exists platform_post_id text,
  add column if not exists published_at timestamptz,
  add column if not exists likes_count bigint,
  add column if not exists comments_count bigint,
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists social_posts_platform_post_id_unique
  on public.social_posts (platform, platform_post_id)
  where platform_post_id is not null;
