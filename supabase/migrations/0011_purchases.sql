-- Amazon purchases: Charly's own Amazon orders (the Order History Reporter "items" CSV), imported from
-- Housekeeping. One row per order and ASIN. A purchase of a product in the app is linked to it; the rest
-- are sorted into buckets (review candidate, supplies, household, subscription).

create table purchases (
  id uuid primary key default gen_random_uuid(),
  platform platform not null default 'amazon_us',
  order_id text not null,
  order_date date,
  asin text not null,
  title text,
  quantity int not null default 1,
  unit_price numeric(10,2),
  subscribe_save boolean not null default false,
  category text,                                  -- Amazon's category path, "Health & Household›Vitamins…"
  bucket text not null default 'unsorted'
    check (bucket in ('review', 'supplies', 'household', 'subscription', 'unsorted')),
  bucket_by text check (bucket_by in ('category', 'claude', 'manual', 'match')),
  product_id uuid references products(id) on delete set null,
  link_kind text check (link_kind in ('bought', 'rebuy', 'both')),   -- bought: the product was bought; rebuy/both: a sample bought again
  ask_product_id uuid references products(id) on delete set null,  -- "Sample or bought?" waiting on Charly (a product that also has a deal)
  imported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id, asin)
);
create index purchases_asin_idx on purchases (asin);
create index purchases_product_idx on purchases (product_id);
create index purchases_bucket_idx on purchases (bucket);
create trigger purchases_updated_at before update on purchases for each row execute function set_updated_at();

alter table purchases enable row level security;
create policy "allowed all purchases" on purchases for all to authenticated using (is_allowed()) with check (is_allowed());
alter publication supabase_realtime add table purchases;

-- What an Amazon purchases import changed on a product, so "Undo" can put it back:
-- {"at": "...", "before": {"source": "amazon_sample", "price": 29.99, "received_at": null, "received_estimated": true},
--  "after": {"source": "bought", "price": 13.32, "received_at": "2026-03-02", "received_estimated": false}}
alter table products add column if not exists purchase_change jsonb;
