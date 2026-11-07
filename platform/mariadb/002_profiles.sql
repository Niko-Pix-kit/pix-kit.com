-- Apply after 001_accounts.sql. Existing account identifiers and sessions are preserved.
ALTER TABLE pixkit_users
    ADD COLUMN IF NOT EXISTS given_name VARCHAR(60) NULL,
    ADD COLUMN IF NOT EXISTS family_name VARCHAR(60) NULL,
    ADD COLUMN IF NOT EXISTS country_code CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN IF NOT EXISTS preferred_locale VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL;
