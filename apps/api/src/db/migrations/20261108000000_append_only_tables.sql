-- migrate:up

-- audit_log and terms_acceptances are append-only records. The admin role could update and
-- delete them (decision 006 granted every table the same four privileges); now it can only
-- read and add, so the history can't be rewritten by anything that runs as that role.
REVOKE UPDATE, DELETE ON audit_log, terms_acceptances FROM callmate_admin;

-- migrate:down

GRANT UPDATE, DELETE ON audit_log, terms_acceptances TO callmate_admin;
