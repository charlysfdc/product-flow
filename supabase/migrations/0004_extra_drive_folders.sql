-- A merged product can own more than one Drive folder; keep the extra ones as links.
-- [{"id": "<drive folder id>", "name": "<folder name>"}]
alter table products add column extra_drive_folders jsonb not null default '[]'::jsonb;
