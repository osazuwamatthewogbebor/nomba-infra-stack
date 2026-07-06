import axios from 'axios';
import crypto from 'crypto';
import pool from './db';
import logger from './logger';

export interface OutboundWebhookEvent {
  event: 'subscription.renewed' | 'subscription.failed' | 'subscription.activated';
  timestamp: number;
  data: {
    subscriptionId: string;
    merchantId: string;
    planId: string;
    amountKobo: number;
    currency: string;
    transactionRef: string;
    paymentMethod: 'CARD' | 'VIRTUAL_ACCOUNT';
    error?: string;
  };
}

export async function dispatchDeveloperWebhook(
  merchantId: string,
  eventType: OutboundWebhookEvent['event'],
  eventData: OutboundWebhookEvent['data']
): Promise<void> {
  try {
    const res = await pool.query(
      'SELECT webhook_url, webhook_secret FROM merchants WHERE id = $1',
      [merchantId]
    );

    if (res.rows.length === 0 || !res.rows[0].webhook_url) return;

    const { webhook_url, webhook_secret } = res.rows[0];
    const payload: OutboundWebhookEvent = {
      event: eventType,
      timestamp: Date.now(),
      data: eventData
    };

    const serialized = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = crypto
      .createHmac('sha256', webhook_secret)
      .update(`${timestamp}.${serialized}`)
      .digest('hex');

    logger.info(`Fanning out outbound signature event [${eventType}] to endpoint: ${webhook_url}`);

    await axios.post(webhook_url, serialized, {
      headers: {
        'Content-Type': 'application/json',
        'X-Platform-Signature': signature,
        'X-Platform-Timestamp': timestamp
      },
      timeout: 6000
    });
  } catch (err: any) {
    logger.error(`Outbound dispatch failure for tenant workspace ${merchantId}:`, err.message);
  }
}