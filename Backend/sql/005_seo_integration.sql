CREATE TABLE IF NOT EXISTS public.seo_client_settings (client_id UUID PRIMARY KEY REFERENCES public.clients(id) ON DELETE CASCADE, enabled BOOLEAN NOT NULL DEFAULT FALSE, site_url TEXT, semrush_database TEXT NOT NULL DEFAULT 'us', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS public.seo_snapshots (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE, provider TEXT NOT NULL CHECK(provider IN ('search_console','semrush')), metric_date DATE NOT NULL, payload JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(client_id,provider,metric_date));
CREATE INDEX IF NOT EXISTS idx_seo_snapshots_client_date ON public.seo_snapshots(client_id,metric_date DESC);
ALTER TABLE public.seo_client_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seo_snapshots ENABLE ROW LEVEL SECURITY;
