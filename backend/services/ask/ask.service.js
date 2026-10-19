/**
 * RecoverIQ Backend - Ask RecoverIQ Grounded Explainer Service
 * Phase 7 - Step 6: Ask RecoverIQ
 *
 * Provides grounded, evidence-backed answers to merchant queries regarding
 * recovery cases, decision lineages, policy guardrails, and aggregate telemetry.
 */

import axios from 'axios';
import { config } from '../config/index.js';
import { logger } from '../logger/index.js';
import { resolveScope } from '../auth/tenant-scope.js';
import { ObservabilityService } from '../observability/observability.service.js';
import { withSpan, injectTraceContext } from '../observability/tracing.service.js';

const askLogger = logger.withComponent('ask_recoveriq_service');

export class AskRecoverIQService {
  /**
   * Process a natural language question grounded in recovery audit evidence.
   *
   * @param {Object} params
   * @param {string} params.question The user query
   * @param {string} [params.caseId] Optional case ID filter
   * @param {Object} [options]
   * @returns {Promise<{answer: string, evidence: Array, isGrounded: boolean}>}
   */
  static async ask({ question, caseId, merchantId, system }, options = {}) {
    // Every answer is grounded only in the calling merchant's data; refuse to run without a tenant
    const scope = resolveScope({ merchantId, system });
    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return {
        answer: 'Please provide a valid question to Ask RecoverIQ.',
        evidence: [],
        isGrounded: false,
      };
    }

    const trimmedQuestion = question.trim();
    const timeoutMs = options.timeoutMs || 4000;

    askLogger.info('ask_recoveriq_received', { question: trimmedQuestion, caseId });

    return withSpan('ask_recoveriq.answer', {
      attributes: {
        'ask.question': trimmedQuestion,
        'ask.caseId': caseId || 'none',
      },
    }, async (span) => {
      // 1. Gather Grounded Evidence
      const evidence = await AskRecoverIQService.gatherEvidence({ question: trimmedQuestion, caseId, merchantId: scope.merchantId, system });

      if (evidence.length === 0) {
        return {
          answer: 'Based on the available recovery audit records, this information is not available.',
          evidence: [],
          isGrounded: false,
        };
      }

      // 2. Call Python GenAI Service (/internal/ask)
      try {
        const endpoint = `${config.genaiServiceUrl}/internal/ask`;
        const headers = {
          'x-internal-service-token': config.genaiInternalToken,
        };
        injectTraceContext(headers);

        const response = await axios.post(
          endpoint,
          {
            question: trimmedQuestion,
            caseId: caseId || null,
            evidence,
          },
          { timeout: timeoutMs, headers }
        );

        if (response.data && response.data.answer) {
          return {
            answer: response.data.answer,
            evidence: response.data.evidence || evidence,
            isGrounded: response.data.isGrounded !== false,
          };
        }
      } catch (err) {
        askLogger.warn('ask_genai_service_unavailable_using_fallback', {
          error: err.message,
          code: err.code,
        });
      }

      // 3. Resilient Grounded Fallback if GenAI service is unavailable
      return AskRecoverIQService.synthesizeDeterministicFallback({
        question: trimmedQuestion,
        caseId,
        evidence,
      });
    });
  }

  /**
   * Gather structured evidence from PostgreSQL decision lineage and audit events.
   *
   * @param {Object} params
   * @param {string} params.question
   * @param {string} [params.caseId]
   * @returns {Promise<Array<Object>>} Structured evidence items
   */
  static async gatherEvidence({ question, caseId, merchantId, system }) {
    const scope = resolveScope({ merchantId, system });
    // Query-layer services take an explicit tenant (or system) option
    const obsScope = scope.merchantId ? { merchantId: scope.merchantId } : { system: true };
    try {
      const evidence = [];

      if (caseId) {
        // Specific Case Evidence Extraction
        const explanation = await ObservabilityService.getDecisionExplanation(caseId, obsScope);
        if (!explanation) {
          return [];
        }

      const {
        transaction = {},
        ml = {},
        agent1 = {},
        agent2 = {},
        policy = {},
        humanReview,
        execution,
        status,
        finalAction,
      } = explanation;

      // 1. Payment received stage
      if (transaction.id) {
        evidence.push({
          caseId,
          stage: '1_payment_failure',
          detail: `Transaction of ${transaction.currency || 'INR'} ${(transaction.amount || 0).toFixed(2)} failed (${transaction.failureReason || 'Declined'}). Payment method: ${transaction.paymentMethod || 'card'}. Attempt #${transaction.attemptCount || 1}.`,
          timestamp: transaction.createdAt,
        });
      }

      // 2. ML Prediction stage
      if (ml.score !== undefined && ml.score !== null) {
        evidence.push({
          caseId,
          stage: '2_ml_prediction',
          detail: `ML Recovery Model (${ml.modelVersion || 'v1.0.0'}) predicted ${(ml.score * 100).toFixed(0)}% recovery probability. Top factors: ${(ml.reasonCodes || []).join(', ') || 'standard risk profile'}.`,
          timestamp: transaction.createdAt,
        });
      }

      // 3. Agent 1 Analysis
      if (agent1.recommendation) {
        evidence.push({
          caseId,
          stage: '3_agent1_analysis',
          action: agent1.recommendation,
          detail: `Agent 1 (${agent1.agentName || 'RecoveryAnalyst'}) recommended '${agent1.recommendation}' (confidence: ${((agent1.confidence || 0.8) * 100).toFixed(0)}%). Rationale: ${agent1.rationale || 'Optimal strategy selected.'}`,
          timestamp: policy.evaluatedAt || transaction.createdAt,
        });
      }

      // 4. Playbook Sources
      if (Array.isArray(agent1.playbookSources) && agent1.playbookSources.length > 0) {
        for (const pb of agent1.playbookSources) {
          evidence.push({
            caseId,
            stage: '4_rag_playbook',
            playbookId: pb.playbookId || pb.id || 'Playbook',
            detail: `Retrieved playbook '${pb.playbookId || pb.id}' from Qdrant: ${pb.strategy || pb.title || 'Guidance matched'}.`,
            timestamp: policy.evaluatedAt || transaction.createdAt,
          });
        }
      }

      // 5. Agent 2 Execution Plan
      if (agent2.proposedAction) {
        const paramStr = Object.entries(agent2.parameters || {})
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(', ');
        evidence.push({
          caseId,
          stage: '5_agent2_plan',
          action: agent2.proposedAction,
          detail: `Agent 2 (${agent2.agentName || 'RecoveryExecutor'}) proposed '${agent2.proposedAction}' with parameters: ${paramStr || 'default options'}. Rationale: ${agent2.rationale || 'Validated against playbook specifications.'}`,
          timestamp: policy.evaluatedAt || transaction.createdAt,
        });
      }

      // 6. Policy Engine Evaluation
      if (policy.decision) {
        const ruleId = policy.primaryRuleId || (policy.appliedRules && policy.appliedRules[0]) || 'GUARDRAIL_EVAL';
        const reasonStr = (policy.reasons && policy.reasons.join('; ')) || 'Evaluated safety rules';
        evidence.push({
          caseId,
          stage: '6_policy',
          ruleId,
          policyDecision: policy.decision,
          detail: `Policy Engine decision: ${policy.decision}. Rule: ${ruleId}. Details: ${reasonStr}`,
          timestamp: policy.evaluatedAt || transaction.createdAt,
        });
      }

      // 7. Human Review
      if (humanReview) {
        evidence.push({
          caseId,
          stage: '7_human_review',
          detail: `Human-in-the-Loop review status: ${humanReview.status || 'reviewed'}. Reviewer: ${humanReview.reviewerId || 'merchant_admin'}. Notes: ${humanReview.notes || 'None'}.`,
          timestamp: humanReview.reviewedAt || transaction.createdAt,
        });
      }

      // 8. Execution Tool
      if (execution) {
        evidence.push({
          caseId,
          stage: '8_execution',
          detail: `Recovery tool '${execution.toolName}' executed with status: ${execution.status} (success: ${execution.success}).`,
          timestamp: execution.executedAt || transaction.createdAt,
        });
      }

      // 9. Final Outcome
      evidence.push({
        caseId,
        stage: '9_outcome',
        detail: `Final case status: '${status}'. Final recovery action: '${finalAction || 'none'}'.`,
        timestamp: transaction.createdAt,
      });

    } else {
      // Aggregate Telemetry Evidence Extraction
      const recentActivity = await ObservabilityService.getRecentActivity(20, obsScope);
      const recentDecisions = await ObservabilityService.getRecentDecisions(10, obsScope);

      let totalRecovered = 0;
      let blockedCount = 0;
      let reviewCount = 0;
      let completedCount = 0;

      for (const item of recentDecisions) {
        const dec = item.decision || {};
        const txn = item.transaction || {};
        const amt = parseFloat(txn.amount || 0);

        if (dec.status === 'recovered' || dec.status === 'executed') {
          totalRecovered += amt;
          completedCount++;
        }
        if (dec.status === 'blocked' || dec.guardrailResult === 'BLOCK') {
          blockedCount++;
        }
        if (dec.status === 'pending_review' || dec.guardrailResult === 'REQUIRE_APPROVAL') {
          reviewCount++;
        }
      }

      evidence.push({
        stage: 'aggregate_metrics',
        detail: `Aggregate summary across recent cases: ${recentDecisions.length} cases evaluated. Total recovered revenue: INR ${totalRecovered.toFixed(2)}. Completed recoveries: ${completedCount}. Blocked cases: ${blockedCount}. Cases pending approval: ${reviewCount}.`,
        timestamp: new Date().toISOString(),
      });

      for (const act of recentActivity.slice(0, 8)) {
        evidence.push({
          caseId: act.caseId,
          stage: act.eventType,
          ruleId: act.policyDecision,
          detail: `Case ${act.caseId}: ${act.summary || act.eventType} (action: ${act.action}, decision: ${act.policyDecision})`,
          timestamp: act.timestamp,
        });
      }
    }

      return evidence;
    } catch (err) {
      askLogger.warn('gather_evidence_error', { error: err.message });
      return [];
    }
  }

  /**
   * Deterministic grounded synthesis fallback.
   */
  static synthesizeDeterministicFallback({ question, caseId, evidence }) {
    const qLower = question.toLowerCase();
    const citations = [];

    // Block reason query
    if (qLower.includes('block')) {
      const blockEv = evidence.find((e) => e.stage === '6_policy' && (e.policyDecision === 'BLOCK' || (e.detail && e.detail.toLowerCase().includes('block'))));
      if (blockEv) {
        citations.push({
          caseId: blockEv.caseId || caseId,
          stage: 'Policy Guardrail',
          ruleId: blockEv.ruleId || 'POLICY_BLOCK',
          timestamp: blockEv.timestamp,
          detail: blockEv.detail,
        });
        return {
          answer: `This case was blocked by the Policy Engine under rule **${blockEv.ruleId || 'POLICY_BLOCK'}**. ${blockEv.detail}`,
          evidence: citations,
          isGrounded: true,
        };
      }
    }

    // Approval requirement query
    if (qLower.includes('approval') || qLower.includes('review')) {
      const appEv = evidence.find((e) => e.stage === '6_policy' && (e.policyDecision === 'REQUIRE_APPROVAL' || (e.detail && e.detail.toLowerCase().includes('approval'))));
      if (appEv) {
        citations.push({
          caseId: appEv.caseId || caseId,
          stage: 'Policy Gating / HITL',
          ruleId: appEv.ruleId || 'REQUIRE_APPROVAL',
          timestamp: appEv.timestamp,
          detail: appEv.detail,
        });
        return {
          answer: `This case required merchant approval because the Policy Engine evaluated rule **${appEv.ruleId || 'REQUIRE_APPROVAL'}**. ${appEv.detail}`,
          evidence: citations,
          isGrounded: true,
        };
      }
    }

    // Agent 1 recommendation query
    if (qLower.includes('agent 1') || qLower.includes('recommend') || qLower.includes('analyst')) {
      const a1Ev = evidence.find((e) => e.stage === '3_agent1_analysis');
      if (a1Ev) {
        citations.push({
          caseId: a1Ev.caseId || caseId,
          stage: 'Agent 1 (Recovery Analyst)',
          timestamp: a1Ev.timestamp,
          detail: a1Ev.detail,
        });
        return {
          answer: `Agent 1 (Recovery Analyst) recommended action **${a1Ev.action || 'attempt_recovery'}**. Rationale: ${a1Ev.detail}`,
          evidence: citations,
          isGrounded: true,
        };
      }
    }

    // Playbook query
    if (qLower.includes('playbook') || qLower.includes('rag')) {
      const pbEv = evidence.find((e) => e.stage === '4_rag_playbook');
      if (pbEv) {
        citations.push({
          caseId: pbEv.caseId || caseId,
          stage: 'Qdrant RAG Retrieval',
          playbookId: pbEv.playbookId,
          timestamp: pbEv.timestamp,
          detail: pbEv.detail,
        });
        return {
          answer: `The recovery playbook retrieved from Qdrant was **${pbEv.playbookId || 'Standard Playbook'}**. ${pbEv.detail}`,
          evidence: citations,
          isGrounded: true,
        };
      }
    }

    // Agent 2 query
    if (qLower.includes('agent 2') || qLower.includes('propose') || qLower.includes('executor')) {
      const a2Ev = evidence.find((e) => e.stage === '5_agent2_plan');
      if (a2Ev) {
        citations.push({
          caseId: a2Ev.caseId || caseId,
          stage: 'Agent 2 (Recovery Executor)',
          timestamp: a2Ev.timestamp,
          detail: a2Ev.detail,
        });
        return {
          answer: `Agent 2 (Recovery Executor) proposed action **${a2Ev.action || 'attempt_recovery'}**. Details: ${a2Ev.detail}`,
          evidence: citations,
          isGrounded: true,
        };
      }
    }

    // Revenue query
    if (qLower.includes('revenue') || qLower.includes('how much') || qLower.includes('recovered')) {
      const revEv = evidence.find((e) => e.stage === 'aggregate_metrics' || e.stage === '1_payment_failure');
      if (revEv) {
        citations.push({
          caseId: revEv.caseId || caseId,
          stage: 'Recovery Revenue & Telemetry',
          timestamp: revEv.timestamp,
          detail: revEv.detail,
        });
        return {
          answer: `Recovery revenue status: ${revEv.detail}`,
          evidence: citations,
          isGrounded: true,
        };
      }
    }

    // Default grounded list
    for (const ev of evidence.slice(0, 4)) {
      citations.push({
        caseId: ev.caseId || caseId,
        stage: ev.stage,
        ruleId: ev.ruleId,
        playbookId: ev.playbookId,
        timestamp: ev.timestamp,
        detail: ev.detail,
      });
    }

    const bullets = citations.map((c) => `- **${c.stage}**: ${c.detail}`).join('\n');
    return {
      answer: `Based on the authoritative audit trail:\n\n${bullets}`,
      evidence: citations,
      isGrounded: true,
    };
  }
}
