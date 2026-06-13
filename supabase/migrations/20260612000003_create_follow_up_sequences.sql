create table if not exists follow_up_sequences (
  id                    uuid primary key default gen_random_uuid(),
  church_id             uuid not null references churches(id) on delete cascade,
  email                 text not null,
  sequence_number       integer not null default 0,
  status                text not null default 'active'
                          check (status in ('active', 'completed', 'responded', 'unsubscribed')),
  initial_email_sent_at timestamptz not null default now(),
  next_follow_up_at     timestamptz,
  last_sent_at          timestamptz,
  created_at            timestamptz not null default now(),
  unique (church_id)
);
