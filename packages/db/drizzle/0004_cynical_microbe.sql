ALTER TABLE "oauth_clients" ADD COLUMN "token_auth_method" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "secret_hash" text;