-- What linking a deal to a product created, so Unlink can undo exactly that:
-- {"listing_id": uuid, "post_id": uuid, "product_before": {field: previous value},
--  "created_product": true, "stamped_received": true}
alter table deals add column link_added jsonb;
