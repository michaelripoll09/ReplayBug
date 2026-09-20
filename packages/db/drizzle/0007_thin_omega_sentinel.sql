CREATE TABLE "artifact_deletion_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"storage_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "artifact_deletion_outbox_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "artifact_deletion_outbox_storage_key_check" CHECK (char_length("artifact_deletion_outbox"."storage_key") BETWEEN 1 AND 1024 AND "artifact_deletion_outbox"."storage_key" !~ '[[:cntrl:]]'),
	CONSTRAINT "artifact_deletion_outbox_attempt_count_check" CHECK ("artifact_deletion_outbox"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "workspace_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "workspace_invitations_email_check" CHECK (char_length("workspace_invitations"."email") BETWEEN 3 AND 320 AND "workspace_invitations"."email" = lower(btrim("workspace_invitations"."email")) AND "workspace_invitations"."email" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
	CONSTRAINT "workspace_invitations_role_check" CHECK ("workspace_invitations"."role" IN ('admin','member','viewer')),
	CONSTRAINT "workspace_invitations_token_hash_check" CHECK ("workspace_invitations"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workspace_invitations_token_prefix_check" CHECK ("workspace_invitations"."token_prefix" ~ '^[0-9a-f]{8}$'),
	CONSTRAINT "workspace_invitations_expiry_check" CHECK ("workspace_invitations"."expires_at" > "workspace_invitations"."created_at")
);
--> statement-breakpoint
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_action_check";--> statement-breakpoint
ALTER TABLE "artifact_deletion_outbox" ADD CONSTRAINT "artifact_deletion_outbox_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_deletion_outbox_pending_created_idx" ON "artifact_deletion_outbox" USING btree ("completed_at","created_at","id");--> statement-breakpoint
CREATE INDEX "artifact_deletion_outbox_project_created_idx" ON "artifact_deletion_outbox" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_invitations_pending_email_unique" ON "workspace_invitations" USING btree ("workspace_id","email") WHERE "workspace_invitations"."accepted_at" IS NULL AND "workspace_invitations"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "workspace_invitations_workspace_created_idx" ON "workspace_invitations" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "workspace_invitations_token_prefix_idx" ON "workspace_invitations" USING btree ("token_prefix");--> statement-breakpoint
CREATE INDEX "workspace_invitations_workspace_email_status_idx" ON "workspace_invitations" USING btree ("workspace_id","email","accepted_at","revoked_at");--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_action_check" CHECK ("audit_logs"."action" IN ('workspace.created','workspace.updated','workspace.ownership_transferred','workspace.deletion_requested','workspace.deletion_completed','project.created','project.updated','project.deleted','project.retention_changed','project.deletion_requested','project.deletion_completed','workspace_invitation.created','workspace_invitation.revoked','workspace_invitation.accepted','workspace_member.role_changed','workspace_member.removed','project_origin.created','project_origin.updated','project_origin.deleted','project_key.rotated'));