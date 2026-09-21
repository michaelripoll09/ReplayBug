CREATE TABLE "release_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_id" uuid NOT NULL,
	"artifact_path" text NOT NULL,
	"storage_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"artifact_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "release_artifacts_release_path_unique" UNIQUE("release_id","artifact_path"),
	CONSTRAINT "release_artifacts_path_check" CHECK (char_length("release_artifacts"."artifact_path") BETWEEN 1 AND 1024),
	CONSTRAINT "release_artifacts_storage_key_check" CHECK (char_length("release_artifacts"."storage_key") BETWEEN 1 AND 1024),
	CONSTRAINT "release_artifacts_content_hash_check" CHECK ("release_artifacts"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "release_artifacts_size_check" CHECK ("release_artifacts"."size_bytes" >= 0),
	CONSTRAINT "release_artifacts_type_check" CHECK ("release_artifacts"."artifact_type" IN ('source_map','minified_asset'))
);
--> statement-breakpoint
CREATE TABLE "releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"version" text NOT NULL,
	"commit_sha" text,
	"repository_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "releases_project_version_unique" UNIQUE("project_id","version"),
	CONSTRAINT "releases_version_check" CHECK (char_length("releases"."version") BETWEEN 1 AND 128 AND "releases"."version" !~ '[[:cntrl:]]'),
	CONSTRAINT "releases_commit_sha_check" CHECK ("releases"."commit_sha" IS NULL OR "releases"."commit_sha" ~ '^[0-9a-fA-F]{7,64}$'),
	CONSTRAINT "releases_repository_url_check" CHECK ("releases"."repository_url" IS NULL OR (char_length("releases"."repository_url") <= 2048 AND "releases"."repository_url" ~ '^https?://[^[:space:][:cntrl:]]+$'))
);
--> statement-breakpoint
ALTER TABLE "release_artifacts" ADD CONSTRAINT "release_artifacts_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "release_artifacts_release_idx" ON "release_artifacts" USING btree ("release_id");--> statement-breakpoint
CREATE INDEX "release_artifacts_release_hash_idx" ON "release_artifacts" USING btree ("release_id","content_hash");--> statement-breakpoint
CREATE INDEX "releases_project_created_idx" ON "releases" USING btree ("project_id","created_at");