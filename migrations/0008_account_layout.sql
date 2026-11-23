-- Per-account layout preference. This is additive; existing accounts retain the default A layout.
ALTER TABLE user_accounts ADD COLUMN layout_theme TEXT NOT NULL DEFAULT 'a'
  CHECK (layout_theme IN ('a', 'c', 'original'));
