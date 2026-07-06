import { Router, Request, Response } from 'express';
import axios from 'axios';
import crypto from 'crypto';
import pool from '../utils/db';
import { getNombaAccessToken } from '../utils/nombaAuth';
import { calculateProratedUpgradeAmount } from '../utils/proration';
import logger from '../utils/logger';

const router = Router();

interface InitializeCheckoutPayload {
    planId: string;
    customerEmail: string;
    callbackUrl?: string;
    paymentMethod?: 'CARD' | 'VIRTUAL_ACCOUNT';
    customerBvn?: string;
    customerNin?: string;
    customerPhone?: string;
}

const isValidUuid = (uuid: string): boolean => {
    const uuidv4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidv4Regex.test(uuid);
};

/**
 * POST /v1/checkout/initialize
 */
router.post('/initialize', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
        const merchantId = req.headers['x-merchant-id'] as string;
        const { 
            planId, 
            customerEmail, 
            callbackUrl, 
            paymentMethod = 'CARD',
            customerBvn,
            customerNin
        } = req.body as InitializeCheckoutPayload;
        
        if (!merchantId || !isValidUuid(merchantId)) {
            return res.status(401).json({ success: false, error: 'Unauthorized: Missing or malformed tenant identity handle.' });
        }

        if (!planId || !isValidUuid(planId) || !customerEmail) {
            return res.status(400).json({ success: false, error: 'Missing or malformed required parameters: planId (UUID) and customerEmail are mandatory.' });
        }

        await client.query('BEGIN');

        await client.query(`SET LOCAL app.current_merchant_id = ${client.escapeLiteral(merchantId)}`);

        const planQuery = await client.query('SELECT * FROM plans WHERE id = $1', [planId]);
        if (planQuery.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'Target subscription plan not found within this workspace.' });
        }
        const plan = planQuery.rows[0];

        const customerUpsert = await client.query(
            `INSERT INTO customers (merchant_id, email) 
             VALUES ($1, $2)
             ON CONFLICT (merchant_id, email) 
             DO UPDATE SET email = EXCLUDED.email 
             RETURNING *`,
            [merchantId, customerEmail.toLowerCase().trim()]
        );
        let customer = customerUpsert.rows[0];

        const gatewayAccessToken = await getNombaAccessToken();
        const parentAccountId = process.env.NOMBA_PARENT_ACCOUNT_ID; 
        const subAccountId = process.env.NOMBA_SUB_ACCOUNT_ID; 
        const orderReference = crypto.randomUUID();

        // --- PATH A: STRIPPED & COMPLIANT VIRTUAL ACCOUNT ROUTE ---
        if (paymentMethod === 'VIRTUAL_ACCOUNT') {
            if (!customer.va_account_number) {
                // Nomba requires accountRef length min: 16, max: 64
                const accountRef = `ref_${crypto.randomBytes(8).toString('hex')}`;
                
                // Pure payload modeled strictly against Nomba's CreateVirtualAccountRequest schema
                const vaPayload = {
                    accountRef: accountRef,
                    accountName: `${plan.name.substring(0, 50)} Sub`, // Safe headroom for max length limits
                    bvn: customerBvn || customerNin || process.env.SANDBOX_TEST_BVN || "22222222222"
                };

                logger.info(`Requesting persistent NUBAN allocation from Nomba rails for customer: ${customer.id}`);

                const vaResponse = await axios.post(
                    `${process.env.NOMBA_API_URL}/v1/accounts/virtual`,
                    vaPayload,
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${gatewayAccessToken}`,
                            'accountId': parentAccountId || '' // Parent account identifier header parameter
                        }
                    }
                );

                if (vaResponse.data?.code === '00') {
                    const resData = vaResponse.data.data;
                    
                    // Maps accurate API values: resData.bankName and resData.bankAccountNumber
                    const vaUpdate = await client.query(
                        `UPDATE customers 
                         SET va_bank_name = $1, va_account_number = $2, va_account_ref = $3
                         WHERE id = $4 
                         RETURNING *`,
                        [resData.bankName, resData.bankAccountNumber, accountRef, customer.id]
                    );
                    customer = vaUpdate.rows[0];
                } else {
                    throw new Error(vaResponse.data?.description || 'Virtual Account allocation rejected by gateway schema parameters.');
                }
            }

            await client.query(
                `INSERT INTO subscriptions (
                    merchant_id, customer_id, plan_id, payment_method, status, 
                    current_period_start, current_period_end, idempotency_key
                )
                 VALUES ($1, $2, $3, 'VIRTUAL_ACCOUNT', 'ACTIVE', NOW(), NOW() + INTERVAL '1 month', $4)`,
                [merchantId, customer.id, planId, orderReference]
            );

            await client.query('COMMIT');
            return res.status(200).json({
                success: true,
                paymentMethod: 'VIRTUAL_ACCOUNT',
                data: {
                    bankName: customer.va_bank_name,
                    accountNumber: customer.va_account_number,
                    accountRef: customer.va_account_ref
                }
            });
        }

        // --- PATH B: STANDARD TOKENIZED RECURRING CARD CHECKOUT LINK ---
        const formattedAmount = (Number(plan.amount_kobo) / 100).toFixed(2);
        const nombaPayload = {
            order: {
                callbackUrl: callbackUrl || 'https://localhost:3000',
                customerEmail: customerEmail.toLowerCase().trim(),
                amount: formattedAmount,
                currency: plan.currency || 'NGN',
                orderReference: orderReference,
                customerId: customer.id,
                accountId: subAccountId,
                allowedPaymentMethods: ['Card'],
                orderMetaData: {
                    productName: plan.name,
                    internalPlanRef: planId,
                    merchantId: merchantId
                }
            },
            tokenizeCard: true
        };

        logger.info('Forwarding card order payload configuration to Nomba Checkout rails...', { orderReference });

        const response = await axios.post(
            `${process.env.NOMBA_API_URL}/v1/checkout/order`,
            nombaPayload,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${gatewayAccessToken}`,
                    'accountId': parentAccountId || '',
                }
            }
        );

        if (response.data?.code === '00') {
            const checkoutData = response.data.data;

            await client.query(
                `INSERT INTO subscriptions (
                    merchant_id, customer_id, plan_id, payment_method, status, 
                    current_period_start, current_period_end, idempotency_key
                )
                 VALUES ($1, $2, $3, 'CARD', 'PENDING', NOW(), NOW() + INTERVAL '1 month', $4)`,
                [merchantId, customer.id, planId, orderReference]
            );

            await client.query('COMMIT');
            return res.status(200).json({
                success: true,
                paymentMethod: 'CARD',
                data: {
                    checkoutLink: checkoutData.checkoutLink,
                    orderReference: checkoutData.orderReference
                }
            });
        } 
        
        throw new Error(response.data?.description || 'Gateway core checkout generation failure.');

    } catch (error: any) {
        await client.query('ROLLBACK');
        logger.error('Subscription sequence initialization crashed:', { 
            error: error.response?.data || error.message 
        });
        return res.status(500).json({ 
            success: false, 
            error: error.response?.data?.description || error.message || 'Database validation or upstream gateway communication failure.' 
        });
    } finally {
        client.release();
    }
});

/**
 * POST /v1/checkout/preview-upgrade
 */
router.post('/preview-upgrade', async (req: Request, res: Response) => {
    try {
        const merchantId = req.headers['x-merchant-id'] as string;
        const { subscriptionId, targetNewPlanId } = req.body;

        if (!merchantId || !isValidUuid(merchantId) || !subscriptionId || !isValidUuid(subscriptionId) || !targetNewPlanId || !isValidUuid(targetNewPlanId)) {
            return res.status(400).json({ error: "Missing or malformed required properties inside payload context." });
        }

        const queryResult = await pool.query(
            `SELECT s.*, p.amount_kobo as current_amount, p.currency
             FROM subscriptions s
             JOIN plans p ON s.plan_id = p.id
             WHERE s.id = $1 AND s.merchant_id = $2`,
            [subscriptionId, merchantId]
        );

        if (queryResult.rows.length === 0) {
            return res.status(404).json({ error: "Active subscription instance matching parameters not found." });
        }

        const subscription = queryResult.rows[0];

        const targetPlanResult = await pool.query(
            "SELECT amount_kobo FROM plans WHERE id = $1 AND merchant_id = $2",
            [targetNewPlanId, merchantId]
        );

        if (targetPlanResult.rows.length === 0) {
            return res.status(404).json({ error: "Target pricing plan layout not found." });
        }

        const targetNewPlanAmount = targetPlanResult.rows[0].amount_kobo;

        const financialMatrix = calculateProratedUpgradeAmount(
            Number(subscription.current_amount),
            Number(targetNewPlanAmount),
            {
                start: new Date(subscription.current_period_start),
                end: new Date(subscription.current_period_end)
            }
        );

        return res.status(200).json({
            success: true,
            data: {
                subscriptionId,
                currency: subscription.currency,
                currentPlanAmountKobo: Number(subscription.current_amount),
                targetPlanAmountKobo: Number(targetNewPlanAmount),
                immediateChargeDueKobo: financialMatrix.chargeAmountKobo,
                customerCreditGeneratedKobo: financialMatrix.creditAppliedKobo
            }
        });

    } catch (error: any) {
        logger.error('Proration tracking preview runtime error:', error.message);
        return res.status(500).json({ error: 'Failed to safely compute proration metric preview arrays.' });
    }
});

/**
 * GET /v1/checkout/customers
 */
router.get('/customers', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
        const merchantId = String(req.headers['x-merchant-id'] || '');
        if (!merchantId || !isValidUuid(merchantId)) {
            return res.status(401).json({ success: false, error: 'Unauthorized: Missing or malformed tenant identity header.' });
        }

        await client.query(`SET LOCAL app.current_merchant_id = ${client.escapeLiteral(merchantId)}`);

        const result = await client.query(
            `SELECT id, email, va_bank_name, va_account_number, va_account_ref, created_at 
             FROM customers 
             ORDER BY created_at DESC`
        );

        return res.status(200).json({
            success: true,
            count: result.rows.length,
            data: result.rows
        });
    } catch (error: any) {
        logger.error('Failed to retrieve customer workspace matrix:', error.message);
        return res.status(500).json({ success: false, error: 'Database context customer retrieval failed.' });
    } finally {
        client.release();
    }
});

/**
 * GET /v1/checkout/customers/:id/details
 */
router.get('/customers/:id/details', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
        const merchantId = String(req.headers['x-merchant-id'] || '');
        const customerId = String(req.params.id);

        if (!merchantId || !isValidUuid(merchantId) || !customerId || !isValidUuid(customerId)) {
            return res.status(400).json({ success: false, error: 'Invalid workspace context or customer identification parameter layout.' });
        }

        await client.query(`SET LOCAL app.current_merchant_id = ${client.escapeLiteral(merchantId)}`);

        const customerResult = await client.query('SELECT * FROM customers WHERE id = $1', [customerId]);
        if (customerResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Customer entity not found within this workspace partition.' });
        }

        const subscriptionHistory = await client.query(
            `SELECT s.id as subscription_id, s.status, s.payment_method, 
                    s.current_period_start, s.current_period_end,
                    p.name as plan_name, p.amount_kobo, p.billing_interval
             FROM subscriptions s
             JOIN plans p ON s.plan_id = p.id
             WHERE s.customer_id = $1
             ORDER BY s.created_at DESC`,
            [customerId]
        );

        return res.status(200).json({
            success: true,
            data: {
                profile: customerResult.rows[0],
                subscriptions: subscriptionHistory.rows
            }
        });
    } catch (error: any) {
        logger.error('Failed to compile customer profiles:', error.message);
        return res.status(500).json({ success: false, error: 'Internal processing customer profile compilation crash.' });
    } finally {
        client.release();
    }
});

export default router;