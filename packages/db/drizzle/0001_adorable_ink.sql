CREATE TYPE "public"."processing_state" AS ENUM('pending', 'processed', 'rejected');--> statement-breakpoint
CREATE TABLE "event_processing_outbox" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"dispatched_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"telemetry_session_id" uuid NOT NULL,
	"client_event_id" text NOT NULL,
	"sequence_number" integer NOT NULL,
	"event_type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"environment" text NOT NULL,
	"release" text,
	"page_url" text,
	"payload_json" jsonb NOT NULL,
	"processing_state" "processing_state" DEFAULT 'pending' NOT NULL,
	"rejection_reason" text,
	CONSTRAINT "events_project_client_event_unique" UNIQUE("project_id","client_event_id"),
	CONSTRAINT "events_event_type_check" CHECK ("events"."event_type" IN ('exception','unhandled_rejection','console_error','network','navigation','click','input','message','custom_breadcrumb','sdk')),
	CONSTRAINT "events_processing_state_check" CHECK ("events"."processing_state" IN ('pending','processed','rejected'))
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"project_id" uuid NOT NULL,
	"key_prefix" text NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limit_buckets_project_prefix_bucket_unique" UNIQUE("project_id","key_prefix","bucket_start")
);
--> statement-breakpoint
CREATE TABLE "telemetry_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"sdk_session_id" text NOT NULL,
	"anonymous_user_hash" text,
	"environment" text NOT NULL,
	"release" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"initial_url" text NOT NULL,
	"browser_name" text,
	"browser_version" text,
	"os_name" text,
	"os_version" text,
	"device_type" text,
	"viewport_width" integer,
	"viewport_height" integer,
	"sdk_version" text NOT NULL,
	CONSTRAINT "telemetry_sessions_project_sdk_unique" UNIQUE("project_id","sdk_session_id")
);
--> statement-breakpoint
ALTER TABLE "event_processing_outbox" ADD CONSTRAINT "event_processing_outbox_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_telemetry_session_id_telemetry_sessions_id_fk" FOREIGN KEY ("telemetry_session_id") REFERENCES "public"."telemetry_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_limit_buckets" ADD CONSTRAINT "rate_limit_buckets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telemetry_sessions" ADD CONSTRAINT "telemetry_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_processing_outbox_dispatched_idx" ON "event_processing_outbox" USING btree ("dispatched_at");--> statement-breakpoint
CREATE INDEX "events_project_occurred_idx" ON "events" USING btree ("project_id","occurred_at");--> statement-breakpoint
CREATE INDEX "events_session_sequence_idx" ON "events" USING btree ("telemetry_session_id","sequence_number");--> statement-breakpoint
CREATE INDEX "events_project_state_idx" ON "events" USING btree ("project_id","processing_state");--> statement-breakpoint
CREATE INDEX "rate_limit_buckets_bucket_start_idx" ON "rate_limit_buckets" USING btree ("bucket_start");--> statement-breakpoint
CREATE INDEX "telemetry_sessions_project_last_seen_idx" ON "telemetry_sessions" USING btree ("project_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "telemetry_sessions_project_started_idx" ON "telemetry_sessions" USING btree ("project_id","started_at");