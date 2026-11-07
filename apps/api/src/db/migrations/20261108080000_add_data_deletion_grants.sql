-- migrate:up

-- Deleting a business's data (BUILD_PLAN Step 13) runs as the admin role, which could only read
-- the onboarding texts until now. The other tables it clears already allow it.
GRANT DELETE ON onboarding_texts TO callmate_admin;

-- migrate:down

REVOKE DELETE ON onboarding_texts FROM callmate_admin;
