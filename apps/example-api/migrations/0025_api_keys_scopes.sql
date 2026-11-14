-- Preserve pre-scope API key authority explicitly; scopes are independent grants.
ALTER TABLE "api_keys" ADD COLUMN "scopes" text NOT NULL DEFAULT '';
UPDATE "api_keys" SET "scopes" = 'read,write,admin';
