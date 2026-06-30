import { Router, Request, Response } from 'express';
import pool, { executeTenantQuery } from '../utils/db';

const router = Router();

// Test root route to confirm mounting works
// This will match: GET http://localhost:3000/v1
router.get('/', (req: Request, res: Response) => {
    return res.status(200).json({ message: "v1 base router is completely working!" });
});

// This will match: POST http://localhost:3000/v1/merchants/onboard
router.post('/merchants/onboard', async (req: Request, res: Response) => {
    try {
        const { businessName, nombaClientId, nombaClientSecret, nombaAccountId, webhookSecret } = req.body;

        if (!businessName || !nombaClientId || !nombaClientSecret || !nombaAccountId || !webhookSecret) {
            return res.status(400).json({ error: 'Missing required merchant configuration fields.' });
        }

        const result = await pool.query(
            `INSERT INTO merchants (business_name, nomba_client_id, nomba_client_secret, nomba_account_id, webhook_secret)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, business_name, created_at`,
            [businessName, nombaClientId, nombaClientSecret, nombaAccountId, webhookSecret]
        );

        return res.status(201).json({
            success: true,
            message: 'Merchant platform profile created successfully.',
            merchant: result.rows[0]
        });
    } catch (error: any) {
        console.error('Merchant onboarding error:', error.message);
        return res.status(500).json({ error: 'Failed to complete merchant onboarding operational block.' });
    }
});

// This will match: POST http://localhost:3000/v1/plans
router.post('/plans', async (req: Request, res: Response) => {
    try {
        const merchantId = req.headers['x-merchant-id'] as string;
        const { name, amountKobo, currency, billingInterval, customIntervalDays } = req.body;

        if (!merchantId) {
            return res.status(401).json({ error: 'Unauthorized: Missing X-Merchant-ID identification header.' });
        }

        if (!name || !amountKobo || !billingInterval) {
            return res.status(400).json({ error: 'Missing mandatory fields (name, amountKobo, billingInterval).' });
        }

        const newPlan = await executeTenantQuery(merchantId, async (client) => {
            const queryResult = await client.query(
                `INSERT INTO plans (merchant_id, name, amount_kobo, currency, billing_interval, custom_interval_days)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING id, name, amount_kobo, currency, billing_interval`,
                [merchantId, name, amountKobo, currency || 'NGN', billingInterval, customIntervalDays || null]
            );
            return queryResult.rows[0];
        });

        return res.status(201).json({
            success: true,
            message: 'Billing plan created successfully within isolated tenant context.',
            plan: newPlan
        });
    } catch (error: any) {
        console.error('Plan registration error:', error.message);
        return res.status(500).json({ error: 'Failed to create plan within secure RLS parameters.' });
    }
});

// This will match: GET http://localhost:3000/v1/plans
router.get('/plans', async (req: Request, res: Response) => {
    try {
        const merchantId = req.headers['x-merchant-id'] as string;

        if (!merchantId) {
            return res.status(401).json({ error: 'Unauthorized: Missing identification header.' });
        }

        const tenantPlans = await executeTenantQuery(merchantId, async (client) => {
            const queryResult = await client.query('SELECT * FROM plans WHERE merchant_id = $1', [merchantId]);
            return queryResult.rows;
        });

        return res.status(200).json({ success: true, plans: tenantPlans });
    } catch (error: any) {
        console.error('Fetch plans leak prevention exception:', error.message);
        return res.status(500).json({ error: 'Database isolation access execution failed.' });
    }
});

export default router;