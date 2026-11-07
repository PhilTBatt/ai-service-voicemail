-- migrate:up

-- Accounts are created by invitation, before the person has ever logged in (BUILD_PLAN
-- Step 10). At that point we know their email and role, but not the login provider's subject
-- ID, which only exists once they've signed in. So the subject is empty until first login,
-- when claim_account() fills it in by matching the provider's verified email.
ALTER TABLE users ALTER COLUMN auth_subject DROP NOT NULL;
-- One account per address, however it's capitalised.
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

-- First login: claims the invited row for this subject and returns the account, or nothing.
-- Only an unclaimed row with the same email can be claimed, and only by a subject that owns
-- no account yet, so a row can never move from one login to another.
CREATE FUNCTION claim_account(subject text, login_email text)
  RETURNS TABLE (user_id uuid, email text, role text, tenant_id uuid)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    WITH claimed AS (
      UPDATE public.users SET auth_subject = subject
      WHERE auth_subject IS NULL
        AND lower(email) = lower(login_email)
        AND NOT EXISTS (SELECT 1 FROM public.users WHERE auth_subject = subject)
      RETURNING id
    )
    SELECT u.id, u.email::text, u.role, m.tenant_id
    FROM public.users u
    JOIN claimed ON claimed.id = u.id
    LEFT JOIN public.tenant_memberships m ON m.user_id = u.id
  $$;

REVOKE EXECUTE ON FUNCTION claim_account(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_account(text, text) TO callmate_app;

-- migrate:down

DROP FUNCTION claim_account(text, text);
DROP INDEX users_email_unique;
DELETE FROM users WHERE auth_subject IS NULL;
ALTER TABLE users ALTER COLUMN auth_subject SET NOT NULL;
