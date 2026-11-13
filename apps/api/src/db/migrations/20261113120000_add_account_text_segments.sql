-- migrate:up

-- The texts about a business's account (the onboarding texts, the cancellation text) record
-- how many segments each was, as call texts do in call_costs: what the Admin page's cost
-- estimate counts them at. Null for the rows sent before this, which it counts as one each.
-- Added columns only, nullable: release-safe while the old build is still writing rows.
ALTER TABLE onboarding_texts ADD COLUMN segments integer CHECK (segments > 0);
ALTER TABLE offboarding_messages ADD COLUMN segments integer CHECK (segments > 0);

-- migrate:down

ALTER TABLE offboarding_messages DROP COLUMN segments;
ALTER TABLE onboarding_texts DROP COLUMN segments;
