-- Profile-Updater: per-visitor settings + Naukri session (service role only)
create table if not exists public.visitors (
  id uuid primary key,
  settings jsonb not null default '{}'::jsonb,
  storage_state jsonb,
  connected_at timestamptz,
  last_run_at timestamptz,
  last_run_result text,
  resume_path text,
  log_tail text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.visitors enable row level security;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists visitors_set_updated_at on public.visitors;
create trigger visitors_set_updated_at
before update on public.visitors
for each row execute function public.set_updated_at();

-- Storage: create private bucket `resumes` in Dashboard (Storage)
-- Path convention: {visitor_id}/{filename}.pdf
-- No anon policies; server uses service role.
