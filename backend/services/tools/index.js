import { executeAttemptRecovery } from './attempt-recovery.tool.js';
import { executeScheduleRetry } from './schedule-retry.tool.js';
import { executeSendRecoveryMessage } from './send-recovery-message.tool.js';
import { executeEscalateToHuman } from './escalate-to-human.tool.js';
import { executeLogOutcome } from './log-outcome.tool.js';

export async function executeTool(toolName, params) {
  try {
    switch (toolName) {
      case 'attempt_recovery': {
        const result = await executeAttemptRecovery(params);
        return {
          success: result.success,
          toolName: 'attempt_recovery',
          output: result,
        };
      }

      case 'schedule_retry': {
        const result = await executeScheduleRetry(params);
        return {
          success: result.scheduled,
          toolName: 'schedule_retry',
          output: result,
        };
      }

      case 'send_recovery_message': {
        const result = await executeSendRecoveryMessage(params);
        return {
          success: result.sent,
          toolName: 'send_recovery_message',
          output: result,
          error: result.error,
        };
      }

      case 'escalate_to_human': {
        const result = await executeEscalateToHuman(params);
        return {
          success: true,
          toolName: 'escalate_to_human',
          output: result,
        };
      }

      case 'log_outcome': {
        const result = await executeLogOutcome(params);
        return {
          success: result.logged,
          toolName: 'log_outcome',
          output: result,
        };
      }

      default:
        throw new Error(`Unrecognized MCP tool: ${toolName}`);
    }
  } catch (error) {
    console.error(`[Tool Executor] Execution failed for ${toolName}:`, error);
    return {
      success: false,
      toolName,
      output: {},
      error: error.message || 'Execution failed',
    };
  }
}

export * from './attempt-recovery.tool.js';
export * from './schedule-retry.tool.js';
export * from './send-recovery-message.tool.js';
export * from './escalate-to-human.tool.js';
export * from './log-outcome.tool.js';
