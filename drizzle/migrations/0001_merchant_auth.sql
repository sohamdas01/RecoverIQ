CREATE TABLE "merchants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"webhook_secret" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_users" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone
);
--> statement-breakpoint
-- Tenant that owns every pre-existing row and any row created without an explicit merchant.
-- It has no login users, so its data is not reachable through the merchant API until one is created.
INSERT INTO "merchants" ("id", "name", "status", "webhook_secret")
VALUES ('merchant_default', 'Default Merchant', 'active', replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''));
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "merchant_id" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "merchant_id" text;--> statement-breakpoint
UPDATE "customers" SET "merchant_id" = 'merchant_default' WHERE "merchant_id" IS NULL;--> statement-breakpoint
UPDATE "transactions" SET "merchant_id" = 'merchant_default' WHERE "merchant_id" IS NULL;--> statement-breakpoint
ALTER TABLE "customers" ALTER COLUMN "merchant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "merchant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_users" ADD CONSTRAINT "merchant_users_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_users_email_unique" ON "merchant_users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "merchant_users_merchant_idx" ON "merchant_users" USING btree ("merchant_id");--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_merchant_email_unique" ON "customers" USING btree ("merchant_id","email");--> statement-breakpoint
CREATE INDEX "transactions_merchant_created_idx" ON "transactions" USING btree ("merchant_id","created_at");
