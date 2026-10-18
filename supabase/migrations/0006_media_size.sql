-- Phase 2 Film: what was uploaded, so "original quality" can be checked.
-- size_bytes: the file's size in Drive (the phone checks it matches what it sent).
-- codec: the video codec the phone read from the file (hevc = the iPhone's own
-- High Efficiency recording; h264 from an HEVC phone means the picker converted it).
-- The app and the drive function work without these columns until this is applied.

alter table media add column if not exists size_bytes bigint;
alter table media add column if not exists codec text;

-- Sync and the product screen look clips up per product and kind.
create index if not exists media_product_kind_idx on media (product_id, kind);
