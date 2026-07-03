import pool from '../utils/db';
import axios from 'axios';
import crypto from 'crypto';
import { getNombaAccessToken } from '../utils/nombaAuth';
import logger from '../utils/logger';

interface SubscriptionTask {
  subscription_id: string;
  merchant_id: string;
  plan_id: string;
  customer_id: string;
  amount_kobo: number;
  currency: string;
  token_key: string;
  customer_email: string;
  retry_count: number;
  nomba_account_id: string; // Dynamically added to support our schema routing mapping bounds
}

/**
 * Programmatic Recurring Billing Worker
 * Sweeps, locks, and processes due tokenized transactions via unique sub-account contexts
 */
export async function executeRecurringBillingRun() {
  logger.info('Starting automated subscription renewal matrix scan...');
  
  const gatewayAccessToken = await getNombaAccessToken();
  const client = await pool.connect();

  try {
    // 1. SELECT and Lock active records requiring charge processing
    // JOINs merchants table to extract individual sub-account IDs in a single operational sweep
    const queryPendingCharges = `
      SELECT 
        s.id as subscription_id,
        s.merchant_id,
        s.plan_id,
        s.customer_id,
        s.retry_count,
        p.amount_kobo,
        p.currency,
        c.email as customer_email,
        sc.token_key,
        m.nomba_account_id
      FROM subscriptions s
      JOIN plans p ON s.plan_id = p.id
      JOIN customers c ON s.customer_id = c.id
      JOIN saved_cards sc ON s.saved_card_id = sc.id
      JOIN merchants m ON s.merchant_id = m.id
      WHERE s.status IN ('ACTIVE', 'PAST_DUE')
        AND s.current_period_end <= NOW()
        AND s.retry_count < 5
      FOR UPDATE OF s SKIP LOCKED
    `;

    const targetedRows = await client.query(queryPendingCharges);
    if (targetedRows.rows.length === 0) {
      logger.info('No overdue subscription lifecycles identified for processing.');
      return;
    }

    logger.info(`Processing execution loops across ${targetedRows.rows.length} targeted renewals.`);

    for (const task of targetedRows.rows as SubscriptionTask[]) {
      const currentRenewalAttemptUuid = crypto.randomUUID();
      const formattedAmount = (Number(task.amount_kobo) / 100).toFixed(2);

      try {
        await client.query('BEGIN');
        
        // Match multi-tenant execution bounds within the query row loop
        await client.query(`SET LOCAL app.current_merchant_id = ${client.escapeLiteral(task.merchant_id)}`);

        // Assemble the tokenized charge request mapping Nomba specifications dynamically
        const recurrentPayload = {
          order: {
            orderReference: currentRenewalAttemptUuid,
            customerId: task.customer_id,
            amount: formattedAmount,
            currency: task.currency || 'NGN',
            // Dynamically channels money straight into this developer's isolated balance wallet:
            accountId: task.nomba_account_id || undefined, 
            orderMetaData: {
              merchantId: task.merchant_id,
              internalPlanRef: task.plan_id,
              executionCycle: 'automated_cron'
            }
          },
          tokenKey: task.token_key
        };

        logger.info(`Firing recurrent tokenized charge to Nomba for subscription: ${task.subscription_id} mapped to Sub-Account: ${task.nomba_account_id}`);

        const gatewayResponse = await axios.post(
          `${process.env.NOMBA_API_URL}/v1/checkout/tokenized-card-payment`,
          recurrentPayload,
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${gatewayAccessToken}`,
              'accountId': process.env.NOMBA_PARENT_ACCOUNT_ID || '',
            },
            timeout: 15000 
          }
        );

        const responseCode = gatewayResponse.data?.code;
        const responseDescription = gatewayResponse.data?.description;

        if (responseCode === '00') {
          // Success Path: Push the billing window forward by 1 month and reset retry tracking metrics
          await client.query(
            `UPDATE subscriptions 
             SET status = 'ACTIVE',
                 current_period_start = NOW(),
                 current_period_end = NOW() + INTERVAL '1 month',
                 retry_count = 0
             WHERE id = $1`,
            [task.subscription_id]
          );

          // Write a successful credit audit ledger record entry
          await client.query(
            `INSERT INTO billing_ledger (merchant_id, subscription_id, amount_kobo, entry_type, transaction_ref, status)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [task.merchant_id, task.subscription_id, task.amount_kobo, 'CREDIT', currentRenewalAttemptUuid, 'SUCCESS']
          );

          logger.info(`Subscription renewal cycle successfully settled via token: ${task.subscription_id}`);
        } else {
          throw new Error(responseDescription || `Gateway payment decline code: ${responseCode}`);
        }

        await client.query('COMMIT');

      } catch (executionError: any) {
        await client.query('ROLLBACK');
        
        const runtimeErrorMessage = executionError.response?.data?.description || executionError.message;
        logger.error(`Tokenized transaction processing failure for sub reference: ${task.subscription_id}. Error: ${runtimeErrorMessage}`);

        const runtimeLower = runtimeErrorMessage?.toLowerCase() || '';
        const isInsufficientFunds = runtimeLower.includes('insufficient') || runtimeLower.includes('balance') || runtimeLower.includes('51');

        let retryIntervalText = "1 day";
        if (isInsufficientFunds) {
          // Smart localized backoff: retry in 2 days to cleanly realign with funding/salary cycles
          retryIntervalText = "2 days";
        }

        try {
          await client.query('BEGIN');
          await client.query(`SET LOCAL app.current_merchant_id = ${client.escapeLiteral(task.merchant_id)}`);

          await client.query(
            `UPDATE subscriptions 
             SET status = 'PAST_DUE',
                 retry_count = retry_count + 1,
                 current_period_end = NOW() + INTERVAL '${retryIntervalText}'
             WHERE id = $1`,
            [task.subscription_id]
          );

          // Log an audited error footprint record line
          await client.query(
            `INSERT INTO billing_ledger (merchant_id, subscription_id, amount_kobo, entry_type, transaction_ref, status)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [task.merchant_id, task.subscription_id, task.amount_kobo, 'DEBIT', currentRenewalAttemptUuid, 'FAILED']
          );

          await client.query('COMMIT');
          logger.warn(`Subscription state updated to PAST_DUE. Scheduled retry window [${retryIntervalText}] recorded. Ref: ${task.subscription_id}`);
          
          // TODO: Stage 2 - Dispatch outbound signed dunning webhook notification to developer server URL
          // dispatchDeveloperWebhook(task.merchant_id, 'subscription.failed', { subscriptionId: task.subscription_id });

        } catch (innerFallbackError: any) {
          await client.query('ROLLBACK');
          logger.error('Fatal internal logging crash while saving fallback error state loops:', innerFallbackError.message);
        }
      }
    }

  } catch (globalCronError: any) {
    logger.error('Critical unhandled system failure caught within core cron lifecycle:', globalCronError.message);
  } finally {
    if (client) {
      client.release();
    }
  }
}