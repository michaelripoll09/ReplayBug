import type { AiAnalysisOutput } from "@replaybug/contracts";

/** Provider boundary deliberately contains only already-sanitized evidence. */
export interface AiAnalysisProviderInput {
  evidenceJson: string;
  allowedRefs: readonly string[];
}

export interface AiAnalysisProvider {
  analyze(input: AiAnalysisProviderInput): Promise<AiAnalysisOutput>;
}
