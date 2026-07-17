ALTER TABLE "soat_requests" DROP CONSTRAINT "soat_requests_vehicle_id_vehicles_id_fk";
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "soat_requests" ADD CONSTRAINT "soat_requests_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_logs_created_at" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_logs_user_id" ON "audit_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_soat_requests_vehicle_id" ON "soat_requests" USING btree ("vehicle_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_soat_requests_status" ON "soat_requests" USING btree ("status");