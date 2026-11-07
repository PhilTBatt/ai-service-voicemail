-- migrate:up

-- Onboarding (BUILD_PLAN Step 11): where each business is on the way to answering calls, and
-- whether it's a free pilot (allowed past "payment set up" before billing exists, Step 12).
ALTER TABLE tenants ADD COLUMN onboarding_state text NOT NULL DEFAULT 'created' CHECK (
  onboarding_state IN (
    'created', 'terms_accepted', 'payment_ready', 'number_provisioned', 'profile_complete',
    'agent_synced', 'divert_instructions_sent', 'test_call_received', 'live'
  )
);
ALTER TABLE tenants ADD COLUMN is_pilot boolean NOT NULL DEFAULT false;

-- Businesses already answering calls were set up before onboarding existed.
UPDATE tenants SET onboarding_state = 'live'
WHERE status IN ('live', 'paused', 'cancelling', 'cancelled');

-- migrate:down

ALTER TABLE tenants DROP COLUMN is_pilot;
ALTER TABLE tenants DROP COLUMN onboarding_state;
