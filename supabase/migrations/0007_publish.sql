-- Phase 4 Publish: skipped platforms, ready-to-copy post text, ViralVue reminders.
-- The app works without this until it is applied (no Skip, no saved copy text, no reminders).

-- 1. "Not posting here": a planned platform Charly decides to skip counts as finished for Done.
alter type post_status add value if not exists 'skipped';

-- 2. Text to paste when posting, written by Claude (publish function) and editable on the phone.
-- {"amazon_title": "...", "amazon_description": "...", "tiktok_caption": "...",
--  "job_id": "<edit job it was written from>", "generated_at": "...", "edited_at": "..."}
alter table products add column if not exists post_copy jsonb;

-- 3. Ticks to do by hand in ViralVue (it has no API): Received, Video published, Message the brand.
-- Made by the app when a box arrives / the Amazon video is marked posted, and by the deals import
-- for published deals with no brand message. Cleared by "Done in ViralVue" or by a later import
-- that shows the tick in ViralVue.
create type viralvue_task as enum ('received', 'published', 'message');

create table viralvue_reminders (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references deals(id) on delete cascade,
  kind viralvue_task not null,
  created_at timestamptz not null default now(),
  done_at timestamptz,
  done_how text check (done_how in ('manual', 'import')),
  done_by uuid references profiles(id) on delete set null,
  unique (deal_id, kind)
);
create index viralvue_reminders_open_idx on viralvue_reminders (created_at) where done_at is null;

alter table viralvue_reminders enable row level security;
create policy "allowed all viralvue_reminders" on viralvue_reminders for all to authenticated using (is_allowed()) with check (is_allowed());
alter publication supabase_realtime add table viralvue_reminders;

-- Boxes the app recorded as arrived ("It arrived", Add product deal match) that ViralVue doesn't know yet.
insert into viralvue_reminders (deal_id, kind)
select id, 'received' from deals
where match_status = 'matched' and product_id is not null
  and coalesce((link_added ->> 'stamped_received')::boolean, false)
on conflict (deal_id, kind) do nothing;

-- Published deals with no message to the brand (23 in the 18 Oct export).
insert into viralvue_reminders (deal_id, kind)
select id, 'message' from deals
where published_at is not null and message_sent_at is null and match_status <> 'ignored'
on conflict (deal_id, kind) do nothing;

-- Views import matches Amazon videos by title when the video id isn't recorded yet.
create index if not exists posts_title_idx on posts (lower(title)) where title is not null;
