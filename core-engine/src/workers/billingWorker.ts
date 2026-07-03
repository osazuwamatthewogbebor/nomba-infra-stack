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
}

/**
 * Programmatic Recurring Billing Worker
 * Designed to execute as an isolated background task or cron job
 */
export async function executeRecurringBillingRun() {
  logger.info('Starting automated subscription renewal matrix scan...');
  
  const gatewayAccessToken = await getNombaAccessToken();
  
  // Cleanly await and capture the pool client connection resource
  const client = await pool.connect();

  try {
    // 1. SELECT and Lock active records requiring charge processing
    // Uses SKIP LOCKED to avoid multi-instance execution overlapping or thread bottlenecks
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
        sc.token_key
      FROM subscriptions s
      JOIN plans p ON s.plan_id = p.id
      JOIN customers c ON s.customer_id = c.id
      JOIN saved_cards sc ON s.saved_card_id = sc.id
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
      // Create a deterministic tracking reference unique to this billing execution loop iteration
      const currentRenewalAttemptUuid = crypto.randomUUID();
      const formattedAmount = (Number(task.amount_kobo) / 100).toFixed(2);

      // Explicit isolation wrap for the individual row transaction block
      try {
        await client.query('BEGIN');
        
        // Match multi-tenant execution bounds within the query row loop
        await client.query(`SET LOCAL app.current_merchant_id = ${client.escapeLiteral(task.merchant_id)}`);

        // Assemble the tokenized charge request mapping Nomba specifications
        const recurrentPayload = {
          order: {
            orderReference: currentRenewalAttemptUuid, // Acts as the gateway's uniqueness anchor
            customerId: task.customer_id,
            amount: formattedAmount,
            currency: task.currency || 'NGN',
            accountId: process.env.NOMBA_SUB_ACCOUNT_ID || undefined,
            orderMetaData: {
              merchantId: task.merchant_id,
              internalPlanRef: task.plan_id,
              executionCycle: 'automated_cron'
            }
          },
          tokenKey: task.token_key
        };

        logger.info(`Firing recurrent tokenized charge to Nomba infrastructure for subscription: ${task.subscription_id}`);

        // Set an explicit timeout to prevent connection hangs during network drops
        const gatewayResponse = await axios.post(
          `${process.env.NOMBA_API_URL}/v1/checkout/tokenized-card-payment`,
          recurrentPayload,
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${gatewayAccessToken}`,
              'accountId': process.env.NOMBA_PARENT_ACCOUNT_ID || '',
            },
            timeout: 15000 // 15-second cutoff threshold
          }
        );

        const responseCode = gatewayResponse.data?.code;
        const responseDescription = gatewayResponse.data?.description;

        if (responseCode === '00') {
          // Success Path: Push the billing window forward by 30 days and reset retry tracking metrics
          await client.query(
            `UPDATE subscriptions 
             SET status = 'ACTIVE',
                 current_period_start = NOW(),
                 current_period_end = NOW() + INTERVAL '1 month',
                 retry_count = 0,
                 updated_at = NOW()
             WHERE id = $1`,
            [task.subscription_id]
          );

          // Write a successful credit audit ledger record entry (Fixed array bindings matching 6 targets)
          await client.query(
            `INSERT INTO billing_ledger (merchant_id, subscription_id, amount_kobo, entry_type, transaction_ref, status)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [task.merchant_id, task.subscription_id, task.amount_kobo, 'CREDIT', currentRenewalAttemptUuid, 'SUCCESS']
          );

          logger.info(`Subscription renewal cycle successfully settled via token: ${task.subscription_id}`);
        } else {
          // Handle explicit gateway declines (e.g., "Insufficient Funds" or "Expired Card")
          throw new Error(responseDescription || `Gateway payment decline code: ${responseCode}`);
        }

        await client.query('COMMIT');

      } catch (executionError: any) {
        await client.query('ROLLBACK');
        
        const runtimeErrorMessage = executionError.response?.data?.description || executionError.message;
        logger.error(`Tokenized transaction processing failure for sub reference: ${task.subscription_id}. Error: ${runtimeErrorMessage}`);

        // Handle network timeouts vs explicit insufficient funds
        const isInsufficientFunds = runtimeErrorMessage?.toLowerCase().includes('insufficient') || 
                                     runtimeErrorMessage?.toLowerCase().includes('balance');

        // Flag the profile context as PAST_DUE, increment retry tracking metric counts, and schedule a retry window
        let retryIntervalText = "1 day";
        if (isInsufficientFunds) {
          // Smart structural backoff: check again in 2 days to account for standard salary cycles
          retryIntervalText = "2 days";
        }

        try {
          await client.query('BEGIN');
          await client.query(`SET LOCAL app.current_merchant_id = ${client.escapeLiteral(task.merchant_id)}`);

          await client.query(
            `UPDATE subscriptions 
             SET status = 'PAST_DUE',
                 retry_count = retry_count + 1,
                 current_period_end = NOW() + INTERVAL '${retryIntervalText}',
                 updated_at = NOW()
             WHERE id = $1`,
            [task.subscription_id]
          );

          // Log an audited error footprint record line (Fixed array bindings matching 6 targets)
          await client.query(
            `INSERT INTO billing_ledger (merchant_id, subscription_id, amount_kobo, entry_type, transaction_ref, status)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [task.merchant_id, task.subscription_id, task.amount_kobo, 'DEBIT', currentRenewalAttemptUuid, 'FAILED']
          );

          await client.query('COMMIT');
          logger.warn(`Subscription state updated to PAST_DUE. Scheduled retry tracking increment recorded. Ref: ${task.subscription_id}`);
        } catch (innerFallbackError: any) {
          await client.query('ROLLBACK');
          logger.error('Fatal internal logging crash while saving fallback error state loops:', innerFallbackError.message);
        }
      }
    }

  } catch (globalCronError: any) {
    logger.error('Critical unhandled system failure caught within core cron lifecycle:', {
      message: globalCronError.message,
      stack: globalCronError.stack,
      errorObj: globalCronError
    });
  } finally {
    // Standard safe connection release footprint pattern
    if (client) {
      client.release();
    }
  }
}