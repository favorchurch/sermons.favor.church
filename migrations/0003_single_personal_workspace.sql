-- One active pilot workspace per Owner. The route's existence check is not atomic,
-- so concurrent creates must be rejected by the database.
CREATE UNIQUE INDEX idx_one_active_workspace_per_owner
  ON workspaces(owner_account_id) WHERE deleted_at IS NULL;
