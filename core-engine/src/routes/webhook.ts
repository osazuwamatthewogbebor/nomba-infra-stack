import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import pool from '../utils/db';
import logger from '../utils/logger';
import { dispatchDeveloperWebhook } from '../utils/webhookDispatcher';

const router = Router();

function generateNombaSignature(payload: any, secret: string, timestamp: string): string {
  const data = payload.data || {};
  const merchant = data.merchant || {};
  const transaction = data.transaction || {};

  const hashingPayload = `${payload.event_type || ""}:${payload.requestId || ""}:${merchant.userId || ""}:${merchant.walletId || ""}:${transaction.transactionId || ""}:${transaction.type || ""}:${transaction.time || ""}:${transaction.responseCode === "null" ? "" : (transaction.responseCode || "")}:${timestamp}`;
  return crypto.createHmac('sha256', secret).update(hashingPayload).digest('base64');
}

router.post('/nomba', async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const incomingSignature = req.headers['nomba-signature'] as string;
    const incomingTimestamp = req.headers['nomba-timestamp'] as string;
    const webhookSecret = process.env.NOMBA_PARENT_WEBHOOK_SECRET || '';

    if (!incomingSignature || !incomingTimestamp) return res.status(401).json({ error: 'Missing signature headers.' });
    if (generateNombaSignature(req.body, webhookSecret, incomingTimestamp) !== incomingSignature) {
      return res.status(403).json({ error: 'Signature verification failure.' });
    }

    const payload = req.body;
    await client.query('BEGIN');

    // Deduplication gate
    const deduplicate = await client.query(
      'INSERT INTO processed_webhooks (request_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING request_id',
      [payload.requestId]
    );
    if (deduplicate.rows.length === 0) {
      await client.query('COMMIT');
      return res.status(200).json({ message: 'Payload duplicate bypassed safely.' });
    }

    // --- SCENARIO A: CARD CHECKOUT INITIALIZATION SUCCESS ---
    if (payload.event_type === 'payment_success') {
      const transactionData = payload.data?.transaction;
      const orderData = payload.data?.order;
      const tokenData = payload.data?.tokenizedCardData;

      const subscriptionId = orderData?.orderReference;
      const tenantMerchantId = orderData?.orderMetaData?.merchantId;
      const amountKobo = Math.round((transactionData?.transactionAmount || 0) * 100);

      await client.query(`SET LOCAL app.current_merchant_id = ${client.escapeLiteral(tenantMerchantId)}`);

      let savedCardId: string | null = null;
      if (tokenData?.tokenKey && tokenData.tokenKey !== 'N/A') {
        const cardInsert = await client.query(
          `INSERT INTO saved_cards (customer_id, token_key, card_brand, masked_pan, expiry_month, expiry_year)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [orderData?.customerId, tokenData.tokenKey, tokenData.cardType, tokenData.cardPan, parseInt(tokenData.tokenExpiryMonth) || null, parseInt(tokenData.tokenExpiryYear) || null]
        );
        savedCardId = cardInsert.rows[0].id;
      }

      await client.query(
        `UPDATE subscriptions SET status = 'ACTIVE', saved_card_id = COALESCE($1, saved_card_id), current_period_start = NOW(), current_period_end = NOW() + INTERVAL '1 month'
         WHERE id = $2 AND status = 'PENDING'`,
        [savedCardId, subscriptionId]
      );

      await client.query(
        `INSERT INTO billing_ledger (merchant_id, subscription_id, amount_kobo, entry_type, transaction_ref, status)
         VALUES ($1, $2, $3, 'CREDIT', $4, 'SUCCESS')`,
        [tenantMerchantId, subscriptionId, amountKobo, transactionData?.transactionId]
      );

      await client.query('COMMIT');

      dispatchDeveloperWebhook(tenantMerchantId, 'subscription.activated', {
        subscriptionId, merchantId: tenantMerchantId, planId: orderData?.orderMetaData?.internalPlanRef,
        amountKobo, currency: transactionData?.currency || 'NGN', transactionRef: transactionData?.transactionId, paymentMethod: 'CARD'
      }).catch((e) => logger.error(e.message));
    }
    
    // --- SCENARIO B: VIRTUAL ACCOUNT TRANSFER INFLOW RECEIVED ---
    else if (payload.event_type === 'virtual_account_credit') {
      const vaData = payload.data; // accountRef, amount, orderId etc.
      const accountRef = vaData?.accountRef;
      const amountKobo = Math.round((vaData?.amount || 0) * 100);

      // Resolve user via the unique indexed Virtual Account parameter tag
      const customerRes = await pool.query('SELECT * FROM customers WHERE va_account_ref = $1', [accountRef]);
      if (customerRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Virtual Account reference unmapped.' });
      }
      
      const customer = customerRes.rows[0];
      await client.query(`SET LOCAL app.current_merchant_id = ${client.escapeLiteral(customer.merchant_id)}`);

      // Find the oldest past due or active subscription mapped to this consumer
      const subRes = await client.query(
        `SELECT * FROM subscriptions WHERE customer_id = $1 AND payment_method = 'VIRTUAL_ACCOUNT' AND status IN ('ACTIVE', 'PAST_DUE') 
         ORDER BY current_period_end ASC LIMIT 1`, [customer.id]
      );

      if (subRes.rows.length > 0) {
        const sub = subRes.rows[0];
        await client.query(
          `UPDATE subscriptions SET status = 'ACTIVE', current_period_start = NOW(), current_period_end = NOW() + INTERVAL '1 month', retry_count = 0 WHERE id = $1`,
          [sub.id]
        );

        await client.query(
          `INSERT INTO billing_ledger (merchant_id, subscription_id, amount_kobo, entry_type, transaction_ref, status)
           VALUES ($1, $2, $3, 'CREDIT', $4, 'SUCCESS')`,
          [customer.merchant_id, sub.id, amountKobo, vaData?.transactionId || crypto.randomUUID()]
        );

        await client.query('COMMIT');

        dispatchDeveloperWebhook(customer.merchant_id, 'subscription.renewed', {
          subscriptionId: sub.id, merchantId: customer.merchant_id, planId: sub.plan_id,
          amountKobo, currency: 'NGN', transactionRef: vaData?.transactionId, paymentMethod: 'VIRTUAL_ACCOUNT'
        }).catch((e) => logger.error(e.message));
      } else {
        await client.query('COMMIT');
      }
    } else {
      await client.query('COMMIT');
    }

    return res.status(200).json({ success: true });
  } catch (error: any) {
    await client.query('ROLLBACK');
    logger.error('Webhook ingestion crashed:', error.message);
    return res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

export default router;