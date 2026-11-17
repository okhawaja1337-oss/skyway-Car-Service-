-- ============================================================================
-- Skyway Grid — Supabase Postgres schema (PRODUCT-DESIGN.md Appendix A, §4, §9)
--
-- Run once in the Supabase SQL editor (or `supabase db push`).  Safe to re-run:
-- every statement is IF NOT EXISTS / CREATE OR REPLACE.
--
-- Conventions (every table):
--   id          text PK   — the console's uid() where the console made the row
--   location_id text      — RLS boundary; one row per region in `locations`
--   created_at / updated_at timestamptz, rev bigint (ms since epoch), deleted_at
--   body        jsonb     — the console's STATE object stored verbatim
--   promoted columns      — copied out of body by trigger for indexes / RLS
--
-- Sync rules enforced here (see sync.js):
--   * last-writer-wins per row by `rev`: an UPDATE whose rev is older than the
--     stored rev is silently skipped (BEFORE trigger returns NULL)
--   * `rev` is never allowed to fall behind the server clock, so pollers using
--     `rev=gt.<cursor>` never miss a row written by a device with a slow clock
--   * trips.status is derived from body->>'stage' (and left alone when null)
--   * the newest driver_locations row is copied into drivers.body->'curLoc'
-- ============================================================================

create extension if not exists pgcrypto;      -- gen_random_uuid()
create extension if not exists pg_trgm;       -- optional: fuzzy address search

-- ----------------------------------------------------------------------------
-- 0. Helpers
-- ----------------------------------------------------------------------------
create or replace function skyway_now_ms() returns bigint
language sql stable as $$ select (extract(epoch from clock_timestamp()) * 1000)::bigint $$;

-- JWT claim helpers.  Dispatchers/drivers get these in app_metadata at sign-up
-- (Supabase Dashboard → Authentication → Users → "raw app meta data"), e.g.
--   {"skyway_role":"dispatcher","skyway_locations":["nyc"]}
--   {"skyway_role":"driver","skyway_locations":["nyc"],"skyway_driver_id":"abc123"}
create or replace function skyway_role() returns text
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' ->> 'skyway_role', '')
$$;
create or replace function skyway_locations() returns text[]
language sql stable as $$
  select coalesce(
    array(select jsonb_array_elements_text(
      coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' -> 'skyway_locations', '[]'::jsonb))),
    '{}'::text[])
$$;
create or replace function skyway_driver_id() returns text
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' ->> 'skyway_driver_id', '')
$$;
create or replace function skyway_is_dispatcher(loc text) returns boolean
language sql stable as $$ select skyway_role() in ('dispatcher','owner') and loc = any(skyway_locations()) $$;
create or replace function skyway_is_driver(loc text) returns boolean
language sql stable as $$ select skyway_role() = 'driver' and loc = any(skyway_locations()) $$;

-- Common BEFORE INSERT OR UPDATE trigger: timestamps, rev, last-writer-wins.
-- `rev` (what pollers see) never falls behind the server clock; `client_rev`
-- keeps the writer's own clock value so last-writer-wins compares like with like.
create or replace function skyway_touch() returns trigger
language plpgsql as $$
declare incoming bigint;
begin
  if tg_op = 'INSERT' then
    incoming := coalesce(new.rev, skyway_now_ms());
    new.client_rev := incoming;
    new.created_at := coalesce(new.created_at, now());
  else
    -- upsert path: BEFORE INSERT already stored the writer's rev in client_rev;
    -- plain PATCH path: the writer's rev is still in new.rev
    incoming := case when new.client_rev is distinct from old.client_rev then new.client_rev else coalesce(new.rev, skyway_now_ms()) end;
    if old.client_rev is not null and incoming < old.client_rev then
      return null;                                   -- older write loses, silently
    end if;
    new.client_rev := incoming;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  new.rev := greatest(incoming, skyway_now_ms());
  if new.body is null then new.body := '{}'::jsonb; end if;
  return new;
end $$;

-- ----------------------------------------------------------------------------
-- 1. Core tables (mirrors of the console's STATE)
-- ----------------------------------------------------------------------------
create table if not exists locations (
  id text primary key,
  location_id text generated always as (id) stored,
  name text, country text default 'US', tz text default 'America/New_York',
  currency text default 'USD', locale text default 'en-US', units text default 'mi',
  phone_cc text default '+1', pricing_engine text default 'nyc_tlc_meter',
  square_location_id text, twilio_messaging_sid text, payment_provider text default 'square',
  geofence_m int default 150,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  rev bigint default 0, deleted_at timestamptz, body jsonb not null default '{}'::jsonb
);

create table if not exists settings (
  id text primary key,                         -- = location_id (one row per location)
  location_id text not null,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  rev bigint default 0, deleted_at timestamptz, body jsonb not null default '{}'::jsonb
);

create table if not exists trips (
  id text primary key,
  location_id text not null,
  dispatch_no int, date text, time text, stage text, status text,
  driver_id text, vehicle_id text, account_id text, pay_type text,
  payment_status text, track_token text,
  fare numeric(12,2), tolls numeric(12,2), tip numeric(12,2), phone_e164 text,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  rev bigint default 0, deleted_at timestamptz, body jsonb not null default '{}'::jsonb
);

create table if not exists trip_events (
  id text primary key default gen_random_uuid()::text,
  location_id text not null,
  trip_id text, driver_id text, device_id text, client_event_id text,
  actor text, type text, occurred_at timestamptz, received_at timestamptz default now(),
  lat double precision, lng double precision, data jsonb,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  rev bigint default 0, deleted_at timestamptz, body jsonb not null default '{}'::jsonb,
  unique (device_id, client_event_id)
);

create table if not exists offers (
  id text primary key default gen_random_uuid()::text,
  location_id text not null,
  trip_id text, driver_id text, rank int, reason text,
  sent_at timestamptz default now(), expires_at timestamptz, response text, responded_at timestamptz, channel text,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  rev bigint default 0, deleted_at timestamptz, body jsonb not null default '{}'::jsonb
);

create table if not exists drivers (
  id text primary key,
  location_id text not null,
  phone_e164 text, auth_user_id uuid, active boolean, on_shift boolean default false, car_no text, name text,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  rev bigint default 0, deleted_at timestamptz, body jsonb not null default '{}'::jsonb
);

create table if not exists driver_locations (
  id text primary key default gen_random_uuid()::text,
  location_id text not null,
  driver_id text not null, at timestamptz not null default now(),
  lat double precision not null, lng double precision not null,
  heading real, speed real, accuracy real, battery real, trip_id text,
  device_id text, client_event_id text,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  rev bigint default 0, deleted_at timestamptz, body jsonb not null default '{}'::jsonb
);

create table if not exists driver_location_daily (
  id text primary key default gen_random_uuid()::text,
  location_id text not null,
  driver_id text, day date, km numeric(10,2), first_at timestamptz, last_at timestamptz, trips int,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  rev bigint default 0, deleted_at timestamptz, body jsonb not null default '{}'::jsonb,
  unique (driver_id, day)
);

create table if not exists device_sessions (
  id text primary key default gen_random_uuid()::text,
  location_id text not null,
  driver_id text, auth_user_id uuid, phone_e164 text, platform text, push_subscription jsonb,
  app_version text, last_seen timestamptz, revoked boolean default false,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  rev bigint default 0, deleted_at timestamptz, body jsonb not null default '{}'::jsonb
);

create table if not exists connect_tokens (
  id text primary key default gen_random_uuid()::text,
  location_id text not null,
  token text unique not null, driver_id text, expires_at timestamptz not null, used boolean default false,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  rev bigint default 0, deleted_at timestamptz, body jsonb not null default '{}'::jsonb
);

create table if not exists pending_devices (
  id text primary key default gen_random_uuid()::text,
  location_id text not null,
  phone_e164 text, first_seen timestamptz default now(), resolved_driver_id text,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  rev bigint default 0, deleted_at timestamptz, body jsonb not null default '{}'::jsonb
);

create table if not exists vehicles (
  id text primary key,
  location_id text not null,
  plate text, type text, cap int, driver_id text,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  rev bigint default 0, deleted_at timestamptz, body jsonb not null default '{}'::jsonb
);

create table if not exists accounts (
  id text primary key,
  location_id text not null,
  number text, name text, email text, square_customer_id text, billing_cycle text, net_days int,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  rev bigint default 0, deleted_at timestamptz, body jsonb not null default '{}'::jsonb
);

create table if not exists passengers (
  id text primary key default gen_random_uuid()::text,
  location_id text not null,
  phone_e164 text, name text, email text, square_customer_id text, sms_opt_out boolean default false,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  rev bigint default 0, deleted_at timestamptz, body jsonb not null default '{}'::jsonb,
  unique (location_id, phone_e164)
);

create table if not exists addrbook (
  id text primary key,
  location_id text not null,
  place_id text, lat double precision, lng double precision, address text, label text,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  rev bigint default 0, deleted_at timestamptz, body jsonb not null default '{}'::jsonb
);

create table if not exists config (
  id text primary key,                         -- '<location_id>:<key>'
  location_id text not null,
  key text,                                    -- zones, fares, farebook, routebook, hints, geocache, compliance, map, airports, rate_card, promos, finance
  created_at timestamptz default now(), updated_at timestamptz default now(),
  rev bigint default 0, deleted_at timestamptz, body jsonb not null default '{}'::jsonb,
  unique (location_id, key)
);

create table if not exists finance (
  id text primary key,
  location_id text not null,
  period text,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  rev bigint default 0, deleted_at timestamptz, body jsonb not null default '{}'::jsonb
);

create table if not exists call_history (
  id text primary key default gen_random_uuid()::text,
  location_id text not null,
  at timestamptz, phone_e164 text,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  rev bigint default 0, deleted_at timestamptz, body jsonb not null default '{}'::jsonb
);

create table if not exists invoices (
  id text primary key,
  location_id text not null,
  invoice_no int, account_id text, period text, total numeric(12,2), status text,
  square_invoice_id text, pdf_url text,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  rev bigint default 0, deleted_at timestamptz, body jsonb not null default '{}'::jsonb
);

create table if not exists payments (
  id text primary key,                         -- = Square payment id where one exists
  location_id text not null,
  trip_id text, invoice_id text, kind text,    -- auth|capture|link|invoice|refund|tip|cash|terminal
  amount bigint, tip bigint, fee bigint, currency text default 'USD', status text, receipt_url text,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  rev bigint default 0, deleted_at timestamptz, body jsonb not null default '{}'::jsonb
);

create table if not exists square_events (
  id text primary key default gen_random_uuid()::text,
  location_id text,
  event_id text unique not null, type text, processed_at timestamptz default now(),
  created_at timestamptz default now(), updated_at timestamptz default now(),
  rev bigint default 0, deleted_at timestamptz, body jsonb not null default '{}'::jsonb
);

create table if not exists reconcile_issues (
  id text primary key default gen_random_uuid()::text,
  location_id text not null,
  day date, square_payment_id text, kind text, note text, resolved boolean default false,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  rev bigint default 0, deleted_at timestamptz, body jsonb not null default '{}'::jsonb
);

create table if not exists settlements (
  id text primary key default gen_random_uuid()::text,
  location_id text not null,
  driver_id text, period_start date, period_end date,
  gross numeric(12,2), commission numeric(12,2), tolls numeric(12,2), cash_collected numeric(12,2),
  tips numeric(12,2), net numeric(12,2), paid_at timestamptz, method text, export_url text,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  rev bigint default 0, deleted_at timestamptz, body jsonb not null default '{}'::jsonb
);

create table if not exists messages (
  id text primary key default gen_random_uuid()::text,
  location_id text not null,
  direction text,                              -- 'out' | 'in'
  to_e164 text, from_e164 text, trip_id text, driver_id text, template text,
  twilio_sid text unique, status text, at timestamptz default now(), text_body text,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  rev bigint default 0, deleted_at timestamptz, body jsonb not null default '{}'::jsonb
);

create table if not exists templates (
  id text primary key default gen_random_uuid()::text,
  location_id text not null,
  language text default 'en', key text not null, text text not null,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  rev bigint default 0, deleted_at timestamptz, body jsonb not null default '{}'::jsonb,
  unique (location_id, language, key)
);

create table if not exists masked_sessions (
  id text primary key default gen_random_uuid()::text,
  location_id text not null,
  trip_id text, proxy_number text, expires_at timestamptz,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  rev bigint default 0, deleted_at timestamptz, body jsonb not null default '{}'::jsonb
);

create table if not exists events (
  id text primary key default gen_random_uuid()::text,
  location_id text not null,
  trip_id text, driver_id text, actor text, type text, at timestamptz default now(),
  created_at timestamptz default now(), updated_at timestamptz default now(),
  rev bigint default 0, deleted_at timestamptz, body jsonb not null default '{}'::jsonb
);

create table if not exists promos (
  id text primary key default gen_random_uuid()::text,
  location_id text not null,
  code text, rule jsonb, valid_from date, valid_to date, uses int default 0,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  rev bigint default 0, deleted_at timestamptz, body jsonb not null default '{}'::jsonb,
  unique (location_id, code)
);

create table if not exists affiliates (
  id text primary key default gen_random_uuid()::text,
  location_id text not null,
  name text, phone_e164 text, rates jsonb,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  rev bigint default 0, deleted_at timestamptz, body jsonb not null default '{}'::jsonb
);

-- Needs-you items raised by the server (JOIN from unknown phone, failed charge, STOP…)
create table if not exists needs_you (
  id text primary key default gen_random_uuid()::text,
  location_id text not null,
  kind text, trip_id text, driver_id text, phone_e164 text, note text, resolved boolean default false,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  rev bigint default 0, deleted_at timestamptz, body jsonb not null default '{}'::jsonb
);

-- ----------------------------------------------------------------------------
-- 2. Indexes
-- ----------------------------------------------------------------------------
create index if not exists trips_loc_rev on trips (location_id, rev);
create index if not exists trips_loc_date on trips (location_id, date, time);
create index if not exists trips_loc_status on trips (location_id, status) where deleted_at is null;
create index if not exists trips_driver on trips (driver_id) where deleted_at is null;
create index if not exists trips_dispatch_no on trips (location_id, dispatch_no);
create index if not exists trips_track_token on trips (track_token) where track_token is not null;
create index if not exists trips_phone on trips (location_id, phone_e164);
create index if not exists drivers_loc_rev on drivers (location_id, rev);
create index if not exists drivers_phone on drivers (location_id, phone_e164);
create index if not exists vehicles_loc_rev on vehicles (location_id, rev);
create index if not exists accounts_loc_rev on accounts (location_id, rev);
create index if not exists addrbook_loc_rev on addrbook (location_id, rev);
create index if not exists addrbook_address_trgm on addrbook using gin (address gin_trgm_ops);
create index if not exists settings_loc_rev on settings (location_id, rev);
create index if not exists config_loc_rev on config (location_id, rev);
create index if not exists driver_locations_driver_at on driver_locations (driver_id, at desc);
create index if not exists driver_locations_loc_at on driver_locations (location_id, at);
create index if not exists trip_events_trip on trip_events (trip_id, occurred_at);
create index if not exists offers_trip on offers (trip_id, rank);
create index if not exists offers_open on offers (expires_at) where response is null;
create index if not exists messages_loc_at on messages (location_id, at desc);
create index if not exists messages_trip on messages (trip_id);
create index if not exists payments_trip on payments (trip_id);
create index if not exists invoices_account on invoices (location_id, account_id);
create index if not exists events_trip on events (trip_id, at);
create index if not exists call_history_loc_at on call_history (location_id, at desc);
create index if not exists needs_you_open on needs_you (location_id) where resolved = false;

-- ----------------------------------------------------------------------------
-- 3. Touch trigger on every table
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['locations','settings','trips','trip_events','offers','drivers','driver_locations',
    'driver_location_daily','device_sessions','connect_tokens','pending_devices','vehicles','accounts','passengers',
    'addrbook','config','finance','call_history','invoices','payments','square_events','reconcile_issues',
    'settlements','messages','templates','masked_sessions','events','promos','affiliates','needs_you'] loop
    execute format('alter table %I add column if not exists client_rev bigint', t);
    execute format('drop trigger if exists %I on %I', t || '_touch', t);
    execute format('create trigger %I before insert or update on %I for each row execute function skyway_touch()', t || '_touch', t);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 4. Promotion triggers: body → columns (the console only ever sends body)
-- ----------------------------------------------------------------------------
create or replace function skyway_num(v text) returns numeric
language sql immutable as $$ select case when v ~ '^-?[0-9]+(\.[0-9]+)?$' then v::numeric else null end $$;

create or replace function skyway_e164(v text) returns text
language plpgsql immutable as $$
declare d text;
begin
  if v is null then return null; end if;
  d := regexp_replace(v, '[^0-9+]', '', 'g');
  if d = '' then return null; end if;
  if left(d, 1) = '+' then return d; end if;
  if length(d) = 10 then return '+1' || d; end if;           -- TODO(owner decision 10): default country code per location
  if length(d) = 11 and left(d, 1) = '1' then return '+' || d; end if;
  return '+' || d;
end $$;

-- §4: status derived from stage; left alone when stage is null (console-era rows)
create or replace function skyway_status_from_stage(stage text) returns text
language sql immutable as $$
  select case stage
    when 'booked' then 'Booked' when 'offered' then 'Booked'
    when 'assigned' then 'Dispatched' when 'enroute' then 'Dispatched'
    when 'onloc' then 'Dispatched' when 'pob' then 'Dispatched'
    when 'done' then 'Completed' when 'canceled' then 'Canceled'
    when 'noshow' then 'No-Show' when 'disregard' then 'Disregard'
    else null end
$$;

create or replace function trips_promote() returns trigger
language plpgsql as $$
declare b jsonb := coalesce(new.body, '{}'::jsonb); st text;
begin
  new.dispatch_no    := skyway_num(b->>'dispatchNo')::int;
  new.date           := b->>'date';
  new.time           := b->>'time';
  new.stage          := b->>'stage';
  new.driver_id      := nullif(b->>'driverId', '');
  new.vehicle_id     := nullif(b->>'vehicleId', '');
  new.account_id     := nullif(b->>'accountId', '');
  new.pay_type       := b->>'payType';
  new.payment_status := b->'payment'->>'status';
  new.track_token    := coalesce(new.track_token, nullif(b->>'trackToken', ''));
  new.fare           := skyway_num(b->>'fare');
  new.tolls          := skyway_num(b->>'tolls');
  new.tip            := skyway_num(b->>'tip');
  new.phone_e164     := skyway_e164(b->>'phone');
  -- status: derived from stage when present; otherwise keep whatever the body says (the console's own field)
  st := skyway_status_from_stage(b->>'stage');
  if st is not null then
    new.status := st;
    if (b->>'status') is distinct from st then new.body := jsonb_set(b, '{status}', to_jsonb(st)); end if;
  else
    new.status := coalesce(b->>'status', new.status);
  end if;
  return new;
end $$;
drop trigger if exists trips_promote on trips;
create trigger trips_promote before insert or update on trips for each row execute function trips_promote();

create or replace function drivers_promote() returns trigger
language plpgsql as $$
declare b jsonb := coalesce(new.body, '{}'::jsonb);
begin
  new.phone_e164 := coalesce(skyway_e164(b->>'phone'), new.phone_e164);
  new.active     := case when b ? 'active' then (b->>'active')::boolean else coalesce(new.active, true) end;
  new.on_shift   := case when b ? 'onShift' then (b->>'onShift')::boolean else coalesce(new.on_shift, false) end;
  new.car_no     := b->>'carNo';
  new.name       := b->>'name';
  return new;
end $$;
drop trigger if exists drivers_promote on drivers;
create trigger drivers_promote before insert or update on drivers for each row execute function drivers_promote();

create or replace function vehicles_promote() returns trigger
language plpgsql as $$
declare b jsonb := coalesce(new.body, '{}'::jsonb);
begin
  new.plate := b->>'plate'; new.type := b->>'type'; new.cap := skyway_num(b->>'cap')::int; new.driver_id := nullif(b->>'driverId', '');
  return new;
end $$;
drop trigger if exists vehicles_promote on vehicles;
create trigger vehicles_promote before insert or update on vehicles for each row execute function vehicles_promote();

create or replace function accounts_promote() returns trigger
language plpgsql as $$
declare b jsonb := coalesce(new.body, '{}'::jsonb);
begin
  new.number := coalesce(b->>'number', b->>'acctNo', b->>'no'); new.name := b->>'name'; new.email := b->>'email';
  new.square_customer_id := coalesce(b->>'squareCustomerId', new.square_customer_id);
  new.billing_cycle := coalesce(b->>'billingCycle', new.billing_cycle, 'monthly');
  new.net_days := coalesce(skyway_num(b->>'netDays')::int, new.net_days, 30);
  return new;
end $$;
drop trigger if exists accounts_promote on accounts;
create trigger accounts_promote before insert or update on accounts for each row execute function accounts_promote();

create or replace function addrbook_promote() returns trigger
language plpgsql as $$
declare b jsonb := coalesce(new.body, '{}'::jsonb);
begin
  new.address := b->>'address'; new.label := b->>'label'; new.place_id := b->>'placeId';
  new.lat := skyway_num(b->>'lat')::double precision; new.lng := skyway_num(b->>'lng')::double precision;
  return new;
end $$;
drop trigger if exists addrbook_promote on addrbook;
create trigger addrbook_promote before insert or update on addrbook for each row execute function addrbook_promote();

create or replace function config_promote() returns trigger
language plpgsql as $$
begin
  new.key := coalesce(new.body->>'key', new.key, split_part(new.id, ':', 2));
  return new;
end $$;
drop trigger if exists config_promote on config;
create trigger config_promote before insert or update on config for each row execute function config_promote();

create or replace function invoices_promote() returns trigger
language plpgsql as $$
declare b jsonb := coalesce(new.body, '{}'::jsonb);
begin
  new.invoice_no := coalesce(skyway_num(b->>'invoiceNo')::int, new.invoice_no);
  new.account_id := coalesce(nullif(b->>'accountId', ''), new.account_id);
  new.period := coalesce(b->>'period', new.period);
  new.total := coalesce(skyway_num(b->>'total'), new.total);
  new.status := coalesce(b->>'status', new.status, 'open');
  return new;
end $$;
drop trigger if exists invoices_promote on invoices;
create trigger invoices_promote before insert or update on invoices for each row execute function invoices_promote();

-- ----------------------------------------------------------------------------
-- 5. driver_locations → drivers.body.curLoc  (§4 "GPS pinning")
--    curLoc = {addr, when:'YYYY-MM-DD HH24:MI', lat, lng, source:'gps', heading, speed, accuracy}
--    `addr` is filled lazily by the console's geocode cache, so an existing addr
--    is kept only when the pin has not moved more than ~50 m.
-- ----------------------------------------------------------------------------
create or replace function driver_locations_latest() returns trigger
language plpgsql as $$
declare
  tz text; cur jsonb; when_txt text; old_when text; keep_addr text; d jsonb;
begin
  select l.tz into tz from locations l where l.id = new.location_id;
  tz := coalesce(tz, 'America/New_York');
  when_txt := to_char(new.at at time zone tz, 'YYYY-MM-DD HH24:MI');
  select body->'curLoc' into cur from drivers where id = new.driver_id;
  old_when := cur->>'when';
  -- an older point (offline replay) never overrides a newer pin, manual or gps
  if old_when is not null and old_when ~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$' and old_when > when_txt then
    return new;
  end if;
  keep_addr := null;
  if cur is not null and (cur->>'lat') is not null and (cur->>'lng') is not null
     and abs((cur->>'lat')::double precision - new.lat) < 0.00045 and abs((cur->>'lng')::double precision - new.lng) < 0.0006 then
    keep_addr := cur->>'addr';
  end if;
  d := jsonb_build_object(
    'addr', coalesce(keep_addr, ''),
    'when', when_txt,
    'lat', new.lat, 'lng', new.lng,
    'source', 'gps',
    'heading', new.heading, 'speed', new.speed, 'accuracy', new.accuracy);
  update drivers set body = jsonb_set(coalesce(body, '{}'::jsonb), '{curLoc}', d, true),
                     on_shift = true, rev = skyway_now_ms()
   where id = new.driver_id;
  return new;
end $$;
drop trigger if exists driver_locations_latest on driver_locations;
create trigger driver_locations_latest after insert on driver_locations for each row execute function driver_locations_latest();

-- ----------------------------------------------------------------------------
-- 6. Field ownership for phones (§4): a driver may change only its own fields
-- ----------------------------------------------------------------------------
create or replace function trips_driver_guard() returns trigger
language plpgsql as $$
declare allowed text[] := array['stage','acceptedAt','enrouteAt','arrivedAt','pobAt','completedAt','waitMin','stops','tolls',
                                 'signatureUrl','photos','cashCollected','driverNotes','status'];
        k text;
begin
  if skyway_role() <> 'driver' then return new; end if;
  if old.driver_id is distinct from skyway_driver_id() then
    raise exception 'drivers may only update their own trips';
  end if;
  for k in select jsonb_object_keys(old.body || new.body) loop
    if (old.body -> k) is distinct from (new.body -> k) and not (k = any(allowed)) then
      raise exception 'field % is not editable from a phone', k;
    end if;
  end loop;
  return new;
end $$;
drop trigger if exists trips_driver_guard on trips;
create trigger trips_driver_guard before update on trips for each row execute function trips_driver_guard();

create or replace function drivers_driver_guard() returns trigger
language plpgsql as $$
declare k text;
begin
  if skyway_role() <> 'driver' then return new; end if;
  if old.id <> skyway_driver_id() then raise exception 'drivers may only update their own row'; end if;
  for k in select jsonb_object_keys(old.body || new.body) loop
    if (old.body -> k) is distinct from (new.body -> k) and k not in ('curLoc','onShift','consentAt','photoUrl') then
      raise exception 'field % is not editable from a phone', k;
    end if;
  end loop;
  return new;
end $$;
drop trigger if exists drivers_driver_guard on drivers;
create trigger drivers_driver_guard before update on drivers for each row execute function drivers_driver_guard();

-- ----------------------------------------------------------------------------
-- 7. Sequences per location: dispatch_no / invoice_no  (§9 field mapping)
--    Offline bookings carry a temporary negative dispatchNo; sync-bulk
--    renumbers them through next_dispatch_no().
-- ----------------------------------------------------------------------------
create or replace function skyway_seq_name(kind text, loc text) returns text
language sql immutable as $$ select kind || '_seq_' || regexp_replace(lower(loc), '[^a-z0-9_]', '_', 'g') $$;

create or replace function ensure_location_sequences(loc text, dispatch_start bigint default 1001, invoice_start bigint default 1001)
returns void language plpgsql security definer as $$
begin
  execute format('create sequence if not exists %I start with %s', skyway_seq_name('dispatch', loc), greatest(dispatch_start, 1));
  execute format('create sequence if not exists %I start with %s', skyway_seq_name('invoice', loc), greatest(invoice_start, 1));
end $$;

create or replace function next_dispatch_no(loc text) returns bigint
language plpgsql security definer as $$
begin
  perform ensure_location_sequences(loc);
  return nextval(skyway_seq_name('dispatch', loc));
end $$;

create or replace function next_invoice_no(loc text) returns bigint
language plpgsql security definer as $$
begin
  perform ensure_location_sequences(loc);
  return nextval(skyway_seq_name('invoice', loc));
end $$;

-- Move a sequence forward so it never re-issues a number the console already used.
create or replace function bump_sequences(loc text, dispatch_seq bigint, invoice_seq bigint)
returns void language plpgsql security definer as $$
declare cur bigint;
begin
  perform ensure_location_sequences(loc);
  if dispatch_seq is not null then
    execute format('select last_value from %I', skyway_seq_name('dispatch', loc)) into cur;
    if dispatch_seq > cur then perform setval(skyway_seq_name('dispatch', loc), dispatch_seq, false); end if;
  end if;
  if invoice_seq is not null then
    execute format('select last_value from %I', skyway_seq_name('invoice', loc)) into cur;
    if invoice_seq > cur then perform setval(skyway_seq_name('invoice', loc), invoice_seq, false); end if;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 8. Reconciliation (§9): counts + SUM(fare) by month, as sync.js computes them
-- ----------------------------------------------------------------------------
create or replace function sync_reconcile(p_location_id text) returns jsonb
language sql stable security definer as $$
  select jsonb_build_object(
    'counts', jsonb_build_object(
      'trips',    (select count(*) from trips    where location_id = p_location_id and deleted_at is null),
      'drivers',  (select count(*) from drivers  where location_id = p_location_id and deleted_at is null),
      'vehicles', (select count(*) from vehicles where location_id = p_location_id and deleted_at is null),
      'accounts', (select count(*) from accounts where location_id = p_location_id and deleted_at is null),
      'addrbook', (select count(*) from addrbook where location_id = p_location_id and deleted_at is null),
      'invoices', (select count(*) from invoices where location_id = p_location_id and deleted_at is null),
      'settings', (select count(*) from settings where location_id = p_location_id and deleted_at is null),
      'config',   (select count(*) from config   where location_id = p_location_id and deleted_at is null)),
    'fares_by_month', coalesce((
      select jsonb_object_agg(m, total) from (
        select case when date ~ '^\d{4}-\d{2}' then left(date, 7) else 'unknown' end as m,
               round(sum(coalesce(fare, 0))::numeric, 2) as total
          from trips
         where location_id = p_location_id and deleted_at is null
           and coalesce(status, '') not in ('Canceled', 'Disregard')
         group by 1) s), '{}'::jsonb),
    'first_dispatch_no', (select min(dispatch_no) from trips where location_id = p_location_id and deleted_at is null),
    'last_dispatch_no',  (select max(dispatch_no) from trips where location_id = p_location_id and deleted_at is null))
$$;

-- Trip stage helper used by Edge Functions (sms-in keyword codes, offer-job, geofence)
create or replace function set_trip_stage(p_trip_id text, p_stage text, p_at timestamptz default now(), p_extra jsonb default '{}'::jsonb)
returns trips language plpgsql security definer as $$
declare t trips; stamp text; b jsonb;
begin
  select * into t from trips where id = p_trip_id for update;
  if not found then raise exception 'trip % not found', p_trip_id; end if;
  stamp := case p_stage when 'assigned' then 'acceptedAt' when 'enroute' then 'enrouteAt' when 'onloc' then 'arrivedAt'
                        when 'pob' then 'pobAt' when 'done' then 'completedAt' else null end;
  b := jsonb_set(t.body, '{stage}', to_jsonb(p_stage)) || coalesce(p_extra, '{}'::jsonb);
  if stamp is not null then b := jsonb_set(b, array[stamp], to_jsonb(p_at)); end if;
  if p_stage = 'done' then
    b := b || jsonb_build_object('dropDate', to_char(p_at at time zone coalesce((select tz from locations where id = t.location_id), 'America/New_York'), 'YYYY-MM-DD'),
                                 'dropTime', to_char(p_at at time zone coalesce((select tz from locations where id = t.location_id), 'America/New_York'), 'HH24:MI'));
  end if;
  update trips set body = b, rev = skyway_now_ms() where id = p_trip_id returning * into t;
  insert into events (location_id, trip_id, driver_id, actor, type, at, body)
    values (t.location_id, t.id, t.driver_id, coalesce(p_extra->>'actor', 'system'), 'stage:' || p_stage, p_at, p_extra);
  return t;
end $$;

-- ----------------------------------------------------------------------------
-- 9. Driver earnings view (ports the Earnings tab math; must match the console in tests)
-- ----------------------------------------------------------------------------
create or replace view driver_settlement_v as
  select t.location_id, t.driver_id,
         left(coalesce(t.body->>'dropDate', t.date), 10) as day,
         count(*) as trips,
         sum(coalesce(t.fare, 0)) as gross,
         sum(coalesce(t.tolls, 0)) as tolls,
         sum(coalesce(t.tip, 0)) as tips,
         sum(case when t.pay_type = 'Cash' or (t.body->>'cashCollected')::boolean then coalesce(t.fare, 0) + coalesce(t.tolls, 0) else 0 end) as cash_collected
    from trips t
   where t.deleted_at is null and t.status = 'Completed' and t.driver_id is not null
   group by 1, 2, 3;

-- ----------------------------------------------------------------------------
-- 10. Retention (pg_cron): roll driver_locations older than 30 days into daily rows
-- ----------------------------------------------------------------------------
create or replace function roll_driver_locations() returns void
language plpgsql security definer as $$
begin
  insert into driver_location_daily (location_id, driver_id, day, km, first_at, last_at, trips)
  select location_id, driver_id, (at at time zone 'UTC')::date,
         round((sum(step_m) / 1000.0)::numeric, 2), min(at), max(at), count(distinct trip_id)
    from (
      select *, coalesce(2 * 6371000 * asin(sqrt(
          power(sin(radians(lat - lag(lat) over w) / 2), 2) +
          cos(radians(lag(lat) over w)) * cos(radians(lat)) * power(sin(radians(lng - lag(lng) over w) / 2), 2))), 0) as step_m
        from driver_locations
       where at < now() - interval '30 days'
      window w as (partition by driver_id, (at at time zone 'UTC')::date order by at)
    ) s
   group by 1, 2, 3
  on conflict (driver_id, day) do update set km = excluded.km, first_at = excluded.first_at, last_at = excluded.last_at, trips = excluded.trips;
  delete from driver_locations where at < now() - interval '30 days';
end $$;
-- Enable with (Database → Extensions → pg_cron):
--   select cron.schedule('roll-driver-locations', '15 3 * * *', $$select roll_driver_locations()$$);
--   select cron.schedule('expire-offers', '15 seconds', $$select net.http_post(...)$$);  -- see docs/SETUP.md

-- ----------------------------------------------------------------------------
-- 11. Row Level Security
--     Roles: dispatcher/owner (full access to their locations), driver (own
--     trips + own driver row + own locations/events), passenger/affiliate
--     (token-scoped, Phase 3/8), service_role (Edge Functions; bypasses RLS).
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['locations','settings','trips','trip_events','offers','drivers','driver_locations',
    'driver_location_daily','device_sessions','connect_tokens','pending_devices','vehicles','accounts','passengers',
    'addrbook','config','finance','call_history','invoices','payments','square_events','reconcile_issues',
    'settlements','messages','templates','masked_sessions','events','promos','affiliates','needs_you'] loop
    execute format('alter table %I enable row level security', t);
    -- dispatchers: everything in their locations
    execute format('drop policy if exists %I on %I', t || '_dispatcher_all', t);
    execute format('create policy %I on %I for all to authenticated using (skyway_is_dispatcher(location_id)) with check (skyway_is_dispatcher(location_id))', t || '_dispatcher_all', t);
  end loop;
end $$;

-- drivers: read the fleet/vehicles of their location, their own trips, write own events/locations
drop policy if exists trips_driver_read on trips;
create policy trips_driver_read on trips for select to authenticated
  using (skyway_is_driver(location_id) and driver_id = skyway_driver_id());
drop policy if exists trips_driver_update on trips;
create policy trips_driver_update on trips for update to authenticated
  using (skyway_is_driver(location_id) and driver_id = skyway_driver_id())
  with check (skyway_is_driver(location_id) and driver_id = skyway_driver_id());   -- field ownership: trips_driver_guard()
drop policy if exists drivers_driver_read on drivers;
create policy drivers_driver_read on drivers for select to authenticated using (skyway_is_driver(location_id));
drop policy if exists drivers_driver_update on drivers;
create policy drivers_driver_update on drivers for update to authenticated
  using (skyway_is_driver(location_id) and id = skyway_driver_id()) with check (skyway_is_driver(location_id) and id = skyway_driver_id());
drop policy if exists vehicles_driver_read on vehicles;
create policy vehicles_driver_read on vehicles for select to authenticated using (skyway_is_driver(location_id));
drop policy if exists locations_driver_read on locations;
create policy locations_driver_read on locations for select to authenticated using (skyway_is_driver(id));
drop policy if exists driver_locations_driver_insert on driver_locations;
create policy driver_locations_driver_insert on driver_locations for insert to authenticated
  with check (skyway_is_driver(location_id) and driver_id = skyway_driver_id());
drop policy if exists trip_events_driver_insert on trip_events;
create policy trip_events_driver_insert on trip_events for insert to authenticated
  with check (skyway_is_driver(location_id) and driver_id = skyway_driver_id());
drop policy if exists trip_events_driver_read on trip_events;
create policy trip_events_driver_read on trip_events for select to authenticated
  using (skyway_is_driver(location_id) and driver_id = skyway_driver_id());
drop policy if exists offers_driver_rw on offers;
create policy offers_driver_rw on offers for all to authenticated
  using (skyway_is_driver(location_id) and driver_id = skyway_driver_id()) with check (skyway_is_driver(location_id) and driver_id = skyway_driver_id());
drop policy if exists device_sessions_driver_rw on device_sessions;
create policy device_sessions_driver_rw on device_sessions for all to authenticated
  using (skyway_is_driver(location_id) and driver_id = skyway_driver_id()) with check (skyway_is_driver(location_id) and driver_id = skyway_driver_id());
drop policy if exists settlements_driver_read on settlements;
create policy settlements_driver_read on settlements for select to authenticated
  using (skyway_is_driver(location_id) and driver_id = skyway_driver_id());

-- ---- Phase 1 "dual run" convenience: the console syncs with the anon key before
--      dispatcher logins exist.  This lets ANYONE holding the anon key read and
--      write the console tables for the location, so keep the anon key off public
--      pages and REMOVE these policies (or set skyway.anon_sync_locations to '')
--      as soon as dispatcher sign-in ships.
--      TODO(owner): confirm the dual-run window; see docs/SETUP.md step 4.
alter database postgres set skyway.anon_sync_locations = 'nyc';   -- comma-separated list; '' disables
create or replace function skyway_anon_sync_ok(loc text) returns boolean
language sql stable as $$
  select loc = any(string_to_array(coalesce(current_setting('skyway.anon_sync_locations', true), ''), ','))
$$;
do $$
declare t text;
begin
  foreach t in array array['settings','trips','drivers','vehicles','accounts','addrbook','config','finance','invoices','messages','needs_you','locations'] loop
    execute format('drop policy if exists %I on %I', t || '_anon_sync', t);
    execute format('create policy %I on %I for all to anon using (skyway_anon_sync_ok(location_id)) with check (skyway_anon_sync_ok(location_id))', t || '_anon_sync', t);
  end loop;
end $$;
grant execute on function sync_reconcile(text) to anon, authenticated;
grant execute on function next_dispatch_no(text) to authenticated;
grant execute on function next_invoice_no(text) to authenticated;

-- ----------------------------------------------------------------------------
-- 12. Realtime (optional; sync.js polls, driver.html may subscribe)
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table trips; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table drivers; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table offers; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table messages; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table needs_you; exception when duplicate_object then null; end;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 13. Seed: the first location (NYC).  Edit before running elsewhere.
-- ----------------------------------------------------------------------------
insert into locations (id, name, country, tz, currency, locale, units, phone_cc, pricing_engine, body)
values ('nyc', 'New York', 'US', 'America/New_York', 'USD', 'en-US', 'mi', '+1', 'nyc_tlc_meter',
        '{"geofenceM":150,"offerSeconds":90,"base":"B01593"}'::jsonb)
on conflict (id) do nothing;
select ensure_location_sequences('nyc', 1001, 1001);
