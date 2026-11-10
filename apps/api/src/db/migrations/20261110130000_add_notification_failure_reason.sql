-- migrate:up

-- Why a text or email couldn't be sent, in the provider's words as the job saw them (already
-- redacted of any number or address: providers/*.ts). The admin's health screen shows the
-- last few, so a failed send can be understood without the worker's log. Null unless the
-- send threw; a carrier's later "undelivered" verdict goes in failure_code as before.
ALTER TABLE notifications ADD COLUMN failure_reason text;

-- migrate:down

ALTER TABLE notifications DROP COLUMN failure_reason;
