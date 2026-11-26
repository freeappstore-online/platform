-- One open lease per runner, not per user (#825): the contributor device that
-- holds the lease. `ndev:<device id>` for a native companion device, `web:<id>`
-- for a browser's X-Runner-Id, '' for a session that sends none (one default
-- runner per user, as before). A user holds at most a few open leases in all.
ALTER TABLE generation_leases ADD COLUMN runner TEXT NOT NULL DEFAULT '';
