CREATE TYPE "public"."account_status" AS ENUM('pending', 'syncing', 'ok', 'auth_error', 'throttled', 'error', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."address_role" AS ENUM('from', 'to', 'cc', 'bcc', 'reply_to');--> statement-breakpoint
CREATE TYPE "public"."body_state" AS ENUM('none', 'fetched', 'evicted');--> statement-breakpoint
CREATE TYPE "public"."folder_role" AS ENUM('inbox', 'sent', 'drafts', 'trash', 'spam', 'archive', 'all', 'important', 'starred');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'admin', 'member', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."pending_status" AS ENUM('pending', 'approved', 'rejected', 'executed', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."send_policy" AS ENUM('allow', 'approve', 'deny');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"module_id" text NOT NULL,
	"address" text NOT NULL,
	"display_name" text,
	"credentials_enc" "bytea" NOT NULL,
	"data_key_enc" "bytea" NOT NULL,
	"status" "account_status" DEFAULT 'pending' NOT NULL,
	"status_message" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"instructions" text,
	"last_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "addresses" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "addresses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "attachments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"account_id" uuid NOT NULL,
	"message_id" bigint NOT NULL,
	"part_id" text NOT NULL,
	"filename" text,
	"mime" text,
	"size" integer,
	"content_id" text,
	"content_hash" text,
	"blob_key" text
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"org_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"account_id" uuid,
	"action" text NOT NULL,
	"target" text,
	"allowed" boolean NOT NULL,
	"detail" jsonb,
	"ip" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "folders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"account_id" uuid NOT NULL,
	"remote_id" text NOT NULL,
	"path" text NOT NULL,
	"delimiter" text,
	"kind" text DEFAULT 'folder' NOT NULL,
	"role" "folder_role",
	"sync_cursor" jsonb,
	"message_count" integer DEFAULT 0 NOT NULL,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"scopes" text[] NOT NULL,
	"folder_allow" text[],
	"folder_deny" text[],
	"send_policy" "send_policy" DEFAULT 'approve' NOT NULL,
	"recipient_allow" text[],
	"rate_limit" jsonb,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	CONSTRAINT "memberships_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "message_addresses" (
	"account_id" uuid NOT NULL,
	"message_id" bigint NOT NULL,
	"role" "address_role" NOT NULL,
	"address_id" bigint NOT NULL,
	"position" smallint DEFAULT 0 NOT NULL,
	CONSTRAINT "message_addresses_account_id_message_id_role_position_pk" PRIMARY KEY("account_id","message_id","role","position")
);
--> statement-breakpoint
CREATE TABLE "message_folders" (
	"account_id" uuid NOT NULL,
	"folder_id" bigint NOT NULL,
	"message_id" bigint NOT NULL,
	"remote_uid" bigint,
	"date" timestamp with time zone NOT NULL,
	"seen" boolean DEFAULT false NOT NULL,
	CONSTRAINT "message_folders_account_id_folder_id_message_id_pk" PRIMARY KEY("account_id","folder_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"account_id" uuid NOT NULL,
	"id" bigint GENERATED ALWAYS AS IDENTITY (sequence name "messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"thread_id" bigint,
	"remote_id" text NOT NULL,
	"message_id_hdr" text,
	"in_reply_to" text,
	"subject" text,
	"date" timestamp with time zone NOT NULL,
	"from_address_id" bigint,
	"from_name" text,
	"from_email" text,
	"seen" boolean DEFAULT false NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"answered" boolean DEFAULT false NOT NULL,
	"draft" boolean DEFAULT false NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"snippet" text,
	"size" integer,
	"has_attachments" boolean DEFAULT false NOT NULL,
	"raw_blob_key" text,
	"body_blob_key" text,
	"body_state" "body_state" DEFAULT 'none' NOT NULL,
	"headers_extra" jsonb,
	"search_tsv" "tsvector",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_account_id_id_pk" PRIMARY KEY("account_id","id")
);
--> statement-breakpoint
CREATE TABLE "modules_installed" (
	"org_id" uuid NOT NULL,
	"module_id" text NOT NULL,
	"version" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"license_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "modules_installed_org_id_module_id_pk" PRIMARY KEY("org_id","module_id")
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"grant_id" uuid,
	"agent_id" uuid,
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "pending_status" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_index_state" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"driver" text NOT NULL,
	"last_indexed_at" timestamp with time zone,
	"pending_count" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "threads_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"account_id" uuid NOT NULL,
	"remote_thread_id" text,
	"subject" text,
	"last_message_at" timestamp with time zone,
	"message_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"password_hash" text NOT NULL,
	"totp_secret_enc" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_addresses" ADD CONSTRAINT "message_addresses_address_id_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_folders" ADD CONSTRAINT "message_folders_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modules_installed" ADD CONSTRAINT "modules_installed_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_actions" ADD CONSTRAINT "pending_actions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_actions" ADD CONSTRAINT "pending_actions_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_actions" ADD CONSTRAINT "pending_actions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_actions" ADD CONSTRAINT "pending_actions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_actions" ADD CONSTRAINT "pending_actions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_index_state" ADD CONSTRAINT "search_index_state_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_org_idx" ON "accounts" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_org_address_uq" ON "accounts" USING btree ("org_id",lower("address"));--> statement-breakpoint
CREATE UNIQUE INDEX "addresses_org_email_uq" ON "addresses" USING btree ("org_id","email");--> statement-breakpoint
CREATE INDEX "agents_org_idx" ON "agents" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_uq" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "attachments_message_idx" ON "attachments" USING btree ("account_id","message_id");--> statement-breakpoint
CREATE INDEX "audit_org_at_idx" ON "audit_log" USING btree ("org_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_log" USING btree ("actor_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "folders_account_remote_uq" ON "folders" USING btree ("account_id","remote_id");--> statement-breakpoint
CREATE UNIQUE INDEX "grants_agent_account_uq" ON "grants" USING btree ("agent_id","account_id");--> statement-breakpoint
CREATE INDEX "message_addresses_addr_idx" ON "message_addresses" USING btree ("address_id","account_id");--> statement-breakpoint
CREATE INDEX "message_folders_list_idx" ON "message_folders" USING btree ("account_id","folder_id","date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "message_folders_unread_idx" ON "message_folders" USING btree ("account_id","folder_id") WHERE NOT "message_folders"."seen";--> statement-breakpoint
CREATE INDEX "message_folders_uid_idx" ON "message_folders" USING btree ("folder_id","remote_uid");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_account_remote_uq" ON "messages" USING btree ("account_id","remote_id");--> statement-breakpoint
CREATE INDEX "messages_account_date_idx" ON "messages" USING btree ("account_id","date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "messages_account_thread_idx" ON "messages" USING btree ("account_id","thread_id");--> statement-breakpoint
CREATE INDEX "messages_account_msgid_idx" ON "messages" USING btree ("account_id","message_id_hdr");--> statement-breakpoint
CREATE INDEX "messages_search_tsv_idx" ON "messages" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "pending_actions_org_status_idx" ON "pending_actions" USING btree ("org_id","status","created_at");--> statement-breakpoint
CREATE INDEX "threads_account_last_idx" ON "threads" USING btree ("account_id","last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "threads_account_remote_uq" ON "threads" USING btree ("account_id","remote_thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree (lower("email"));