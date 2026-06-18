alter table outreach_history
  add column if not exists resend_id text,
  add column if not exists opened_at timestamptz;

create index if not exists outreach_history_resend_id_idx on outreach_history (resend_id);
