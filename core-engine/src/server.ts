import express, { Request, Response } from "express";
import dotenv from 'dotenv';
import pool, { executeTenantQuery } from './utils/db';
import merchantRoutes from './routes/merchant'


dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 5000;

// Mount Infra operational routes
app.get('/v1/test-inline', (req, res) => {
    res.status(200).json({ message: "Inline route works perfectly!" });
});

// Mount Infra operational routes
app.use('/v1', merchantRoutes);

// Health check endpoint verifying pool stability
app.get('/health', async (_req: Request, res: Response) => {
    try {
        await pool.query('SELECT 1');
        return res.status(200).json({ status: 'healthy', timeStamp: new Date() });
    } catch (error: any) {
        return res.status(500).json({ status: 'unhealthy', error: error.message });
    }
});

// Incoming Edge Webhook processor routed from Cloudflare Proxy
app.post('/webhook', async (req: Request, res: Response) => {
    try {
        const payload = req.body;

        console.log('--- Received Webhook Payload from Proxy ---');
        console.log(JSON.stringify(payload, null, 2));

        const requestId = payload.requestId;
        if (!requestId) {
            return res.status(400).json({ success: false, error: "Missing Nomba event unique requestId" });
        }

        // 1. Strict Idempotency Check (Global Edge protection block)
        const duplicateCheck = await pool.query(
            'SELECT request_id FROM processed_webhooks WHERE request_id = $1',
            [requestId]
        );

        if (duplicateCheck.rows.length > 0) {
            console.log(`Duplicate transaction event ignored gracefully: ${requestId}`);
            return res.status(200).json({ message: "Duplicate event ignored gracefully." });
        }

        // 2. Extract context attributes passed down by Nomba metadata structures
        // Defaulting to fallback parameters for initial setup configuration
        const merchantId = payload.data?.merchant?.userId || payload.merchantId; 
        const transactionRef = payload.data?.transaction?.transactionId || `ref_fallback_${Date.now()}`;
        const amountKobo = payload.data?.transaction?.amount || 0;

        if (!merchantId) {
            return res.status(400).json({ success: false, error: "Unable to parse multi-tenant identification key from metadata" });
        }

        // 3. Persist and process inside an isolated Row-Level Security transaction block
        await executeTenantQuery(merchantId, async (client) => {
            // Register transaction payload metadata within the unalterable billing ledger
            await client.query(
                `INSERT INTO billing_ledger (merchant_id, subscription_id, amount_kobo, entry_type, transaction_ref, status)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [
                    merchantId,
                    payload.subscriptionId || null, // Associates token tracking rows dynamically
                    amountKobo,
                    'CREDIT',
                    transactionRef,
                    payload.event === 'payment_success' ? 'SUCCESS' : 'FAILED'
                ]
            );

            // Log entry into the unique processed webhooks table to clear future deduplications
            await client.query(
                'INSERT INTO processed_webhooks (request_id) VALUES ($1)',
                [requestId]
            );
        });

        return res.status(200).json({ success: true, message: 'State recorded securely inside ledger.' });
    } catch (error: any) {
        console.error('Core Engine Error processing webhook:', error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Core Infrastructure Engine running natively on port ${PORT}`);
});