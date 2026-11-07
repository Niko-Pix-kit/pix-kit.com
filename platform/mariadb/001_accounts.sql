-- Run in the dedicated PixKit MariaDB database as the schema owner.
CREATE TABLE IF NOT EXISTS pixkit_users (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    google_subject VARBINARY(255) NOT NULL,
    email VARCHAR(254) NOT NULL,
    display_name VARCHAR(120) NOT NULL,
    avatar_url VARCHAR(2048),
    is_admin BOOLEAN NOT NULL DEFAULT FALSE,
    created_at DATETIME(3) NOT NULL,
    last_sign_in_at DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY pixkit_users_google_subject (google_subject),
    KEY pixkit_users_created (created_at, id),
    CONSTRAINT pixkit_users_admin_value CHECK (is_admin IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pixkit_sessions (
    token_hash BINARY(32) NOT NULL,
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at DATETIME(3) NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    PRIMARY KEY (token_hash),
    KEY pixkit_sessions_user (user_id),
    KEY pixkit_sessions_expiry (expires_at),
    CONSTRAINT pixkit_sessions_user_fk FOREIGN KEY (user_id)
        REFERENCES pixkit_users (id) ON DELETE CASCADE,
    CONSTRAINT pixkit_sessions_positive_lifetime CHECK (expires_at > created_at)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
