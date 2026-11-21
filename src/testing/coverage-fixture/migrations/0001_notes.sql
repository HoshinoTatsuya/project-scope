CREATE TABLE "notes" ("id" serial PRIMARY KEY NOT NULL, "project_id" uuid NOT NULL);
ALTER TABLE "notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "scope_app_project_id" ON "notes" AS PERMISSIVE FOR ALL TO PUBLIC USING ("project_id" = NULLIF(current_setting('app.project_id', true), '')::uuid) WITH CHECK ("project_id" = NULLIF(current_setting('app.project_id', true), '')::uuid);
