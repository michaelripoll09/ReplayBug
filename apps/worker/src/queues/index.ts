import {
  PROCESS_EVENT_JOB_VERSION,
  PROCESS_EVENT_QUEUE,
} from "./process-event.js";

/**
 * Registry of the job contracts this worker consumes. One queue exists in
 * this block on purpose: pg-boss makes adding queues cheap, but scope is
 * explicit, so future jobs (retention, reproduction, AI analysis) are added
 * by later blocks — never incidentally.
 */
export interface JobContractSummary {
  name: string;
  version: number;
}

export function listRegisteredJobContracts(): JobContractSummary[] {
  return [{ name: PROCESS_EVENT_QUEUE, version: PROCESS_EVENT_JOB_VERSION }];
}
