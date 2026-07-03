import { Router, Request, Response } from 'express';
import pool, { executeTenantQuery } from '../utils/db';
import crypto from 'crypto';

const router = Router();

// Test root route to confirm mounting works
router.get('/', (req: Request, res: Response) => {
    return res.status(200).json({ message: "v1 base router is completely working!" });
});

/**
 * Merchant Onboarding Endpoint
 * Programmatically provisions a unique developer platform API Key 
 * and maps their upcoming Nomba Sub-Account destination.
 */
router.post('/merchants/onboard', async (req: Request, res: Response) => {
    try {
        const { businessName, nombaAccountId, webhookUrl, webhookSecret } = req.body;

        if (!businessName || !webhookSecret) {
            return res.status(400).json({ error: 'Missing mandatory onboarding configuration fields.' });
        }

        // 1. Generate a high-entropy, secure API key for the developer
        const plainTextApiKey = `nsb_live_${crypto.randomBytes(24).toString('hex')}`;
        
        // 2. Hash it via SHA-256 for secure database persistence matching our schema
        const apiKeyHash = crypto.createHash('sha256').update(plainTextApiKey).digest('hex');

        // 3. Persist the merchant data grid configuration slot
        // NOTE: nombaAccountId will be updated programmatically in Stage 2 via Nomba's Sub-Account creation endpoint.
        const result = await pool.query(
            `INSERT INTO merchants (business_name, api_key_hash, nomba_account_id, webhook_url, webhook_secret)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, business_name, created_at`,
            [businessName, apiKeyHash, nombaAccountId || null, webhookUrl || null, webhookSecret]
        );

        // 4. Expose the unhashed plain-text key to the developer exactly once
        return res.status(201).json({
            success: true,
            message: 'Merchant platform profile created successfully. Secure your API key safely.',
            apiKey: plainTextApiKey,
            merchant: result.rows[0]
        });
    } catch (error: any) {
        console.error('Merchant onboarding error:', error.message);
        return res.status(500).json({ error: 'Failed to complete merchant onboarding operational block.' });
    }
});

/**
 * Plan Registration Endpoint
 * Securely wraps execution inside the tenant-isolated pool connection context
 */
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

/**
 * Fetch Tenant Plans Endpoint
 * Protected against data boundary cross-contamination via enforced context filtering
 */
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