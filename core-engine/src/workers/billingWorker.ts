import pool from '../utils/db';
import axios from 'axios';
import crypto from 'crypto';
import { getNombaAccessToken } from '../utils/nombaAuth';
import logger from '../utils/logger';
import { dispatchDeveloperWebhook } from '../utils/webhookDispatcher';

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

export async function executeRecurringBillingRun() {
  logger.info('Initiating horizontal subscription renewal card scan sweep...');
  
  const gatewayAccessToken = await getNombaAccessToken();
  const client = await pool.connect();

  try {
    const queryPendingCharges = `
      SELECT 
        s.id as subscription_id, s.merchant_id, s.plan_id, s.customer_id, s.retry_count,
        p.amount_kobo, p.currency, c.email as customer_email, sc.token_key
      FROM subscriptions s
      JOIN plans p ON s.plan_id = p.id
      JOIN customers c ON s.customer_id = c.id
      JOIN saved_cards sc ON s.saved_card_id = sc.id
      WHERE s.status IN ('ACTIVE', 'PAST_DUE')
        AND s.payment_method = 'CARD'
        AND s.current_period_end <= NOW()
        AND s.retry_count < 5
      FOR UPDATE OF s SKIP LOCKED
    `;

    const targetedRows = await client.query(queryPendingCharges);
    if (targetedRows.rows.length === 0) return;

    const subAccountId = process.env.NOMBA_SUB_ACCOUNT_ID;

    for (const task of targetedRows.rows as SubscriptionTask[]) {
      const currentRenewalAttemptUuid = crypto.randomUUID();
      const formattedAmount = (Number(task.amount_kobo) / 100).toFixed(2);

      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL app.current_merchant_id = ${client.escapeLiteral(task.merchant_id)}`);

        const recurrentPayload = {
          order: {
            orderReference: currentRenewalAttemptUuid,
            customerId: task.customer_id,
            amount: formattedAmount,
            currency: task.currency || 'NGN',
            accountId: subAccountId, 
            orderMetaData: { merchantId: task.merchant_id, internalPlanRef: task.plan_id, executionCycle: 'automated_cron' }
          },
          tokenKey: task.token_key
        };

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

        if (gatewayResponse.data?.code === '00') {
          await client.query(
            `UPDATE subscriptions SET status = 'ACTIVE', current_period_start = NOW(), current_period_end = NOW() + INTERVAL '1 month', retry_count = 0 WHERE id = $1`,
            [task.subscription_id]
          );

          await client.query(
            `INSERT INTO billing_ledger (merchant_id, subscription_id, amount_kobo, entry_type, transaction_ref, status) VALUES ($1, $2, $3, 'CREDIT', $4, 'SUCCESS')`,
            [task.merchant_id, task.subscription_id, task.amount_kobo, currentRenewalAttemptUuid]
          );

          await client.query('COMMIT');

          dispatchDeveloperWebhook(task.merchant_id, 'subscription.renewed', {
            subscriptionId: task.subscription_id, merchantId: task.merchant_id, planId: task.plan_id,
            amountKobo: task.amount_kobo, currency: task.currency, transactionRef: currentRenewalAttemptUuid, paymentMethod: 'CARD'
          }).catch((e) => logger.error(e.message));

        } else {
          throw new Error(gatewayResponse.data?.description || 'Card Declined');
        }

      } catch (executionError: any) {
        await client.query('ROLLBACK');
        const msg = executionError.response?.data?.description || executionError.message;
        const isFundsDecline = msg.toLowerCase().includes('insufficient') || msg.toLowerCase().includes('balance') || msg.includes('51');

        let retryIntervalText = isFundsDecline ? "2 days" : "1 day";

        try {
          await client.query('BEGIN');
          await client.query(`SET LOCAL app.current_merchant_id = ${client.escapeLiteral(task.merchant_id)}`);

          await client.query(
            `UPDATE subscriptions SET status = 'PAST_DUE', retry_count = retry_count + 1, current_period_end = NOW() + INTERVAL '${retryIntervalText}' WHERE id = $1`,
            [task.subscription_id]
          );

          await client.query(
            `INSERT INTO billing_ledger (merchant_id, subscription_id, amount_kobo, entry_type, transaction_ref, status) VALUES ($1, $2, $3, 'DEBIT', $4, 'FAILED')`,
            [task.merchant_id, task.subscription_id, task.amount_kobo, currentRenewalAttemptUuid]
          );

          await client.query('COMMIT');

          dispatchDeveloperWebhook(task.merchant_id, 'subscription.failed', {
            subscriptionId: task.subscription_id, merchantId: task.merchant_id, planId: task.plan_id,
            amountKobo: task.amount_kobo, currency: task.currency, transactionRef: currentRenewalAttemptUuid, paymentMethod: 'CARD', error: msg
          }).catch((e) => logger.error(e.message));

        } catch (innerError: any) {
          await client.query('ROLLBACK');
        }
      }
    }
  } catch (globalError: any) {
    logger.error('Global sweep fault:', globalError.message);
  } finally {
    client.release();
  }
}