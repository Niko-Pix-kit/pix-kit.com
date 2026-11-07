-- Apply after 004_password_auth.sql. Existing members choose their nickname on their next profile edit.
ALTER TABLE pixkit_users
    ADD COLUMN IF NOT EXISTS nickname VARCHAR(24) CHARACTER SET ascii COLLATE ascii_general_ci NULL,
    ADD COLUMN IF NOT EXISTS avatar_preset VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN IF NOT EXISTS public_given_name BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS public_family_name BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS public_country BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS public_language BOOLEAN NOT NULL DEFAULT FALSE,
    ADD UNIQUE INDEX IF NOT EXISTS pixkit_users_nickname (nickname);
