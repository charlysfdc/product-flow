-- Hide a product from the flow ("Not a product review": random phone footage that came in from the
-- Content Library seed). Hidden products drop out of Home, Post, Due soon, counts, search and the
-- ViralVue reminders; Settings > Hidden lists them with Restore. The app works without this until
-- it is applied (the Hide action then says the database update is missing).

alter table products add column if not exists archived_at timestamptz;
alter table products add column if not exists archived_reason text;   -- 'not_a_product'

-- What Hide moved in Drive, so Restore can move it back (written by the drive function):
-- {"moved": [{"id": "<folder id>", "name": "...", "from": "<Products folder id>", "to": "<AiA Life folder id>"}],
--  "note": "...", "at": "<timestamp>"}
alter table products add column if not exists archived_move jsonb;

create index if not exists products_archived_idx on products (archived_at) where archived_at is not null;
