import { z } from "zod";

/** Only public_ingest exists this block. Secret tokens are future work. */
export const projectKeyKindSchema = z.enum(["public_ingest", "secret"]);

export type ProjectKeyKind = z.infer<typeof projectKeyKindSchema>;

/** Key metadata: never includes plaintext or hashes. */
export const projectKeyMetaSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  kind: projectKeyKindSchema,
  name: z.string().min(1),
  prefix: z.string().min(1),
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
});

export type ProjectKeyMeta = z.infer<typeof projectKeyMetaSchema>;

/** One-time creation result: full key returned exactly once. */
export const projectKeyCreationSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  kind: projectKeyKindSchema,
  name: z.string().min(1),
  prefix: z.string().min(1),
  key: z.string().min(1),
  createdAt: z.string().datetime(),
});

export type ProjectKeyCreation = z.infer<typeof projectKeyCreationSchema>;
