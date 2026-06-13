create table if not exists pipeline (
  id                  uuid primary key default gen_random_uuid(),
  church_id           uuid not null references churches(id) on delete cascade,
  stage               text not null default 'identified'
                        check (stage in ('identified','emailed','opened','responded','demo_scheduled','demo_done','proposal_sent','won','lost')),
  tier_interest       integer check (tier_interest in (1, 2, 3)),
  notes               text,
  expected_close_date date,
  monthly_revenue     integer,
  lost_reason         text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Keep updated_at current automatically
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger pipeline_updated_at
  before update on pipeline
  for each row execute function set_updated_at();

-- One church can only appear once in the pipeline
create unique index if not exists pipeline_church_id_unique on pipeline(church_id);
