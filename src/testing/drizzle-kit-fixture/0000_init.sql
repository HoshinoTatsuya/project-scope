CREATE TABLE "items" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"body" text
);
--> statement-breakpoint
ALTER TABLE "items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "scope_app_project_id" ON "items" AS PERMISSIVE FOR ALL TO public USING ("project_id" = NULLIF(current_setting('app.project_id', true), '')::uuid) WITH CHECK ("project_id" = NULLIF(current_setting('app.project_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "scope_app_project_id_maintenance" ON "items" AS PERMISSIVE FOR ALL TO "app_maintenance" USING (true) WITH CHECK (true);