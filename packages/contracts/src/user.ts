import { z } from "zod";

/** Minimal authenticated user summary. Never includes hashes or tokens. */
export const userSummarySchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  name: z.string().min(1),
  image: z.string().nullable().optional(),
  emailVerified: z.boolean(),
});

export type UserSummary = z.infer<typeof userSummarySchema>;
