import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import pool from '../utils/db';
import logger from '../utils/logger';
import { dispatchDeveloperWebhook } from '../utils/webhookDispatcher';

const router = Router();

/**
 * Reconstructs and hashes the explicit signature string mapping from Nomba:
 * event_type:requestId:userId:walletId:transactionId:type:time:responseCode:timestamp
 */
function generateNombaSignature(payload: any, secret: string, timestamp: string): string {
  const data = payload.data || {};
  const merchant = data.merchant || {};
  const transaction = data.transaction || {};

  const eventType = payload.event_type || "";
  const requestId = payload.requestId || "";
  const userId = merchant.userId || "";
  const walletId = merchant.walletId || "";
  const transactionId = transaction.transactionId || "";
  const transactionType = transaction.type || "";
  const transactionTime = transaction.time || "";
  let responseCode = transaction.responseCode || "";

  if (responseCode === "null" || responseCode === null) {
    responseCode = "";
  }

  const hashingPayload = `${eventType}:${requestId}:${userId}:${walletId}:${transactionId}:${transactionType}:${transactionTime}:${responseCode}:${timestamp}`;
  return crypto.createHmac('sha256', secret).update(hashingPayload).digest('base64');
}

router.post('/nomba', async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const incomingSignature = req.headers['nomba-signature'] as string;
    const incomingTimestamp = req.headers['nomba-timestamp'] as string;
    const webhookSecret = process.env.WEBHOOK_SECRET || '';

    if (!incomingSignature || !incomingTimestamp) {
      return res.status(401).json({ error: 'Missing signature headers.' });
    }

    const computedSignature = generateNombaSignature(req.body, webhookSecret, incomingTimestamp);

    // Timing-safe comparison to guard against side-channel verification leaks
    if (
      incomingSignature.length !== computedSignature.length || 
      !crypto.timingSafeEqual(Buffer.from(incomingSignature), Buffer.from(computedSignature))
    ) {
      return res.status(403).json({ error: 'Signature verification failure.' });
    }

    const payload = req.body;
    await client.query('BEGIN');

    // 1. Deduplication Gate
    const deduplicate = await client.query(
      'INSERT INTO processed_webhooks (request_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING request_id',
      [payload.requestId]
    );
    
    if (deduplicate.rows.length === 0) {
      await client.query('COMMIT');
      return res.status(200).json({ message: 'Payload duplicate bypassed safely.' });
    }

    // 2. Event Strategy Routing
    if (payload.event_type === 'payment_success') {
      const transactionData = payload.data?.transaction || {};
      const orderData = payload.data?.order; // Used for customized/card checkout contexts
      const tokenData = payload.data?.tokenizedCardData;
      
      const amountKobo = Math.round((transactionData.transactionAmount || 0) * 100);

      // --- BRANCH A: VIRTUAL ACCOUNT INFLOW (vact_transfer) ---
      if (transactionData.type === 'vact_transfer') {
        const accountRef = transactionData.aliasAccountReference;

        // Resolve consumer identity using the unique virtual account reference index
        const customerRes = await client.query(
          'SELECT id, merchant_id FROM customers WHERE va_account_ref = $1', 
          [accountRef]
        );

        if (customerRes.rows.length === 0) {
          logger.warn(`Orphaned Transfer: Unmapped virtual account reference reference received: ${accountRef}`);
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Virtual Account reference unmapped.' });
        }

        const customer = customerRes.rows[0];
        await client.query(`SET LOCAL app.current_merchant_id = ${client.escapeLiteral(customer.merchant_id)}`);

        // Find the oldest past due or active subscription mapped to this customer context
        const subRes = await client.query(
          `SELECT id, plan_id FROM subscriptions 
           WHERE customer_id = $1 AND payment_method = 'VIRTUAL_ACCOUNT' AND status IN ('ACTIVE', 'PAST_DUE') 
           ORDER BY current_period_end ASC LIMIT 1`, 
          [customer.id]
        );

        if (subRes.rows.length > 0) {
          const sub = subRes.rows[0];
          
          await client.query(
            `UPDATE subscriptions 
             SET status = 'ACTIVE', current_period_start = NOW(), current_period_end = NOW() + INTERVAL '1 month', retry_count = 0 
             WHERE id = $1`,
            [sub.id]
          );

          await client.query(
            `INSERT INTO billing_ledger (merchant_id, subscription_id, amount_kobo, entry_type, transaction_ref, status)
             VALUES ($1, $2, $3, 'CREDIT', $4, 'SUCCESS')`,
            [customer.merchant_id, sub.id, amountKobo, transactionData.transactionId]
          );

          await client.query('COMMIT');

          dispatchDeveloperWebhook(customer.merchant_id, 'subscription.renewed', {
            subscriptionId: sub.id,
            merchantId: customer.merchant_id,
            planId: sub.plan_id,
            amountKobo,
            currency: transactionData.currency || 'NGN',
            transactionRef: transactionData.transactionId,
            paymentMethod: 'VIRTUAL_ACCOUNT'
          }).catch((e) => logger.error(`Webhook dispatch failure: ${e.message}`));
        } else {
          // Acknowledge receipt even if no active subscription configuration matches
          await client.query('COMMIT');
        }
      } 
      
      // --- BRANCH B: CHECKOUT INITIALIZATION (Standard API / Card Order Layout) ---
      else {
        const subscriptionId = orderData?.orderReference;
        const tenantMerchantId = orderData?.orderMetaData?.merchantId;

        if (!tenantMerchantId || !subscriptionId) {
          logger.warn(`Payment received without clear multi-tenant billing anchors. ReqId: ${payload.requestId}`);
          await client.query('COMMIT');
          return res.status(200).json({ success: true, warning: 'Skipped context processing.' });
        }

        await client.query(`SET LOCAL app.current_merchant_id = ${client.escapeLiteral(tenantMerchantId)}`);

        let savedCardId: string | null = null;
        if (tokenData?.tokenKey && tokenData.tokenKey !== 'N/A') {
          const cardInsert = await client.query(
            `INSERT INTO saved_cards (customer_id, token_key, card_brand, masked_pan, expiry_month, expiry_year)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [
              orderData?.customerId, 
              tokenData.tokenKey, 
              tokenData.cardType, 
              tokenData.cardPan, 
              parseInt(tokenData.tokenExpiryMonth) || null, 
              parseInt(tokenData.tokenExpiryYear) || null
            ]
          );
          savedCardId = cardInsert.rows[0].id;
        }

        await client.query(
          `UPDATE subscriptions 
           SET status = 'ACTIVE', saved_card_id = COALESCE($1, saved_card_id), current_period_start = NOW(), current_period_end = NOW() + INTERVAL '1 month'
           WHERE id = $2 AND status = 'PENDING'`,
          [savedCardId, subscriptionId]
        );

        await client.query(
          `INSERT INTO billing_ledger (merchant_id, subscription_id, amount_kobo, entry_type, transaction_ref, status)
           VALUES ($1, $2, $3, 'CREDIT', $4, 'SUCCESS')`,
          [tenantMerchantId, subscriptionId, amountKobo, transactionData.transactionId]
        );

        await client.query('COMMIT');

        dispatchDeveloperWebhook(tenantMerchantId, 'subscription.activated', {
          subscriptionId,
          merchantId: tenantMerchantId,
          planId: orderData?.orderMetaData?.internalPlanRef,
          amountKobo,
          currency: transactionData.currency || 'NGN',
          transactionRef: transactionData.transactionId,
          paymentMethod: 'CARD'
        }).catch((e) => logger.error(`Webhook dispatch failure: ${e.message}`));
      }
    } 
    
    // --- SCENARIO C: UNHANDLED EVENTS RECOVERY LAYOUT ---
    else {
      // Safely consume payout_success, payment_failed, and refunds without hanging threads
      await client.query('COMMIT');
    }

    return res.status(200).json({ success: true });
  } catch (error: any) {
    await client.query('ROLLBACK');
    logger.error('Webhook ingestion crashed:', error.message);
    
    // Throwing an explicit 500 error triggers Nomba's exponential backoff scheduler
    return res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

export default router;