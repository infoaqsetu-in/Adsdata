-- Extend social calendar for synced Meta organic content.
ALTER TABLE public.social_posts ADD COLUMN IF NOT EXISTS page_id TEXT;
ALTER TABLE public.social_posts ADD COLUMN IF NOT EXISTS page_name TEXT;
ALTER TABLE public.social_posts ADD COLUMN IF NOT EXISTS platform_account_id TEXT;
ALTER TABLE public.social_posts ADD COLUMN IF NOT EXISTS platform_account_name TEXT;
ALTER TABLE public.social_posts ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS idx_social_posts_platform_post_unique
 ON public.social_posts(platform,platform_post_id)
 WHERE platform_post_id IS NOT NULL;
