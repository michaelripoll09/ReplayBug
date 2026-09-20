import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbClient } from "@replaybug/db";
import { runExpiredInvitationCleanup } from "./invitations.js";
import {
  createWorkerTestDatabase,
  type WorkerTestDatabase,
} from "../test-helpers.js";

interface InvitationState {
  id: string;
  accepted_at: Date | null;
  revoked_at: Date | null;
  expires_at: Date;
}

let testDb: WorkerTestDatabase;
let client: DbClient;
let workspaceId: string;
let userId: string;

beforeAll(async () => {
  testDb = await createWorkerTestDatabase();
  client = testDb.client;
  workspaceId = randomUUID();
  userId = `worker-invitation-cleanup-${randomUUID()}`;

  await client.pool.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, $2, $3, false, now(), now())`,
    [userId, "Invitation Cleanup Test User", `${userId}@example.com`],
  );
  await client.pool.query(
    `INSERT INTO workspaces (id, name, slug, created_by_user_id)
     VALUES ($1, $2, $3, $4)`,
    [
      workspaceId,
      "Invitation Cleanup Test Workspace",
      `cleanup-${randomUUID()}`,
      userId,
    ],
  );
});

afterAll(async () => {
  await testDb.drop();
});

async function insertInvitation(input: {
  email: string;
  expiresAt: Date;
  acceptedAt?: Date;
  revokedAt?: Date;
}): Promise<string> {
  const id = randomUUID();
  const tokenHash = randomBytes(32).toString("hex");
  const createdAt = new Date(input.expiresAt.getTime() - 60_000);

  await client.pool.query(
    `INSERT INTO workspace_invitations
       (id, workspace_id, email, role, token_hash, token_prefix,
        expires_at, accepted_at, revoked_at, created_by_user_id, created_at)
     VALUES ($1, $2, $3, 'member', $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      workspaceId,
      input.email,
      tokenHash,
      tokenHash.slice(0, 8),
      input.expiresAt,
      input.acceptedAt ?? null,
      input.revokedAt ?? null,
      userId,
      createdAt,
    ],
  );
  return id;
}

async function readInvitationStates(
  ids: readonly string[],
): Promise<InvitationState[]> {
  const result = await client.pool.query(
    `SELECT id, accepted_at, revoked_at, expires_at
     FROM workspace_invitations
     WHERE id = ANY($1::uuid[])
     ORDER BY expires_at, id`,
    [ids],
  );
  return result.rows as InvitationState[];
}

describe("expired invitation cleanup with real PostgreSQL", () => {
  it("retires only expired pending rows in bounded, repeat-safe batches", async () => {
    const now = new Date("2026-09-20T12:00:00.000Z");
    const acceptedAt = new Date("2026-09-19T12:00:00.000Z");
    const revokedAt = new Date("2026-09-19T13:00:00.000Z");

    const expiredIds = [
      await insertInvitation({
        email: "expired-oldest@example.com",
        expiresAt: new Date("2026-09-17T12:00:00.000Z"),
      }),
      await insertInvitation({
        email: "expired-middle@example.com",
        expiresAt: new Date("2026-09-18T12:00:00.000Z"),
      }),
      await insertInvitation({
        email: "expired-newest@example.com",
        expiresAt: new Date("2026-09-19T12:00:00.000Z"),
      }),
    ];
    const futureId = await insertInvitation({
      email: "future@example.com",
      expiresAt: new Date("2026-09-21T12:00:00.000Z"),
    });
    const acceptedId = await insertInvitation({
      email: "accepted@example.com",
      expiresAt: new Date("2026-09-18T12:00:00.000Z"),
      acceptedAt,
    });
    const revokedId = await insertInvitation({
      email: "revoked@example.com",
      expiresAt: new Date("2026-09-18T12:00:00.000Z"),
      revokedAt,
    });

    const allIds = [...expiredIds, futureId, acceptedId, revokedId];
    const first = await runExpiredInvitationCleanup({
      db: client.db,
      batchSize: 2,
      now,
    });

    expect(first.count).toBe(2);
    expect(first.retired).toHaveLength(2);
    expect(first.retired.map((row) => row.id)).toEqual(expiredIds.slice(0, 2));

    const afterFirst = await readInvitationStates(allIds);
    const afterFirstById = new Map(afterFirst.map((row) => [row.id, row]));
    expect(afterFirstById.get(expiredIds[0]!)?.revoked_at).toEqual(now);
    expect(afterFirstById.get(expiredIds[1]!)?.revoked_at).toEqual(now);
    expect(afterFirstById.get(expiredIds[2]!)?.revoked_at).toBeNull();
    expect(afterFirstById.get(futureId)?.revoked_at).toBeNull();
    expect(afterFirstById.get(acceptedId)?.accepted_at).toEqual(acceptedAt);
    expect(afterFirstById.get(acceptedId)?.revoked_at).toBeNull();
    expect(afterFirstById.get(revokedId)?.revoked_at).toEqual(revokedAt);

    const second = await runExpiredInvitationCleanup({
      db: client.db,
      batchSize: 2,
      now,
    });
    expect(second.count).toBe(1);
    expect(second.retired.map((row) => row.id)).toEqual([expiredIds[2]!]);

    const repeat = await runExpiredInvitationCleanup({
      db: client.db,
      batchSize: 2,
      now,
    });
    expect(repeat).toEqual({ retired: [], count: 0 });

    const finalStates = await readInvitationStates(allIds);
    const finalById = new Map(finalStates.map((row) => [row.id, row]));
    for (const id of expiredIds) {
      expect(finalById.get(id)?.revoked_at).toEqual(now);
    }
    expect(finalById.get(futureId)?.revoked_at).toBeNull();
    expect(finalById.get(acceptedId)?.accepted_at).toEqual(acceptedAt);
    expect(finalById.get(acceptedId)?.revoked_at).toBeNull();
    expect(finalById.get(revokedId)?.revoked_at).toEqual(revokedAt);
  }, 90_000);
});
