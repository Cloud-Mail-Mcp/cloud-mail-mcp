ALTER TABLE "ai_usage" ADD COLUMN "feature" text DEFAULT 'sorter' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "model" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "requests" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "cache_read_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "cache_write_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "cost_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_usage" DROP CONSTRAINT IF EXISTS "ai_usage_pkey";--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_day_feature_model_pk" PRIMARY KEY("day","feature","model");
