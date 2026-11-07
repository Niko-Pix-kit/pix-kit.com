ALTER TABLE pixkit_email_challenges
    ADD COLUMN IF NOT EXISTS email_address VARBINARY(254) NULL,
    ADD COLUMN IF NOT EXISTS verification_hash BINARY(32) NULL;

UPDATE pixkit_email_challenges
SET flow_hash = NULL, code_hash = NULL, signup_profile = NULL, password_hash = NULL,
    email_address = NULL, verification_hash = NULL, attempts_left = 0
WHERE verification_hash IS NULL AND code_hash IS NOT NULL;
