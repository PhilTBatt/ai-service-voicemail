-- migrate:up

-- Two earlier migrations filled in tenants for businesses that already existed:
-- 20261108040000 (businesses already answering calls start onboarding at 'live') and
-- 20261108070000 (businesses already cancelling count their 30 days from then). Both ran as the
-- table owner, which tenants' row-level security lets read every row (owner_mobile_lookup) but
-- update none while no tenant is set, so both updated nothing. This runs them again with
-- row-level security not forced on the owner, for this transaction only.
ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;

UPDATE tenants SET onboarding_state = 'live'
WHERE status IN ('live', 'paused', 'cancelling', 'cancelled') AND onboarding_state = 'created';

UPDATE tenants SET cancellation_requested_at = now()
WHERE status = 'cancelling' AND cancellation_requested_at IS NULL;

ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

-- migrate:down

-- Nothing to undo: this only sets what the earlier migrations meant to.
