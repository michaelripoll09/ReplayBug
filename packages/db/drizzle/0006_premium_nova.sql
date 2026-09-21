CREATE TABLE "reproduction_generation_outbox" (
	"reproduction_id" uuid PRIMARY KEY NOT NULL,
	"dispatched_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reproduction_tests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"event_id" uuid,
	"generated_by_user_id" text,
	"language" text DEFAULT 'typescript' NOT NULL,
	"framework" text DEFAULT 'playwright' NOT NULL,
	"code" text,
	"has_redacted_steps" boolean DEFAULT false NOT NULL,
	"generator_version" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_code" text,
	"error_message" text,
	"completed_at" timestamp with time zone,
	"idempotency_key_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reproduction_tests_status_check" CHECK ("reproduction_tests"."status" IN ('pending','ready','failed')),
	CONSTRAINT "reproduction_tests_language_check" CHECK ("reproduction_tests"."language" IN ('typescript')),
	CONSTRAINT "reproduction_tests_framework_check" CHECK ("reproduction_tests"."framework" IN ('playwright')),
	CONSTRAINT "reproduction_tests_error_code_check" CHECK ("reproduction_tests"."error_code" IS NULL OR "reproduction_tests"."error_code" IN ('REPRODUCTION_BASE_URL_REQUIRED','REPRODUCTION_UNSUPPORTED_FAILURE','REPRODUCTION_OUTPUT_TOO_LARGE','REPRODUCTION_INVALID_EVIDENCE','REPRODUCTION_FAILED'))
);
--> statement-breakpoint
ALTER TABLE "reproduction_generation_outbox" ADD CONSTRAINT "reproduction_generation_outbox_reproduction_id_reproduction_tests_id_fk" FOREIGN KEY ("reproduction_id") REFERENCES "public"."reproduction_tests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reproduction_tests" ADD CONSTRAINT "reproduction_tests_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reproduction_tests" ADD CONSTRAINT "reproduction_tests_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reproduction_tests" ADD CONSTRAINT "reproduction_tests_generated_by_user_id_user_id_fk" FOREIGN KEY ("generated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reproduction_generation_outbox_dispatched_idx" ON "reproduction_generation_outbox" USING btree ("dispatched_at");--> statement-breakpoint
CREATE INDEX "reproduction_generation_outbox_pending_created_idx" ON "reproduction_generation_outbox" USING btree ("dispatched_at","created_at");--> statement-breakpoint
CREATE INDEX "reproduction_tests_issue_created_idx" ON "reproduction_tests" USING btree ("issue_id","created_at");--> statement-breakpoint
CREATE INDEX "reproduction_tests_event_created_idx" ON "reproduction_tests" USING btree ("event_id","created_at");--> statement-breakpoint
CREATE INDEX "reproduction_tests_generated_by_created_idx" ON "reproduction_tests" USING btree ("generated_by_user_id","created_at");--> statement-breakpoint
CREATE INDEX "reproduction_tests_status_idx" ON "reproduction_tests" USING btree ("status");