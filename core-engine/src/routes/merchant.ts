import { Router, Request, Response } from 'express';
import pool, { executeTenantQuery } from '../utils/db';
import crypto from 'crypto';

const router = Router();

router.get('/', (req: Request, res: Response) => {
    return res.status(200).json({ message: "v1 pipeline execution live!" });
});

router.post('/merchants/onboard', async (req: Request, res: Response) => {
    try {
        const { businessName, webhookUrl, webhookSecret } = req.body;
        if (!businessName || !webhookSecret) {
            return res.status(400).json({ error: 'Missing mandatory configuration bounds.' });
        }

        const plainTextApiKey = `nsb_live_${crypto.randomBytes(24).toString('hex')}`;
        const apiKeyHash = crypto.createHash('sha256').update(plainTextApiKey).digest('hex');
        const assignedSubAccountId = process.env.NOMBA_SUB_ACCOUNT_ID; // Binds to your team's assigned sandbox block

        const result = await pool.query(
            `INSERT INTO merchants (business_name, api_key_hash, nomba_account_id, webhook_url, webhook_secret)
             VALUES ($1, $2, $3, $4, $5) RETURNING id, business_name, created_at`,
            [businessName, apiKeyHash, assignedSubAccountId, webhookUrl || null, webhookSecret]
        );

        return res.status(201).json({
            success: true,
            message: 'Developer Workspace Profile Onboarded.',
            apiKey: plainTextApiKey,
            merchant: result.rows[0]
        });
    } catch (error: any) {
        return res.status(500).json({ error: error.message });
    }
});

router.post('/plans', async (req: Request, res: Response) => {
    try {
        const merchantId = req.headers['x-merchant-id'] as string;
        const { name, amountKobo, currency, billingInterval, customIntervalDays } = req.body;

        if (!merchantId || !name || !amountKobo || !billingInterval) {
            return res.status(400).json({ error: 'Missing parameter configuration attributes.' });
        }

        const newPlan = await executeTenantQuery(merchantId, async (client) => {
            const queryResult = await client.query(
                `INSERT INTO plans (merchant_id, name, amount_kobo, currency, billing_interval, custom_interval_days)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                [merchantId, name, amountKobo, currency || 'NGN', billingInterval, customIntervalDays || null]
            );
            return queryResult.rows[0];
        });

        return res.status(201).json({ success: true, plan: newPlan });
    } catch (error: any) {
        return res.status(500).json({ error: error.message });
    }
});

router.get('/plans', async (req: Request, res: Response) => {
    try {
        const merchantId = req.headers['x-merchant-id'] as string;
        if (!merchantId) return res.status(401).json({ error: 'Unauthenticated ID.' });

        const tenantPlans = await executeTenantQuery(merchantId, async (client) => {
            const queryResult = await client.query('SELECT * FROM plans WHERE merchant_id = $1', [merchantId]);
            return queryResult.rows;
        });

        return res.status(200).json({ success: true, plans: tenantPlans });
    } catch (error: any) {
        return res.status(500).json({ error: error.message });
    }
});

export default router;