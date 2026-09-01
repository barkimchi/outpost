import type { ScenarioDef } from '@gym/shared';
import { t1Scenarios } from './t1-warmups.js';
import { t2Scenarios } from './t2-github.js';

/**
 * Ordered scenario registry (docs/SPEC.md section 4: "index.ts # registry (ordered)").
 * Order matches the curriculum in docs/SPEC.md section 12. Later tasks append their own
 * tier's scenarios here (t3-google, t4-glean, t5-slack, t6-capstone, impl-track), never
 * reordering what already exists.
 */
export const scenarioRegistry: ScenarioDef[] = [...t1Scenarios, ...t2Scenarios];
