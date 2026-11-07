-- migrate:up

-- Emergencies (BUILD_PLAN Step 6) add two more texts per call: a priority one to the
-- tradesperson and a service message to the caller. Each is its own channel, so the
-- (call_id, channel) uniqueness still makes every send idempotent.
ALTER TABLE notifications DROP CONSTRAINT notifications_channel_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_channel_check
  CHECK (channel IN ('sms', 'email', 'sms_emergency', 'sms_caller'));

-- migrate:down

ALTER TABLE notifications DROP CONSTRAINT notifications_channel_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_channel_check
  CHECK (channel IN ('sms', 'email'));
