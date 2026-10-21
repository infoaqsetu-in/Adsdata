ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS instagram_sender_id text,
  ADD COLUMN IF NOT EXISTS instagram_account_id text,
  ADD COLUMN IF NOT EXISTS message_preview text,
  ADD COLUMN IF NOT EXISTS conversation_id text,
  ADD COLUMN IF NOT EXISTS external_message_id text,
  ADD COLUMN IF NOT EXISTS source_detail text;

CREATE UNIQUE INDEX IF NOT EXISTS leads_instagram_external_message_unique
  ON public.leads (external_message_id);
