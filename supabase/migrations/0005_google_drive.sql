-- Phase 1 Intake: the Google Drive connection used by the drive edge function.
-- One row: Charly's Drive. Only the service role (edge functions) can read or
-- write it; RLS is on with no policies, so the phone can never see the token.

create table if not exists google_drive (
  id boolean primary key default true check (id),
  email text,
  refresh_token text not null,
  content_library_id text,
  products_folder_id text,
  connected_by uuid references profiles(id),
  updated_at timestamptz not null default now()
);
alter table google_drive enable row level security;
revoke all on google_drive from anon, authenticated;

-- Add product looks products up by barcode.
create index if not exists products_upc_idx on products (upc) where upc is not null;
