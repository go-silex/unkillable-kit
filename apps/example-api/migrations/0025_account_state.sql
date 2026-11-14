-- Global user identity state; existing accounts remain enabled.
ALTER TABLE user ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1));
