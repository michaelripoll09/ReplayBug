import {
  PROCESS_EVENT_JOB_VERSION,
  PROCESS_EVENT_QUEUE,
} from "./process-event.js";
import {
  GENERATE_REPRODUCTION_JOB_VERSION,
  GENERATE_REPRODUCTION_QUEUE,
} from "./reproduction.js";

/**
 * Registry of the job contracts this worker consumes. Scope is explicit:
 * new jobs (retention, AI analysis) are added by later blocks — never
 * incidentally.
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
  ];
}
