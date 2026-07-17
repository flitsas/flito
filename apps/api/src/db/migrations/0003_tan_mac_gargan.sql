CREATE TYPE "public"."vehicle_stage" AS ENUM('ingreso', 'impuesto', 'soat_pendiente', 'soat_comprado', 'soat_verificado', 'listo');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "clients" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"document" varchar(20),
	"document_type" varchar(5) DEFAULT 'NIT',
	"phone" varchar(20),
	"email" varchar(150),
	"address" varchar(300),
	"city" varchar(100),
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "client_id" integer;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "stage" "vehicle_stage" DEFAULT 'ingreso' NOT NULL;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "tax_paid" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "tax_amount" integer;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "tax_date" date;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
