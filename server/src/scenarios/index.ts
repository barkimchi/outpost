import type { ScenarioDef } from '@gym/shared';
import { t1Scenarios } from './t1-warmups.js';
import { t2Scenarios } from './t2-github.js';
import { t3Scenarios } from './t3-google.js';
import { t4Scenarios } from './t4-glean.js';
import { t5Scenarios } from './t5-slack.js';
import { t6Scenarios } from './t6-capstone.js';
import { implScenarios } from './impl-track.js';

/**
 * Ordered scenario registry (docs/SPEC.md section 4: "index.ts # registry (ordered)").
 * Order matches the curriculum in docs/SPEC.md section 12: tiers 1-6 (troubleshoot track),
 * then the implementation track last, never reordering what already exists.
 */
export const scenarioRegistry: ScenarioDef[] = [
  ...t1Scenarios,
  ...t2Scenarios,
  ...t3Scenarios,
  ...t4Scenarios,
  ...t5Scenarios,
  ...t6Scenarios,
  ...implScenarios,
];
