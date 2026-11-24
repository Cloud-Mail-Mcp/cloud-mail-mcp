CREATE TABLE "account_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"module_id" text NOT NULL,
	"address" text NOT NULL,
	"display_name" text,
	"label" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"agent_id" uuid,
	"access" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "can_add_accounts" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "account_drafts" ADD CONSTRAINT "account_drafts_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_drafts" ADD CONSTRAINT "account_drafts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_drafts_org_idx" ON "account_drafts" USING btree ("org_id");