-- Any account may own several active workspaces (Rico, 2026-11-22).
-- Reverses 0003_single_personal_workspace.sql.
DROP INDEX IF EXISTS idx_one_active_workspace_per_owner;
