-- ============================================================================
-- Migration 002 - allow signing in with Google alongside email + password
-- ----------------------------------------------------------------------------
-- Run once against an existing database:
--   psql "$DATABASE_URL" -f database/migrations/002_google_auth.sql
--
-- The original users table assumed every account had a bcrypt hash. A Google
-- account has no password at all: Google verifies the person and hands us a
-- signed token, so there is nothing to hash and storing a dummy value would be
-- worse than storing nothing. Three changes make room for that:
--
--   password_hash becomes nullable  -> a Google-only account stores NULL here
--   auth_provider records the sign-in method so the UI can explain to someone
--                 who signed up with Google why the password form rejects them
--   google_sub    stores Google's immutable subject id, which is the correct
--                 join key: an email address can change hands, the subject
--                 cannot. It is UNIQUE so one Google account maps to one user.
--
-- Every statement is written to be safely re-runnable.
-- ============================================================================

-- Existing rows all came from the password flow, so they keep their hash and
-- are labelled accordingly by the DEFAULT below.
ALTER TABLE warehouse.users
    ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE warehouse.users
    ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(20) NOT NULL DEFAULT 'password';

ALTER TABLE warehouse.users
    ADD COLUMN IF NOT EXISTS google_sub VARCHAR(255);

-- Guard against a typo ever writing an unknown provider.
DO $$
BEGIN
    ALTER TABLE warehouse.users
        ADD CONSTRAINT ck_users_auth_provider
        CHECK (auth_provider IN ('password', 'google'));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- A password account must have a hash; a Google account must have a subject id.
-- This is the invariant that keeps a passwordless row from being usable by the
-- password login path, which is the security-relevant half of this migration.
DO $$
BEGIN
    ALTER TABLE warehouse.users
        ADD CONSTRAINT ck_users_credential_present
        CHECK (
            (auth_provider = 'password' AND password_hash IS NOT NULL)
         OR (auth_provider = 'google'   AND google_sub    IS NOT NULL)
        );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Partial unique index: many rows may have a NULL google_sub, but a non-NULL
-- one must be unique. A plain UNIQUE constraint would also work in Postgres,
-- but this states the intent and stays out of the way of password accounts.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_google_sub
    ON warehouse.users (google_sub)
    WHERE google_sub IS NOT NULL;
