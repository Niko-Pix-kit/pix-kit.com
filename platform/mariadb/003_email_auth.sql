-- Run after 002_profiles.sql in the dedicated PixKit database.
ALTER TABLE pixkit_users MODIFY COLUMN google_subject VARBINARY(255) NULL;

CREATE TABLE IF NOT EXISTS pixkit_email_identities (
    email VARBINARY(254) NOT NULL,
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY (email),
    UNIQUE KEY pixkit_email_identities_user (user_id),
    CONSTRAINT pixkit_email_identity_user_fk FOREIGN KEY (user_id)
        REFERENCES pixkit_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pixkit_email_challenges (
    email_key BINARY(32) NOT NULL,
    flow_hash BINARY(32),
    code_hash BINARY(32),
    signup_profile JSON,
    attempts_left TINYINT UNSIGNED NOT NULL DEFAULT 0,
    issued_at BIGINT UNSIGNED NOT NULL,
    expires_at BIGINT UNSIGNED NOT NULL,
    window_start BIGINT UNSIGNED NOT NULL,
    issued_count SMALLINT UNSIGNED NOT NULL,
    PRIMARY KEY (email_key),
    KEY pixkit_email_challenges_expiry (expires_at),
    KEY pixkit_email_challenges_window (window_start)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pixkit_email_send_limit (
    scope_id TINYINT UNSIGNED NOT NULL,
    window_start BIGINT UNSIGNED NOT NULL,
    issued_count SMALLINT UNSIGNED NOT NULL,
    PRIMARY KEY (scope_id)
) ENGINE=InnoDB;

INSERT IGNORE INTO pixkit_email_send_limit (scope_id, window_start, issued_count)
VALUES (1, 0, 0);
