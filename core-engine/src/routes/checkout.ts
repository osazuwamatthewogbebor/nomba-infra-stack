import { Router, Request, Response } from 'express';
import axios from 'axios';
import crypto from 'crypto';
import pool from '../utils/db';
import { getNombaAccessToken } from '../utils/nombaAuth';
import logger from '../utils/logger';

const router = Router();

interface InitializeCheckoutPayload {
    planId: string;
    customerName?: string;
    customerEmail: string;
    callbackUrl: string;
}

/**
 * POST /v1/checkout/initialize
 */
router.post('/initialize', async (req: Request, res: Response) => {
    const client = await pool.connect();
    
    try {
        const merchantId = req.headers['x-merchant-id'] as string;
        const { planId, customerEmail, callbackUrl } = req.body as InitializeCheckoutPayload;
        
        if (!merchantId) {
            return res.status(401).json({ success: false, error: 'Unauthorized: Missing tenant identity header.' });
        }

        if (!planId || !customerEmail || !callbackUrl) {
            return res.status(400).json({ success: false, error: 'Missing required parameters: planId, customerEmail, and callbackUrl are mandatory.' });
        }

        await client.query('BEGIN');

        // Initialize Row-Level Security context for this connection session
        await client.query(`SET LOCAL app.current_merchant_id = ${client.escapeLiteral(merchantId)}`);

        // 1. Fetch Plan Context through active RLS gate
        const planQuery = await client.query(
            'SELECT id, name, amount_kobo, currency FROM plans WHERE id = $1', 
            [planId]
        );

        if (planQuery.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'Target subscription billing plan not found within your workspace.' });
        }
        const plan = planQuery.rows[0];

        // 2. Resolve Customer Profile Entity (Create if it doesn't exist)
        const customerUpsert = await client.query(
            `INSERT INTO customers (merchant_id, email)
             VALUES ($1, $2)
             ON CONFLICT (merchant_id, email) 
             DO UPDATE SET email = EXCLUDED.email
             RETURNING id`,
            [merchantId, customerEmail.toLowerCase().trim()]
        );
        const customerId = customerUpsert.rows[0].id;

        // Use a clean UUID string for both tracking arrays and the gateway references
        const orderReference = crypto.randomUUID();
        const formattedAmount = (Number(plan.amount_kobo) / 100).toFixed(2);
        
        // Fetch active access token from your OAuth utility service
        const gatewayAccessToken = await getNombaAccessToken();

        // 3. Construct payload strictly matching Nomba requirements
        const nombaPayload = {
            order: {
                callbackUrl: callbackUrl,
                customerEmail: customerEmail.toLowerCase().trim(),
                amount: formattedAmount,
                currency: plan.currency || 'NGN',
                orderReference: orderReference,
                customerId: customerId, // Passing our unique internal customer identifier string
                accountId: process.env.NOMBA_SUB_ACCOUNT_ID || undefined, // Corrected typo here
                allowedPaymentMethods: ['Card', 'Transfer'],
                orderMetaData: {
                    productName: plan.name,
                    internalPlanRef: planId,
                    merchantId: merchantId,
                }
            },
            tokenizeCard: true // Boolean type parameter passing matching standard schemas
        };

        logger.info('Forwarding payload structure to Nomba Checkout API...', { orderReference, merchantId });

        const response = await axios.post(
            `${process.env.NOMBA_API_URL}/v1/checkout/order`,
            nombaPayload,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${gatewayAccessToken}`,
                    'accountId': process.env.NOMBA_PARENT_ACCOUNT_ID || '',
                }
            }
        );

        if (response.data?.code === '00') {
            const checkoutData = response.data.data;

            // 4. Pre-stage pending subscription state log matching database constraints
            await client.query(
                `INSERT INTO subscriptions (
                    merchant_id, customer_id, plan_id, status, 
                    current_period_start, current_period_end, idempotency_key
                )
                VALUES ($1, $2, $3, $4, NOW(), NOW() + INTERVAL '1 month', $5)`,
                [merchantId, customerId, planId, 'PENDING', orderReference]
            );

            await client.query('COMMIT');
            logger.info('Subscription checkout link created successfully.', { orderReference });

            return res.status(200).json({
                success: true,
                message: 'Subscription session initialized.',
                data: {
                    orderReference: checkoutData.orderReference,
                    checkoutLink: checkoutData.checkoutLink,
                    amount: formattedAmount,
                    currency: plan.currency
                }
            });
        } 

        throw new Error(response.data?.description || 'Gateway order initialization fallback failure.');

    } catch (error: any) {
        await client.query('ROLLBACK');
        logger.error('Checkout initialization failed:', { 
            error: error.response?.data || error.message 
        });
        return res.status(500).json({ 
            success: false, 
            error: 'Failed to negotiate tokenization payload configuration with Nomba.' 
        });
    } finally {
        client.release();
    }
});

export default router;