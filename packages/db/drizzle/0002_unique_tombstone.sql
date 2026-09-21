CREATE TABLE "issue_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"actor_user_id" text,
	"type" text NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_activity_type_check" CHECK ("issue_activity"."type" IN ('created','assigned','unassigned','status_changed','comment_added','regression_detected','reproduction_generated','ai_analysis_requested','ai_analysis_completed','ai_analysis_failed'))
);
--> statement-breakpoint
CREATE TABLE "issue_affected_sessions" (
	"issue_id" uuid NOT NULL,
	"telemetry_session_id" uuid NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_affected_sessions_pk" PRIMARY KEY("issue_id","telemetry_session_id")
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"fingerprint_signature" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"normalized_message" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"severity" text NOT NULL,
	"assigned_to_user_id" text,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"first_release" text,
	"last_release" text,
	"occurrence_count" integer DEFAULT 0 NOT NULL,
	"affected_session_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issues_project_fingerprint_unique" UNIQUE("project_id","fingerprint"),
	CONSTRAINT "issues_status_check" CHECK ("issues"."status" IN ('open','investigating','resolved','ignored')),
	CONSTRAINT "issues_severity_check" CHECK ("issues"."severity" IN ('error','warning')),
	CONSTRAINT "issues_type_check" CHECK ("issues"."type" IN ('exception','unhandled_rejection','console_error','network','message')),
	CONSTRAINT "issues_fingerprint_check" CHECK ("issues"."fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "issues_occurrence_count_check" CHECK ("issues"."occurrence_count" >= 0),
	CONSTRAINT "issues_affected_session_count_check" CHECK ("issues"."affected_session_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid,
	"issue_id" uuid,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_type_check" CHECK ("notifications"."type" IN ('issue_assigned','issue_comment_mention','issue_regression','reproduction_failed','ai_analysis_completed','ai_analysis_failed'))
);
--> statement-breakpoint
ALTER TABLE "event_processing_outbox" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "fingerprint" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "issue_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_activity" ADD CONSTRAINT "issue_activity_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_activity" ADD CONSTRAINT "issue_activity_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_affected_sessions" ADD CONSTRAINT "issue_affected_sessions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_affected_sessions" ADD CONSTRAINT "issue_affected_sessions_telemetry_session_id_telemetry_sessions_id_fk" FOREIGN KEY ("telemetry_session_id") REFERENCES "public"."telemetry_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_assigned_to_user_id_user_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_activity_issue_created_idx" ON "issue_activity" USING btree ("issue_id","created_at");--> statement-breakpoint
CREATE INDEX "issue_affected_sessions_issue_idx" ON "issue_affected_sessions" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issues_project_status_last_seen_idx" ON "issues" USING btree ("project_id","status","last_seen_at");--> statement-breakpoint
CREATE INDEX "issues_project_last_seen_idx" ON "issues" USING btree ("project_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "issues_assigned_to_idx" ON "issues" USING btree ("assigned_to_user_id");--> statement-breakpoint
CREATE INDEX "notifications_user_read_created_idx" ON "notifications" USING btree ("user_id","read_at","created_at");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_processing_outbox_pending_created_idx" ON "event_processing_outbox" USING btree ("dispatched_at","created_at");--> statement-breakpoint
CREATE INDEX "events_issue_occurred_idx" ON "events" USING btree ("issue_id","occurred_at");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_fingerprint_check" CHECK ("events"."fingerprint" IS NULL OR "events"."fingerprint" ~ '^[0-9a-f]{64}$');