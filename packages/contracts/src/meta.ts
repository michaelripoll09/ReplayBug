import { z } from "zod";

/** Versioned service metadata exposed at GET /api/v1/meta. */
export const apiMetaSchema = z.object({
  service: z.literal("api"),
  version: z.string().min(1),
  environment: z.string().min(1),
});

export type ApiMeta = z.infer<typeof apiMetaSchema>;
