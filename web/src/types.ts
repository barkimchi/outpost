/**
 * Trainer HTTP API request/response types now live in `shared/src/api.ts` (docs/SPEC.md
 * section 4). This file used to hand-transcribe them here because Task 4 could not touch
 * `shared/**`; that constraint lifted for this task, and the review finding was blunt about
 * the cost: nothing kept the hand copy honest, so the server could rename a field and
 * typecheck would stay green here regardless. This file is now a thin re-export so every
 * existing `from '../types.js'` import site keeps working unchanged.
 */
export * from '@gym/shared';
