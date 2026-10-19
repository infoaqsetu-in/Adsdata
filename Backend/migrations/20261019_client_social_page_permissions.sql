-- Organic social Page assignments are separate from Meta ad-account permissions.
-- Safe additive migration: does not move or rewrite existing social_posts rows.
create table if not exists public.client_social_page_permissions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  page_id text not null,
  page_name text,
  instagram_account_id text,
  instagram_username text,
  is_allowed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_social_page_permissions_client_page_unique unique (client_id, page_id)
);

create index if not exists idx_client_social_page_permissions_client_allowed
  on public.client_social_page_permissions (client_id, is_allowed);

-- Backend uses the service-role Supabase client, but enable RLS as a safe default
-- in case the table is ever exposed through the public API.
alter table public.client_social_page_permissions enable row level security;
