ALTER TABLE pixkit_email_identities
    ADD COLUMN IF NOT EXISTS password_hash VARCHAR(180) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN IF NOT EXISTS verified_at DATETIME(3) NULL;

ALTER TABLE pixkit_email_challenges
    ADD COLUMN IF NOT EXISTS password_hash VARCHAR(180) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN IF NOT EXISTS purpose VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'signup';

CREATE TABLE IF NOT EXISTS pixkit_password_limits (
    subject_key BINARY(32) NOT NULL,
    window_start BIGINT UNSIGNED NOT NULL,
    attempts SMALLINT UNSIGNED NOT NULL,
    PRIMARY KEY (subject_key),
    KEY pixkit_password_limits_window (window_start)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS pixkit_email_delivery_limits (
    subject_key BINARY(32) NOT NULL,
    window_start BIGINT UNSIGNED NOT NULL,
    issued_count SMALLINT UNSIGNED NOT NULL,
    issued_at BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (subject_key),
    KEY pixkit_email_delivery_limits_window (window_start)
) ENGINE=InnoDB;
