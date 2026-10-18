-- Product Flow: Phase 0 schema
-- Five tables from the plan's data model plus profiles.
-- Everything is readable and writable by any signed-in user (Charly and Zanje);
-- the anon role sees nothing.

create extension if not exists "pgcrypto";

-- Enumerated values ------------------------------------------------------

create type product_status as enum ('expected', 'received', 'filmed', 'editing', 'ready', 'done');
create type product_source as enum ('amazon_sample', 'tiktok_sample', 'bought', 'brand_direct', 'unknown');
create type platform as enum (
  'amazon_us', 'amazon_ca', 'amazon_uk', 'amazon_de', 'amazon_nl',
  'tiktok_shop', 'instagram', 'facebook', 'youtube', 'pinterest'
);
create type listing_availability as enum ('exact', 'similar_only', 'not_listed', 'unchecked');
create type media_kind as enum ('intake_photo', 'raw_clip', 'finished_horizontal', 'finished_vertical', 'thumbnail');
create type post_status as enum ('planned', 'posted');
create type job_type as enum ('identify', 'edit', 'thumbnail');
create type job_status as enum ('queued', 'running', 'needs_review', 'done', 'failed');

-- Helpers ----------------------------------------------------------------

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- allowed_emails: only these Google accounts may sign in --------------------

create table allowed_emails (
  email text primary key,
  note text,
  created_at timestamptz not null default now()
);
insert into allowed_emails (email, note) values ('afrikanerinamerika@gmail.com', 'Charly');
-- Add Zanje with: insert into allowed_emails (email, note) values ('<her gmail>', 'Zanje');

create or replace function is_allowed() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from allowed_emails where lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;

-- profiles: one row per signed-in Google account -------------------------

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now()
);

create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from allowed_emails where lower(email) = lower(coalesce(new.email, ''))) then
    raise exception 'This Google account is not allowed to sign in to Product Flow';
  end if;
  insert into profiles (id, email, display_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do update
    set email = excluded.email,
        display_name = excluded.display_name,
        avatar_url = excluded.avatar_url;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- products: one row per product (one Drive folder) ------------------------

create table products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  brand text,
  variant text,
  upc text,
  source product_source not null default 'unknown',
  status product_status not null default 'received',
  deadline date,
  drive_folder_id text,
  drive_folder_name text,
  product_image_url text,
  received_at date,
  notes text,
  added_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index products_name_key on products (lower(name));
create index products_status_idx on products (status);
create trigger products_updated_at before update on products for each row execute function set_updated_at();

-- listings: a product on one platform or marketplace ----------------------

create table listings (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  platform platform not null,
  external_id text,            -- ASIN per marketplace, TikTok product id
  url text,
  commission text,             -- as recorded ("17% (~$5.10)"); numeric later if needed
  availability listing_availability not null default 'unchecked',
  availability_note text,      -- e.g. "Yes - Kitsch official"
  checked_at date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index listings_product_idx on listings (product_id);
create index listings_external_id_idx on listings (external_id);
create unique index listings_product_platform_external_key on listings (product_id, platform, coalesce(external_id, ''));
create trigger listings_updated_at before update on listings for each row execute function set_updated_at();

-- media: a file in Drive --------------------------------------------------

create table media (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  kind media_kind not null,
  drive_file_id text,
  filename text not null,
  duration_s numeric,
  width int,
  height int,
  shot_on text,                -- which iPhone
  uploaded_by uuid references profiles(id),
  uploaded_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index media_product_idx on media (product_id);
create unique index media_drive_file_key on media (drive_file_id) where drive_file_id is not null;

-- posts: a video on one platform ------------------------------------------

create table posts (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  media_id uuid references media(id) on delete set null,
  platform platform not null,
  status post_status not null default 'planned',
  external_id text,            -- e.g. the ViralVue / Amazon video id
  title text,
  url text,
  posted_at date,
  views int,
  views_checked_at date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index posts_product_idx on posts (product_id);
create unique index posts_platform_external_key on posts (platform, external_id) where external_id is not null;
create trigger posts_updated_at before update on posts for each row execute function set_updated_at();

-- jobs: a piece of worker work --------------------------------------------

create table jobs (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references products(id) on delete cascade,
  type job_type not null,
  status job_status not null default 'queued',
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  log text,
  question text,               -- what "needs review" is asking
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);
create index jobs_status_idx on jobs (status, created_at);
create index jobs_product_idx on jobs (product_id);
create trigger jobs_updated_at before update on jobs for each row execute function set_updated_at();

-- Row-level security: any allowed signed-in user has full access -----------

alter table profiles enable row level security;
alter table products enable row level security;
alter table listings enable row level security;
alter table media    enable row level security;
alter table posts    enable row level security;
alter table jobs     enable row level security;

alter table allowed_emails enable row level security;

create policy "allowed read profiles"  on profiles for select to authenticated using (is_allowed());
create policy "own profile update"     on profiles for update to authenticated using (id = auth.uid() and is_allowed()) with check (id = auth.uid());
create policy "allowed read allowed"   on allowed_emails for select to authenticated using (is_allowed());

create policy "allowed all products"   on products for all to authenticated using (is_allowed()) with check (is_allowed());
create policy "allowed all listings"   on listings for all to authenticated using (is_allowed()) with check (is_allowed());
create policy "allowed all media"      on media    for all to authenticated using (is_allowed()) with check (is_allowed());
create policy "allowed all posts"      on posts    for all to authenticated using (is_allowed()) with check (is_allowed());
create policy "allowed all jobs"       on jobs     for all to authenticated using (is_allowed()) with check (is_allowed());

-- Realtime: let the phone subscribe to changes
alter publication supabase_realtime add table products, jobs, posts;
