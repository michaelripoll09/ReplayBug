import { and, asc, desc, eq, isNull, lte, sql, type SQL } from "drizzle-orm";
import { aiAnalyses, aiAnalysisOutbox } from "../schema.js";
import type { DbOrTx, DbTransaction } from "./db-types.js";

export type AiAnalysisRow = typeof aiAnalyses.$inferSelect;
export type AiAnalysisOutboxRow = typeof aiAnalysisOutbox.$inferSelect;

/** Validated by the contract boundary before a worker asks for persistence. */
export interface AiAnalysisOutput {
  summary: string;
  suspectedCause: string;
  evidence: Array<{ ref: string; reason: string }>;
  reproductionSteps: string[];
  limitations: string[];
}

const IDEMPOTENCY_HASH_PATTERN = /^[0-9a-f]{64}$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_OUTBOX_ERROR_LENGTH = 1_000;

export interface CreateAiAnalysisRequestInput {
  issueId: string;
  eventId: string | null;
  requestedByUserId: string | null;
  model: string;
  analysisVersion: string;
  /** SHA-256 hex only; plaintext idempotency keys have no repository API. */
  idempotencyKeyHash: string;
}

export interface CreateAiAnalysisRequestResult {
  row: AiAnalysisRow;
  created: boolean;
}

function validateIdempotencyHash(value: string): void {
  if (!IDEMPOTENCY_HASH_PATTERN.test(value)) {
    throw new Error("idempotencyKeyHash must be a lowercase SHA-256 hex hash");
  }
}

function assertAiAnalysisOutput(value: AiAnalysisOutput): void {
  const textWithin = (text: string, maximum: number): boolean =>
    text.length > 0 && text.length <= maximum;
  if (
    !textWithin(value.summary, 4_000) ||
    !textWithin(value.suspectedCause, 4_000) ||
    value.evidence.length === 0 ||
    value.evidence.length > 20 ||
    value.reproductionSteps.length === 0 ||
    value.reproductionSteps.length > 10 ||
    value.limitations.length > 10 ||
    value.evidence.some(
      (evidence) =>
        !textWithin(evidence.ref, 128) || !textWithin(evidence.reason, 2_000),
    ) ||
    value.reproductionSteps.some((step) => !textWithin(step, 1_000)) ||
    value.limitations.some((limitation) => !textWithin(limitation, 1_000))
  ) {
    throw new Error("invalid validated AI analysis output");
  }
}

/**
 * Flags C0 control characters and DEL, mirroring the database's
 * `[[:cntrl:]]` check without a control-character regular expression.
 */
function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function assertOutboxError(value: string): void {
  if (
    value.length === 0 ||
    value.length > MAX_OUTBOX_ERROR_LENGTH ||
    containsControlCharacter(value)
  ) {
    throw new Error(
      "sanitized outbox error must be 1-1000 printable characters",
    );
  }
}

async function findIdempotentAiAnalysis(
  tx: DbTransaction,
  input: CreateAiAnalysisRequestInput,
): Promise<AiAnalysisRow | undefined> {
  if (input.eventId === null || input.requestedByUserId === null) {
    return undefined;
  }
  const rows = await tx
    .select()
    .from(aiAnalyses)
    .where(
      and(
        eq(aiAnalyses.requestedByUserId, input.requestedByUserId),
        eq(aiAnalyses.eventId, input.eventId),
        eq(aiAnalyses.analysisVersion, input.analysisVersion),
        eq(aiAnalyses.model, input.model),
        eq(aiAnalyses.idempotencyKeyHash, input.idempotencyKeyHash),
      ),
    )
    .orderBy(asc(aiAnalyses.createdAt), asc(aiAnalyses.id))
    .limit(1);
  return rows[0];
}

/**
 * Creates a pending analysis and its stable outbox record in one transaction.
 * The SQL uniqueness tuple applies only while requester/event are non-null;
 * once retention or user deletion nulls either FK, historical rows are not
 * accidentally treated as retries of later requests.
 */
export async function createAiAnalysisRequest(
  db: DbOrTx,
  input: CreateAiAnalysisRequestInput,
): Promise<CreateAiAnalysisRequestResult> {
  validateIdempotencyHash(input.idempotencyKeyHash);
  const create = async (
    tx: DbTransaction,
  ): Promise<CreateAiAnalysisRequestResult> => {
    const rows = await tx
      .insert(aiAnalyses)
      .values({
        issueId: input.issueId,
        eventId: input.eventId,
        requestedByUserId: input.requestedByUserId,
        model: input.model,
        analysisVersion: input.analysisVersion,
        idempotencyKeyHash: input.idempotencyKeyHash,
        status: "pending",
        summary: null,
        suspectedCause: null,
        evidenceJson: null,
        reproductionStepsJson: null,
        limitationsJson: null,
        errorCode: null,
        errorMessage: null,
        completedAt: null,
      })
      .onConflictDoNothing({
        target: [
          aiAnalyses.requestedByUserId,
          aiAnalyses.eventId,
          aiAnalyses.analysisVersion,
          aiAnalyses.model,
          aiAnalyses.idempotencyKeyHash,
        ],
      })
      .returning();
    const inserted = rows[0];
    if (inserted !== undefined) {
      await tx.insert(aiAnalysisOutbox).values({
        analysisId: inserted.id,
        dispatchedAt: null,
        attemptCount: 0,
        lastError: null,
      });
      return { row: inserted, created: true };
    }
    const existing = await findIdempotentAiAnalysis(tx, input);
    if (existing === undefined) {
      throw new Error("AI analysis idempotency conflict could not be resolved");
    }
    return { row: existing, created: false };
  };

  if ("transaction" in db) {
    return db.transaction(create);
  }
  return create(db);
}

/** Reads one analysis by id (no lock) for the worker's terminal precheck. */
export async function findAiAnalysisById(
  db: DbOrTx,
  analysisId: string,
): Promise<AiAnalysisRow | undefined> {
  const rows = await db
    .select()
    .from(aiAnalyses)
    .where(eq(aiAnalyses.id, analysisId))
    .limit(1);
  return rows[0];
}

export async function findAiAnalysisByIdInIssue(
  db: DbOrTx,
  issueId: string,
  analysisId: string,
): Promise<AiAnalysisRow | undefined> {
  const rows = await db
    .select()
    .from(aiAnalyses)
    .where(and(eq(aiAnalyses.id, analysisId), eq(aiAnalyses.issueId, issueId)))
    .limit(1);
  return rows[0];
}

export interface AiAnalysisCursor {
  createdAt: string;
  id: string;
}

export interface ListIssueAiAnalysesInput {
  issueId: string;
  limit: number;
  cursor?: AiAnalysisCursor;
}

export interface ListIssueAiAnalysesResult {
  rows: AiAnalysisRow[];
  nextCursor: string | null;
}

const AI_ANALYSIS_CURSOR_VERSION = 1;

export function encodeAiAnalysisCursor(createdAt: string, id: string): string {
  return Buffer.from(
    JSON.stringify({ v: AI_ANALYSIS_CURSOR_VERSION, createdAt, id }),
    "utf8",
  ).toString("base64url");
}

export function decodeAiAnalysisCursor(raw: string): AiAnalysisCursor | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (
      record["v"] !== AI_ANALYSIS_CURSOR_VERSION ||
      typeof record["createdAt"] !== "string" ||
      Number.isNaN(Date.parse(record["createdAt"])) ||
      typeof record["id"] !== "string"
    ) {
      return null;
    }
    return { createdAt: record["createdAt"], id: record["id"] };
  } catch {
    return null;
  }
}

/** Lists one issue's immutable history newest-first with stable keyset paging. */
export async function listIssueAiAnalyses(
  db: DbOrTx,
  input: ListIssueAiAnalysesInput,
): Promise<ListIssueAiAnalysesResult> {
  const conditions: SQL[] = [eq(aiAnalyses.issueId, input.issueId)];
  if (input.cursor !== undefined) {
    conditions.push(sql`(
      ${aiAnalyses.createdAt} < ${input.cursor.createdAt}
      OR (${aiAnalyses.createdAt} = ${input.cursor.createdAt}
          AND ${aiAnalyses.id} > ${input.cursor.id})
    )`);
  }
  const rows = await db
    .select()
    .from(aiAnalyses)
    .where(and(...conditions))
    .orderBy(desc(aiAnalyses.createdAt), asc(aiAnalyses.id))
    .limit(input.limit + 1);
  let nextCursor: string | null = null;
  let page = rows;
  if (rows.length > input.limit) {
    const last = rows[input.limit - 1];
    if (last !== undefined) {
      const createdAt =
        last.createdAt instanceof Date
          ? last.createdAt.toISOString()
          : new Date(last.createdAt).toISOString();
      nextCursor = encodeAiAnalysisCursor(createdAt, last.id);
    }
    page = rows.slice(0, input.limit);
  }
  return { rows: page, nextCursor };
}

export async function findPendingAiAnalysisById(
  db: DbOrTx,
  analysisId: string,
): Promise<AiAnalysisRow | undefined> {
  const rows = await db
    .select()
    .from(aiAnalyses)
    .where(and(eq(aiAnalyses.id, analysisId), eq(aiAnalyses.status, "pending")))
    .limit(1);
  return rows[0];
}

/** Locks one pending row so workers serialize terminal transitions. */
export async function lockPendingAiAnalysisById(
  tx: DbTransaction,
  analysisId: string,
): Promise<AiAnalysisRow | undefined> {
  const rows = await tx
    .select()
    .from(aiAnalyses)
    .where(and(eq(aiAnalyses.id, analysisId), eq(aiAnalyses.status, "pending")))
    .limit(1)
    .for("update");
  return rows[0];
}

/** Ready and failed records are immutable: only pending rows can transition. */
export async function markAiAnalysisReady(
  tx: DbTransaction,
  analysisId: string,
  result: AiAnalysisOutput,
): Promise<AiAnalysisRow | undefined> {
  assertAiAnalysisOutput(result);
  const validated = result;
  const rows = await tx
    .update(aiAnalyses)
    .set({
      status: "ready",
      summary: validated.summary,
      suspectedCause: validated.suspectedCause,
      evidenceJson: validated.evidence,
      reproductionStepsJson: validated.reproductionSteps,
      limitationsJson: validated.limitations,
      errorCode: null,
      errorMessage: null,
      completedAt: new Date(),
    })
    .where(and(eq(aiAnalyses.id, analysisId), eq(aiAnalyses.status, "pending")))
    .returning();
  return rows[0];
}

export interface MarkAiAnalysisFailedInput {
  errorCode: string;
  errorMessage: string;
}

export async function markAiAnalysisFailed(
  tx: DbTransaction,
  analysisId: string,
  input: MarkAiAnalysisFailedInput,
): Promise<AiAnalysisRow | undefined> {
  if (
    !ERROR_CODE_PATTERN.test(input.errorCode) ||
    input.errorMessage.length === 0 ||
    input.errorMessage.length > MAX_OUTBOX_ERROR_LENGTH
  ) {
    throw new Error("invalid AI analysis failure diagnostics");
  }
  const rows = await tx
    .update(aiAnalyses)
    .set({
      status: "failed",
      summary: null,
      suspectedCause: null,
      evidenceJson: null,
      reproductionStepsJson: null,
      limitationsJson: null,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      completedAt: new Date(),
    })
    .where(and(eq(aiAnalyses.id, analysisId), eq(aiAnalyses.status, "pending")))
    .returning();
  return rows[0];
}

export interface PendingAiAnalysisOutboxItem {
  analysisId: string;
  attemptCount: number;
  createdAt: Date;
}

const pendingOutboxColumns = {
  analysisId: aiAnalysisOutbox.analysisId,
  attemptCount: aiAnalysisOutbox.attemptCount,
  createdAt: aiAnalysisOutbox.createdAt,
};

export async function claimPendingAiAnalysisOutboxBatch(
  tx: DbTransaction,
  limit: number,
): Promise<PendingAiAnalysisOutboxItem[]> {
  return tx
    .select(pendingOutboxColumns)
    .from(aiAnalysisOutbox)
    .where(isNull(aiAnalysisOutbox.dispatchedAt))
    .orderBy(asc(aiAnalysisOutbox.createdAt), asc(aiAnalysisOutbox.analysisId))
    .limit(limit)
    .for("update", { skipLocked: true });
}

export async function claimStaleAiAnalysisOutboxBatch(
  tx: DbTransaction,
  staleBefore: Date,
  limit: number,
): Promise<PendingAiAnalysisOutboxItem[]> {
  return tx
    .select(pendingOutboxColumns)
    .from(aiAnalysisOutbox)
    .where(
      and(
        isNull(aiAnalysisOutbox.dispatchedAt),
        lte(aiAnalysisOutbox.createdAt, staleBefore),
      ),
    )
    .orderBy(asc(aiAnalysisOutbox.createdAt), asc(aiAnalysisOutbox.analysisId))
    .limit(limit)
    .for("update", { skipLocked: true });
}

export async function listStaleAiAnalysisOutbox(
  db: DbOrTx,
  staleBefore: Date,
  limit: number,
): Promise<PendingAiAnalysisOutboxItem[]> {
  return db
    .select(pendingOutboxColumns)
    .from(aiAnalysisOutbox)
    .where(
      and(
        isNull(aiAnalysisOutbox.dispatchedAt),
        lte(aiAnalysisOutbox.createdAt, staleBefore),
      ),
    )
    .orderBy(asc(aiAnalysisOutbox.createdAt), asc(aiAnalysisOutbox.analysisId))
    .limit(limit);
}

export async function markAiAnalysisOutboxDispatched(
  tx: DbTransaction,
  analysisId: string,
): Promise<void> {
  await tx
    .update(aiAnalysisOutbox)
    .set({ dispatchedAt: sql`now()`, lastError: null })
    .where(eq(aiAnalysisOutbox.analysisId, analysisId));
}

export async function recordAiAnalysisOutboxFailure(
  tx: DbTransaction,
  analysisId: string,
  sanitizedError: string,
): Promise<void> {
  assertOutboxError(sanitizedError);
  await tx
    .update(aiAnalysisOutbox)
    .set({
      attemptCount: sql`${aiAnalysisOutbox.attemptCount} + 1`,
      lastError: sanitizedError,
    })
    .where(eq(aiAnalysisOutbox.analysisId, analysisId));
}
