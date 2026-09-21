WITH ranked_reproductions AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY
        "generated_by_user_id",
        "event_id",
        "generator_version",
        "idempotency_key_hash"
      ORDER BY
        CASE
          WHEN "status" = 'ready' AND NULLIF(btrim("code"), '') IS NOT NULL
            THEN 0
          ELSE 1
        END,
        "created_at" ASC,
        "id" ASC
    ) AS duplicate_rank
  FROM "reproduction_tests"
  WHERE "generated_by_user_id" IS NOT NULL
    AND "event_id" IS NOT NULL
    AND "idempotency_key_hash" IS NOT NULL
)
DELETE FROM "reproduction_tests" AS reproduction
USING ranked_reproductions AS ranked
WHERE reproduction."id" = ranked."id"
  AND ranked.duplicate_rank > 1;
--> statement-breakpoint
ALTER TABLE "reproduction_tests"
  ADD CONSTRAINT "reproduction_tests_idempotency_unique"
  UNIQUE("generated_by_user_id","event_id","generator_version","idempotency_key_hash");
