-- migrate:up

-- What each synced profile was last sent to the voice platform, as a fingerprint
-- (VoiceProvider.agentFingerprint: a hash of the exact agent and flow sent, prompt, scripts,
-- model, voice and webhook addresses included). A profile used to be synced once per version,
-- so a release that changed the prompt (or the webhook address, after the domain move) left
-- every existing agent on the old one until its business next saved a change. Now the worker,
-- as it starts, re-syncs any business whose latest profile would be sent differently today
-- (jobs/sync-agent.ts). NULL for profiles synced before this: they're re-synced once.
-- agent_profiles keeps its row-level security; the app role already updates it.
ALTER TABLE agent_profiles ADD COLUMN synced_fingerprint text;

-- migrate:down

ALTER TABLE agent_profiles DROP COLUMN synced_fingerprint;
