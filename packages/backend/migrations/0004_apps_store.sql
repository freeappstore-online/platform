-- Track which storefront an app belongs to so `fas list` and any future
-- per-store dashboards can filter. Defaults to 'apps' for the rows that
-- existed before games support shipped (FreeAppStore was the only target
-- at that point, so the default reflects reality).
ALTER TABLE apps ADD COLUMN store TEXT NOT NULL DEFAULT 'apps';
