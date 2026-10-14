-- AQ Setu Google Ads integration
-- Run this file in the Supabase SQL Editor before using /api/google-ads.
CREATE TABLE IF NOT EXISTS public.google_ads_connections (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  refresh_token TEXT NOT NULL,
  manager_customer_id TEXT,
  connected_by UUID,
  connected_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active',
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.google_ads_oauth_states (
  nonce TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.google_ads_available_accounts (
  customer_id TEXT PRIMARY KEY CHECK (customer_id ~ '^[0-9]{10}$'),
  customer_name TEXT NOT NULL,
  currency_code TEXT,
  is_manager BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'ENABLED',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.google_ads_client_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES public.google_ads_available_accounts(customer_id) ON DELETE CASCADE,
  customer_name TEXT,
  currency_code TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, customer_id),
  UNIQUE (customer_id)
);

CREATE INDEX IF NOT EXISTS idx_google_ads_client_accounts_client
  ON public.google_ads_client_accounts(client_id);

ALTER TABLE public.google_ads_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.google_ads_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.google_ads_available_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.google_ads_client_accounts ENABLE ROW LEVEL SECURITY;
