CREATE TABLE "ai_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"event_id" uuid,
	"model" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"summary" text,
	"suspected_cause" text,
	"evidence_json" jsonb,
	"reproduction_steps_json" jsonb,
	"limitations_json" jsonb,
	"error_code" text,
	"error_message" text,
	"requested_by_user_id" text,
	"analysis_version" text NOT NULL,
	"idempotency_key_hash" text NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_analyses_idempotency_unique" UNIQUE("requested_by_user_id","event_id","analysis_version","model","idempotency_key_hash"),
	CONSTRAINT "ai_analyses_status_check" CHECK ("ai_analyses"."status" IN ('pending','ready','failed')),
	CONSTRAINT "ai_analyses_model_check" CHECK (char_length("ai_analyses"."model") BETWEEN 1 AND 256 AND "ai_analyses"."model" !~ '[[:cntrl:]]'),
	CONSTRAINT "ai_analyses_version_check" CHECK (char_length("ai_analyses"."analysis_version") BETWEEN 1 AND 32 AND "ai_analyses"."analysis_version" !~ '[[:cntrl:]]'),
	CONSTRAINT "ai_analyses_idempotency_hash_check" CHECK ("ai_analyses"."idempotency_key_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ai_analyses_result_bounds_check" CHECK (("ai_analyses"."summary" IS NULL OR char_length("ai_analyses"."summary") BETWEEN 1 AND 4000) AND ("ai_analyses"."suspected_cause" IS NULL OR char_length("ai_analyses"."suspected_cause") BETWEEN 1 AND 4000) AND ("ai_analyses"."error_code" IS NULL OR "ai_analyses"."error_code" ~ '^[A-Z][A-Z0-9_]{0,63}$') AND ("ai_analyses"."error_message" IS NULL OR char_length("ai_analyses"."error_message") BETWEEN 1 AND 1000)),
	CONSTRAINT "ai_analyses_lifecycle_check" CHECK (("ai_analyses"."status" = 'pending' AND "ai_analyses"."summary" IS NULL AND "ai_analyses"."suspected_cause" IS NULL AND "ai_analyses"."evidence_json" IS NULL AND "ai_analyses"."reproduction_steps_json" IS NULL AND "ai_analyses"."limitations_json" IS NULL AND "ai_analyses"."error_code" IS NULL AND "ai_analyses"."error_message" IS NULL AND "ai_analyses"."completed_at" IS NULL) OR ("ai_analyses"."status" = 'ready' AND "ai_analyses"."summary" IS NOT NULL AND "ai_analyses"."suspected_cause" IS NOT NULL AND "ai_analyses"."evidence_json" IS NOT NULL AND "ai_analyses"."reproduction_steps_json" IS NOT NULL AND "ai_analyses"."limitations_json" IS NOT NULL AND "ai_analyses"."error_code" IS NULL AND "ai_analyses"."error_message" IS NULL AND "ai_analyses"."completed_at" IS NOT NULL) OR ("ai_analyses"."status" = 'failed' AND "ai_analyses"."summary" IS NULL AND "ai_analyses"."suspected_cause" IS NULL AND "ai_analyses"."evidence_json" IS NULL AND "ai_analyses"."reproduction_steps_json" IS NULL AND "ai_analyses"."limitations_json" IS NULL AND "ai_analyses"."error_code" IS NOT NULL AND "ai_analyses"."error_message" IS NOT NULL AND "ai_analyses"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "ai_analysis_outbox" (
	"analysis_id" uuid PRIMARY KEY NOT NULL,
	"dispatched_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_analysis_outbox_attempt_count_check" CHECK ("ai_analysis_outbox"."attempt_count" >= 0),
	CONSTRAINT "ai_analysis_outbox_last_error_check" CHECK ("ai_analysis_outbox"."last_error" IS NULL OR (char_length("ai_analysis_outbox"."last_error") BETWEEN 1 AND 1000 AND "ai_analysis_outbox"."last_error" !~ '[[:cntrl:]]'))
);
--> statement-breakpoint
ALTER TABLE "ai_analyses" ADD CONSTRAINT "ai_analyses_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ai_analyses" ADD CONSTRAINT "ai_analyses_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ai_analyses" ADD CONSTRAINT "ai_analyses_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ai_analysis_outbox" ADD CONSTRAINT "ai_analysis_outbox_analysis_id_ai_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."ai_analyses"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "ai_analyses_issue_created_idx" ON "ai_analyses" USING btree ("issue_id","created_at");
--> statement-breakpoint
CREATE INDEX "ai_analyses_event_created_idx" ON "ai_analyses" USING btree ("event_id","created_at");
--> statement-breakpoint
CREATE INDEX "ai_analyses_pending_created_idx" ON "ai_analyses" USING btree ("status","created_at");
--> statement-breakpoint
CREATE INDEX "ai_analysis_outbox_dispatched_idx" ON "ai_analysis_outbox" USING btree ("dispatched_at");
--> statement-breakpoint
CREATE INDEX "ai_analysis_outbox_pending_created_idx" ON "ai_analysis_outbox" USING btree ("dispatched_at","created_at");
