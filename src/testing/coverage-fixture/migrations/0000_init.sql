CREATE TABLE "items" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"body" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plain" (
	"id" serial PRIMARY KEY NOT NULL
);
--> statement-breakpoint
ALTER TABLE "items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "scope_app_project_id" ON "items" AS PERMISSIVE FOR ALL TO public USING ("project_id" = NULLIF(current_setting('app.project_id', true), '')::uuid) WITH CHECK ("project_id" = NULLIF(current_setting('app.project_id', true), '')::uuid);
