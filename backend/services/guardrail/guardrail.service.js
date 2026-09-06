/**
 * Guardrail Service (Adapter / Facade for Policy Engine)
 * Phase 5 - Step 1: Formal Policy Engine
 *
 * Delegates all evaluations to the deterministic PolicyEngine.
 */

import { evaluatePolicy } from '../policy/policy.engine.js';

export class GuardrailService {
  /**
   * Evaluates the recommended action against business policies and state invariants
   * via the centralized Policy Engine.
   */
  static evaluate(context) {
    return evaluatePolicy(context);
  }
}
