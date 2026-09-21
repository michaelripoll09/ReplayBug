ALTER TABLE "workspaces"
  ADD COLUMN "is_public_demo" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_single_public_demo_unique"
  ON "workspaces" USING btree ("is_public_demo")
  WHERE "workspaces"."is_public_demo" = true;
