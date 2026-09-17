import { z } from "zod";

/** Liveness probe response. Never touches the database. */
export const liveHealthSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("api"),
});

export type LiveHealth = z.infer<typeof liveHealthSchema>;

/** Readiness probe response with a database check summary. */
export const readyHealthSchema = z.object({
  status: z.enum(["ready", "not-ready"]),
  checks: z.object({
    database: z.enum(["up", "down"]),
  }),
});

export type ReadyHealth = z.infer<typeof readyHealthSchema>;
