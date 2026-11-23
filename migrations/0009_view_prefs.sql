-- Per-account view preferences (JSON object, validated and size-capped by the API).
-- Additive; existing rows read '{}'. layout_theme stays the source of truth for layout.
ALTER TABLE user_accounts ADD COLUMN view_prefs TEXT NOT NULL DEFAULT '{}';
