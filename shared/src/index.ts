/**
 * Re-export barrel for @gym/shared.
 *
 * Later tasks add the remaining files here, per spec section 4:
 *   - scenario.ts: RunContext, ScenarioDef, Step, Fault, Assertion, RequestMatcher (Task 2).
 *   - api.ts: trainer HTTP request/response types (Task 1 scope, not yet needed by any
 *     consumer; deferred until a task actually reads/writes one of those shapes rather
 *     than adding speculative types no one imports).
 * Each new file gets an `export * from './file.js'` line added here.
 */
export * from './events.js';
