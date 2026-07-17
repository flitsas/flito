CREATE TYPE "public"."user_role" AS ENUM('admin', 'proveedor');--> statement-breakpoint
CREATE TYPE "public"."soat_status" AS ENUM('pendiente', 'enviado', 'comprado', 'verificado', 'rechazado');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "soat_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"vehicle_id" integer NOT NULL,
	"status" "soat_status" DEFAULT 'pendiente' NOT NULL,
	"requested_by" integer NOT NULL,
	"assigned_to" integer,
	"policy_number" varchar(50),
	"insurer" varchar(100),
	"purchase_date" date,
	"expiry_date" date,
	"runt_verified" boolean DEFAULT false NOT NULL,
	"runt_verified_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"email" varchar(150) NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'admin' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vehicles" (
	"id" serial PRIMARY KEY NOT NULL,
	"vin" varchar(17) NOT NULL,
	"plate" varchar(10),
	"owner_name" varchar(200),
	"owner_document" varchar(20),
	"brand" varchar(50),
	"model" varchar(50),
	"year" integer,
	"vehicle_class" varchar(50),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vehicles_vin_unique" UNIQUE("vin")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "soat_requests" ADD CONSTRAINT "soat_requests_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "soat_requests" ADD CONSTRAINT "soat_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "soat_requests" ADD CONSTRAINT "soat_requests_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
