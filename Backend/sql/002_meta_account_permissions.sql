-- AQ Setu: per-client Meta ad account permissions
CREATE TABLE IF NOT EXISTS public.meta_account_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
    ad_account_id TEXT NOT NULL,
    ad_account_name TEXT,
    is_allowed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_id, ad_account_id)
);
CREATE INDEX IF NOT EXISTS idx_meta_account_permissions_client
    ON public.meta_account_permissions (client_id);
ALTER TABLE public.meta_account_permissions ENABLE ROW LEVEL SECURITY;
