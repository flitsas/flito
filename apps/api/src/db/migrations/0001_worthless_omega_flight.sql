CREATE TYPE "public"."audit_action" AS ENUM('login', 'login_failed', 'logout', 'create', 'update', 'delete', 'upload', 'export', 'purchase');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"user_email" varchar(150),
	"action" "audit_action" NOT NULL,
	"resource" varchar(50) NOT NULL,
	"resource_id" varchar(50),
	"detail" text,
	"ip_address" varchar(45),
	"user_agent" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
