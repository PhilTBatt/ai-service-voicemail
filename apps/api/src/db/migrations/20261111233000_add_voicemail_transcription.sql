-- migrate:up

-- Voicemail transcription (decision 022). A caller who gets the fallback voicemail (the assistant
-- unavailable, a paused business, the kill switch) leaves a recording nobody reads: "I smell gas"
-- left there arrived as a plain "new voicemail" text. With the switch on, the API asks Twilio to
-- transcribe each voicemail; the transcript gets the same summary and urgency as a call, so an
-- emergency text goes and the tradesperson gets a summary. It costs money (about 2p a minute), so
-- it's off until Phil turns it on from the Admin page, where the last 30 days' voicemails show what
-- it would have cost.

-- The switch, beside the kill switch: one row for the whole service.
ALTER TABLE system_settings
  ADD COLUMN voicemail_transcription_on boolean NOT NULL DEFAULT false;

-- Each voicemail's transcription at the provider: its ID (Twilio's transcription id, which the
-- result webhook names), where it's got to, and when it was asked for. The text itself goes in
-- calls.transcript, like a call's. calls keeps its row-level security; new columns come under it.
ALTER TABLE calls
  ADD COLUMN transcription_ref text,
  ADD COLUMN transcription_status text
    CHECK (transcription_status IN ('requested', 'completed', 'failed')),
  ADD COLUMN transcription_requested_at timestamptz;

-- The result webhook names the transcription, not the business: the lookup, and nothing else,
-- reads past row-level security, as tenant_id_for_call does (the owner policy from
-- 20261107000000 already lets the owner role read calls).
CREATE UNIQUE INDEX calls_transcription_ref_idx ON calls (transcription_ref)
  WHERE transcription_ref IS NOT NULL;

CREATE FUNCTION tenant_id_for_transcription_ref(ref text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT tenant_id FROM public.calls WHERE transcription_ref = $1
  $$;

REVOKE EXECUTE ON FUNCTION tenant_id_for_transcription_ref(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_id_for_transcription_ref(text) TO callmate_app;

-- migrate:down

DROP FUNCTION tenant_id_for_transcription_ref(text);
DROP INDEX calls_transcription_ref_idx;
ALTER TABLE calls
  DROP COLUMN transcription_requested_at,
  DROP COLUMN transcription_status,
  DROP COLUMN transcription_ref;
ALTER TABLE system_settings DROP COLUMN voicemail_transcription_on;
