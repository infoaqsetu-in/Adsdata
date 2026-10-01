-- AQ Setu agency/client role migration.
-- Run this once in Supabase SQL Editor after deploying the new role code.

alter table public.users alter column client_id drop not null;

update public.users
set role = 'admin', client_id = null
where lower(email) = 'admin@aqsetu.in';

update public.users
set role = 'client'
where client_id is not null
  and lower(email) <> 'admin@aqsetu.in'
  and role in ('client_admin', 'client_user');
