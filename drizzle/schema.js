import { pgTable, text, timestamp, integer, numeric, real, jsonb } from 'drizzle-orm/pg-core';
import crypto from 'crypto';

// 1. Customers Table
export const customers = pgTable('customers', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text('name').notNull(),
  email: text('email').notNull(),
  phone: text('phone'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// 2. Transactions Table
export const transactions = pgTable('transactions', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  customerId: text('customer_id').references(() => customers.id, { onDelete: 'cascade' }).notNull(),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  currency: text('currency').default('INR').notNull(),
  paymentMethod: text('payment_method').notNull(), // 'card', 'upi', 'netbanking', 'subscription_mandate'
  status: text('status').default('failed').notNull(), // 'pending', 'failed', 'recovered', 'abandoned', 'escalated'
  failureReason: text('failure_reason').notNull(), // 'insufficient_funds', 'card_expired', 'bank_outage', 'network_timeout', 'authentication_failed', 'high_risk_fraud'
  attemptCount: integer('attempt_count').default(1).notNull(),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// 3. Decisions Table
export const decisions = pgTable('decisions', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  transactionId: text('transaction_id').references(() => transactions.id, { onDelete: 'cascade' }).notNull(),
  agentAnalystResponse: jsonb('agent_analyst_response'),
  mlScore: real('ml_score'),
  recommendedAction: text('recommended_action').notNull(), // 'attempt_recovery', 'schedule_retry', 'send_recovery_message', 'escalate_to_human', 'log_outcome'
  guardrailResult: text('guardrail_result').notNull(), // 'ALLOW', 'REQUIRE_APPROVAL', 'BLOCK'
  finalAction: text('final_action'),
  reasoning: text('reasoning').notNull(),
  status: text('status').default('pending_review').notNull(), // 'pending_review', 'executed', 'rejected', 'modified', 'blocked'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// 4. Actions Table
export const actions = pgTable('actions', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  decisionId: text('decision_id').references(() => decisions.id, { onDelete: 'cascade' }).notNull(),
  toolName: text('tool_name').notNull(),
  toolParams: jsonb('tool_params'),
  status: text('status').default('pending').notNull(), // 'pending', 'success', 'failed', 'skipped'
  result: jsonb('result'),
  executedAt: timestamp('executed_at', { withTimezone: true }).defaultNow().notNull(),
});

// 5. Messages Table
export const messages = pgTable('messages', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  transactionId: text('transaction_id').references(() => transactions.id, { onDelete: 'cascade' }).notNull(),
  eventTaken: text('event_taken').notNull(), // 'recovery_link_sent', 'retry_scheduled', 'escalated', 'resolved'
  channel: text('channel').default('email').notNull(), // 'email', 'sms', 'whatsapp'
  details: jsonb('details'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// 6. Overrides Table
export const overrides = pgTable('overrides', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  decisionId: text('decision_id').references(() => decisions.id, { onDelete: 'cascade' }).notNull(),
  merchantAction: text('merchant_action'),
  merchantReasoning: text('merchant_reasoning').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// 7. Recovery Links Table
export const recoveryLinks = pgTable('recovery_links', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  transactionId: text('transaction_id').references(() => transactions.id, { onDelete: 'cascade' }).notNull(),
  token: text('token').unique().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// 8. Chat History Table
export const chatHistory = pgTable('chat_history', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  sessionId: text('session_id').notNull(),
  role: text('role').notNull(), // 'user', 'assistant', 'system'
  content: text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
