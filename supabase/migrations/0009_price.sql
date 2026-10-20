-- The product's price in US dollars, for taxes later (with products.source, totals can be worked out
-- when needed; no screen or export for it). Filled from the brand deal or the Amazon page, or typed on
-- the Product screen; the app never overwrites a price that is already set.

alter table products add column if not exists price numeric(10,2);

-- Backfill: products with no price take the price of their earliest linked deal that has one
-- (deals.price is ViralVue's listed price). The editor reports how many rows this updated.
update products p
set price = d.price
from (
  select distinct on (product_id) product_id, round(price, 2) as price
  from deals
  where product_id is not null and price is not null and price > 0
  order by product_id, coalesce(deal_created_at, created_at), created_at
) d
where p.id = d.product_id and p.price is null;

-- What it did: products with a price now, and still without (hidden ones counted apart).
select
  count(*) filter (where price is not null)                          as with_price,
  count(*) filter (where price is null and archived_at is null)      as still_empty,
  count(*) filter (where price is null and archived_at is not null)  as still_empty_hidden
from products;
