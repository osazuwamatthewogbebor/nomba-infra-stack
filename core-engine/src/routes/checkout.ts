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

/**
 * POST /v1/checkout/initialize
 * Creates a stateful subscription instance. Automatically provisions a persistent 
 * Nomba Virtual NUBAN with KYC anchors or triggers tokenized card checkout links.
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
            customerNin,
            customerPhone
        } = req.body as InitializeCheckoutPayload;
        
        if (!merchantId) {
            return res.status(401).json({ success: false, error: 'Unauthorized: Missing tenant identity header.' });
        }

        if (!planId || !customerEmail) {
            return res.status(400).json({ success: false, error: 'Missing required parameters: planId and customerEmail are mandatory.' });
        }

        await client.query('BEGIN');

        // Enforce session-scoped Row-Level Security context mapping
        await client.query(`SET LOCAL app.current_merchant_id = ${client.escapeLiteral(merchantId)}`);

        // Resolve plan details under active RLS isolation boundary
        const planQuery = await client.query('SELECT * FROM plans WHERE id = $1', [planId]);
        if (planQuery.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'Target subscription plan not found within this workspace.' });
        }
        const plan = planQuery.rows[0];

        // Upsert Customer profile entity inside the isolated tenant space
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
        const subAccountId = process.env.NOMBA_SUB_ACCOUNT_ID; // Your unified platform sub-account ID
        const orderReference = crypto.randomUUID();

        // --- PATH A: HYBRID VIRTUAL ACCOUNT TRANSFER ROUTE ---
        if (paymentMethod === 'VIRTUAL_ACCOUNT') {
            if (!customer.va_account_number) {
                const accountRef = `ref_${crypto.randomBytes(8).toString('hex')}`;
                
                // Construct account generation payload binding compliant KYC identity anchors
                const vaPayload = {
                    accountRef: accountRef,
                    phoneNumber: customerPhone || "08012345678",
                    email: customerEmail.toLowerCase().trim(),
                    // Attach provided identity verification anchor or cleanly fallback to whitelisted sandbox BVN
                    bvn: customerBvn || customerNin || process.env.SANDBOX_TEST_BVN || "22222222222",
                    bankCode: "999992", // Nomba Core Sandbox Mock Bank
                    accountName: `${plan.name} Sub`
                };

                logger.info(`Requesting persistent NUBAN allocation from Nomba rails for customer: ${customer.id}`);

                const vaResponse = await axios.post(
                    `${process.env.NOMBA_API_URL}/v1/accounts/virtual/${subAccountId}`,
                    vaPayload,
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${gatewayAccessToken}`,
                            'accountId': process.env.NOMBA_PARENT_ACCOUNT_ID || ''
                        }
                    }
                );

                if (vaResponse.data?.code === '00') {
                    const resData = vaResponse.data.data;
                    const vaUpdate = await client.query(
                        `UPDATE customers 
                         SET va_bank_name = $1, va_account_number = $2, va_account_ref = $3
                         WHERE id = $4 
                         RETURNING *`,
                        [resData.bankName, resData.accountNumber, accountRef, customer.id]
                    );
                    customer = vaUpdate.rows[0];
                } else {
                    throw new Error(vaResponse.data?.description || 'Virtual Account allocation rejected.');
                }
            }

            // Immediately record subscription status as ACTIVE—awaiting inbound credit transfer webhooks
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
                    'accountId': process.env.NOMBA_PARENT_ACCOUNT_ID || '',
                }
            }
        );

        if (response.data?.code === '00') {
            const checkoutData = response.data.data;

            // Pre-stage pending subscription lifecycle state logs
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
            error: error.message || 'Failed to negotiate pipeline operation with Nomba.' 
        });
    } finally {
        client.release();
    }
});

/**
 * POST /v1/checkout/preview-upgrade
 * Calculates exact remaining value ratios mid-cycle and previews financial requirements
 * before a customer switches pricing tiers.
 */
router.post('/preview-upgrade', async (req: Request, res: Response) => {
    try {
        const merchantId = req.headers['x-merchant-id'] as string;
        const { subscriptionId, targetNewPlanId } = req.body;

        if (!merchantId || !subscriptionId || !targetNewPlanId) {
            return res.status(400).json({ error: "Missing required properties inside payload context." });
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

        // Compute relative time ratios via formula calculations
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

export default router;