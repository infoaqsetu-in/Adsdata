CREATE TABLE IF NOT EXISTS public.social_posts (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
 platform TEXT NOT NULL CHECK(platform IN ('instagram','facebook','linkedin','tiktok','other')),
 caption TEXT NOT NULL, media_url TEXT, post_url TEXT, platform_post_id TEXT,
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending_approval','approved','scheduled','published','failed','rejected')),
 scheduled_at TIMESTAMPTZ, published_at TIMESTAMPTZ,
 likes_count BIGINT, comments_count BIGINT, views_count BIGINT, reach_count BIGINT, impressions_count BIGINT,
 engagement_updated_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_social_posts_client_schedule ON public.social_posts(client_id,scheduled_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_posts_platform_id ON public.social_posts(platform,platform_post_id);
ALTER TABLE public.social_posts ENABLE ROW LEVEL SECURITY;
