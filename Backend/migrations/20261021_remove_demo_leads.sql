-- Remove the five confirmed demo/test leads shown in the AQ Setu Leads tab.
-- Scoped to AQ Setu's client ID and the exact example.com addresses visible in the portal.
DELETE FROM public.leads
WHERE client_id = '44514d8d-df4b-46ea-97b0-4cabd3a0a2ba'::uuid
  AND lower(coalesce(email, '')) IN (
    'rahul@example.com',
    'priya@example.com',
    'amit@example.com',
    'vikram@example.com',
    'sneha@example.com'
  );
