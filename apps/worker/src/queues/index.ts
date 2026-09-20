import {
  PROCESS_EVENT_JOB_VERSION,
  PROCESS_EVENT_QUEUE,
} from "./process-event.js";
import {
  GENERATE_REPRODUCTION_JOB_VERSION,
  GENERATE_REPRODUCTION_QUEUE,
} from "./reproduction.js";
import {
  GENERATE_AI_ANALYSIS_JOB_VERSION,
  GENERATE_AI_ANALYSIS_QUEUE,
} from "./ai-analysis.js";

/**
 * Registry of the job contracts this worker consumes. Scope is explicit:
 * jobs are added intentionally by the block that owns them — never
 * incidentally. The worker composition root must create and consume every
 * queue listed here.
 */
export interface JobContractSummary {
  name: string;
  version: number;
}

export function listRegisteredJobContracts(): JobContractSummary[] {
  return [
    { name: PROCESS_EVENT_QUEUE, version: PROCESS_EVENT_JOB_VERSION },
    {
      name: GENERATE_REPRODUCTION_QUEUE,
      version: GENERATE_REPRODUCTION_JOB_VERSION,
    },
    {
      name: GENERATE_AI_ANALYSIS_QUEUE,
      version: GENERATE_AI_ANALYSIS_JOB_VERSION,
    },
  ];
}
