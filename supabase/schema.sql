create table if not exists churches (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  denomination text,
  address text,
  phone text,
  website text,
  email text,
  city text,
  state text,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists churches_city_state_idx on churches (city, state);

create table if not exists outreach_history (
  id uuid default gen_random_uuid() primary key,
  church_name text not null,
  email_address text not null,
  subject text,
  date_sent timestamptz default now(),
  status text not null default 'sent',
  resend_id text,
  created_at timestamptz default now()
);

create index if not exists outreach_history_church_name_idx on outreach_history (church_name);
create index if not exists outreach_history_date_sent_idx on outreach_history (date_sent desc);
