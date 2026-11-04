-- migrate:up

-- Global settings, as a single row: the CHECK on the primary key means only one row can exist.
CREATE TABLE system_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  -- When on, every number routes to the fallback voicemail (BUILD_PLAN Step 4).
  kill_switch_on boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO system_settings DEFAULT VALUES;

-- The API only reads settings. Changing them is an admin action (Step 1's admin module).
GRANT SELECT ON system_settings TO callmate_app;

-- migrate:down

DROP TABLE system_settings;
