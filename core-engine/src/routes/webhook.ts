import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import pool from '../utils/db';
import logger from '../utils/logger';

const router = Router();

/**
 * Computes Nomba-compliant HMAC-SHA256 signature using the precise delimited format
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
  
  let transactionResponseCode = transaction.responseCode || "";
  if (transactionResponseCode === "null") {
    transactionResponseCode = "";
  }

  // Construct the exact hashing layout string required by Nomba
  const hashingPayload = `${eventType}:${requestId}:${userId}:${walletId}:${transactionId}:${transactionType}:${transactionTime}:${transactionResponseCode}:${timestamp}`;

  logger.debug(`::: Internal constructed payload to hash --> [${hashingPayload}] :::`);

  return crypto
    .createHmac('sha256', secret)
    .update(hashingPayload)
    .digest('base64'); // Nomba signatures are Base64 encoded!
}

/**
 * POST /v1/webhooks/nomba
 */
router.post('/nomba', async (req: Request, res: Response) => {
  try {
    const incomingSignature = req.headers['nomba-signature'] as string;
    const incomingTimestamp = req.headers['nomba-timestamp'] as string;
    const webhookSecret = process.env.NOMBA_WEBHOOK_SECRET || 'your_shared_dashboard_secret';

    if (!incomingSignature || !incomingTimestamp) {
      logger.warn('Rejected webhook: Missing validation parameters in request headers.');
      return res.status(401).json({ error: 'Missing security validation headers.' });
    }

    // 1. Cryptographic Signature Validation Checks
    const computedSignature = generateNombaSignature(req.body, webhookSecret, incomingTimestamp);

    if (computedSignature !== incomingSignature) {
      logger.error('Security alert: Webhook signature validation mismatch!', {
        expected: incomingSignature,
        computed: computedSignature
      });
      return res.status(403).json({ error: 'Cryptographic signature mismatch.' });
    }

    const payload = req.body;
    logger.info(`Verified webhook signature matched. Event type: [${payload.event_type}]`);

    // 2. Process Successful Card Checkout / Tokenizations
    if (payload.event_type === 'payment_success') {
      const { data } = payload;
      const transactionData = data?.transaction;
      const orderData = data?.order;
      const tokenData = data?.tokenizedCardData; // The official object key discovered

      const subscriptionId = orderData?.orderReference; // Linked via checkout init
      const customerId = orderData?.customerId;         // Internal customer UUID string
      const tenantMerchantId = orderData?.orderMetaData?.merchantId;
      const transactionId = transactionData?.transactionId;
      
      const amountKobo = Math.round((transactionData?.transactionAmount || 0) * 100);

      if (!subscriptionId || !tenantMerchantId || !customerId) {
        logger.error('Webhook payload is missing structural isolation tracking parameters.', { requestId: payload.requestId });
        return res.status(422).json({ error: 'Unprocessable metadata context identifiers.' });
      }

      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        // 3. Webhook Idempotency Check: Prevent race conditions or network double-fires
        const deduplicateQuery = await client.query(
          `INSERT INTO processed_webhooks (request_id) 
           VALUES ($1) 
           ON CONFLICT (request_id) DO NOTHING 
           RETURNING request_id`,
          [payload.requestId]
        );

        if (deduplicateQuery.rows.length === 0) {
          logger.warn('Duplicate webhook payload received. Aborting ledger rewrite.', { requestId: payload.requestId });
          await client.query('COMMIT');
          return res.status(200).json({ success: true, message: 'Already processed successfully.' });
        }

        // 4. Force Session-scoped Row-Level Security Compliance
        await client.query(`SET LOCAL app.current_merchant_id = ${client.escapeLiteral(tenantMerchantId)}`);

        let savedCardId: string | null = null;

        // 5. Extract and Vault Tokenized Card Details safely if present
        if (tokenData && tokenData.tokenKey && tokenData.tokenKey !== 'N/A') {
          const expMonth = tokenData.tokenExpiryMonth !== 'N/A' ? parseInt(tokenData.tokenExpiryMonth, 10) : null;
          const expYear = tokenData.tokenExpiryYear !== 'N/A' ? parseInt(tokenData.tokenExpiryYear, 10) : null;

          const cardInsert = await client.query(
            `INSERT INTO saved_cards (customer_id, token_key, card_brand, masked_pan, expiry_month, expiry_year)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id`,
            [customerId, tokenData.tokenKey, tokenData.cardType, tokenData.cardPan, expMonth, expYear]
          );
          savedCardId = cardInsert.rows[0].id;
          logger.info('Securely vaulted and linked tokenized tokenKey to customer entity.', { customerId });
        }

        // 6. Transition Subscription from PENDING to ACTIVE
        const subscriptionUpdate = await client.query(
          `UPDATE subscriptions 
           SET status = 'ACTIVE',
               saved_card_id = COALESCE($1, saved_card_id),
               current_period_start = NOW(),
               current_period_end = NOW() + INTERVAL '1 month'
           WHERE id = $2 AND merchant_id = $3 AND status = 'PENDING'
           RETURNING id`,
          [savedCardId, subscriptionId, tenantMerchantId]
        );

        if (subscriptionUpdate.rows.length === 0) {
          throw new Error(`Target pending subscription row ${subscriptionId} could not be located or updated.`);
        }

        // 7. Balance Ledger Ingestion
        await client.query(
          `INSERT INTO billing_ledger (merchant_id, subscription_id, amount_kobo, entry_type, transaction_ref, status)
           VALUES ($1, $2, $3, 'CREDIT', $4, 'SUCCESS')`,
          [tenantMerchantId, subscriptionId, amountKobo, transactionId || orderData?.orderId, 'SUCCESS']
        );

        await client.query('COMMIT');
        logger.info('Ledger cycle balancing resolved. Subscription initialized successfully.', { subscriptionId });

      } catch (txnError: any) {
        await client.query('ROLLBACK');
        logger.error('Transaction rolled back. Webhook ingestion workflow failed:', { error: txnError.message });
        return res.status(500).json({ error: 'Database ledger synchronization failure.' });
      } finally {
        client.release();
      }
    }

    return res.status(200).json({ success: true, message: 'Event handled.' });

  } catch (error: any) {
    logger.error('Critical webhook processing structural exception caught:', { error: error.message });
    return res.status(500).json({ error: 'Failed to balance webhook event structure.' });
  }
});

export default router;