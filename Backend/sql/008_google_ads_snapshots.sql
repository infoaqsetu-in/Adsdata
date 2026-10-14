-- Daily Google Ads snapshots for historical comparisons and reporting.
CREATE TABLE IF NOT EXISTS public.google_ads_daily_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  snapshot_date DATE NOT NULL,
  campaign_name TEXT,
  campaign_status TEXT,
  channel TEXT,
  currency_code TEXT,
  impressions BIGINT NOT NULL DEFAULT 0,
  clicks BIGINT NOT NULL DEFAULT 0,
  spend NUMERIC(14,2) NOT NULL DEFAULT 0,
  conversions NUMERIC(14,4) NOT NULL DEFAULT 0,
  conversion_value NUMERIC(14,2) NOT NULL DEFAULT 0,
  ctr NUMERIC(10,4) NOT NULL DEFAULT 0,
  average_cpc NUMERIC(14,4) NOT NULL DEFAULT 0,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, customer_id, campaign_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_google_ads_snapshots_client_date
  ON public.google_ads_daily_snapshots(client_id, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_google_ads_snapshots_customer_date
  ON public.google_ads_daily_snapshots(customer_id, snapshot_date);
ALTER TABLE public.google_ads_daily_snapshots ENABLE ROW LEVEL SECURITY;
