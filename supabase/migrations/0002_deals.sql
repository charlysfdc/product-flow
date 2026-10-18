-- Product Flow: brand deals (ViralVue Amazon export; TikTok Shop later)
-- One row per deal on one platform; linked to a product when matched.

-- waiting: messaged, nothing arrived yet (no product); needs_review: arrived but
-- matched no product; matched: linked to a product; ignored: kept out of lists.
create type deal_match_status as enum ('waiting', 'needs_review', 'matched', 'ignored');

create table deals (
  id uuid primary key default gen_random_uuid(),
  platform platform not null,
  external_id text not null,                 -- ViralVue Deal ID
  product_id uuid references products(id) on delete set null,
  brand text,
  asin text,
  title text,
  price numeric,
  fee numeric,
  image_url text,                            -- full-size product image
  message_sent_at timestamptz,
  received_at timestamptz,
  video_created_at timestamptz,
  published_at timestamptz,
  deal_created_at timestamptz,
  deal_updated_at timestamptz,
  status_raw text,                           -- ViralVue's own Status column, as exported
  match_status deal_match_status not null default 'waiting',
  imported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (platform, external_id)
);
create index deals_product_idx on deals (product_id);
create index deals_match_idx on deals (match_status);
create index deals_asin_idx on deals (asin);
create trigger deals_updated_at before update on deals for each row execute function set_updated_at();

alter table deals enable row level security;
create policy "allowed all deals" on deals for all to authenticated using (is_allowed()) with check (is_allowed());

alter publication supabase_realtime add table deals;
