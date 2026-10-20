-- A received date that was worked out, not recorded: the earliest capture date of the product's clips
-- in Drive (or its first post), set by the one-time backfill from the Mac. The Product screen shows
-- "≈ Jul 5 (estimated)"; setting the date by hand clears the flag.

alter table products add column if not exists received_estimated boolean not null default false;
