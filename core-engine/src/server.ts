import express, { Request, Response } from "express";
import { createClient } from "@supabase/supabase-js";
import dotenv from 'dotenv';
import ws from 'ws'

dotenv.config();

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false
  },
  global: {
    headers: { 'x-my-custom-header': 'nomba-infra' },
  },
  realtime: {
    transport: ws as any,
  },
});

app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({status: 'healthy', timeStamp: new Date()});
});

app.post('/webhook', async (req: Request, res: Response) => {
    try {
        const payload = req.body;

        console.log('--- Received Webhook Payload frm Proxy ---');
        console.log(JSON.stringify(payload, null, 2));

        const { data, error } = await supabase
            .from('webhook_logs')
            .insert([
                {
                    event_type: payload.event || 'unknown',
                    payload: payload,
                    status: 'processed'
                }
            ]);
        if (error) throw error;

        res.status(200).json({ success: true, message: 'State recorded successfully'});
    } catch (error: any) {
        console.error('Core Engine Error processing webhook:', error.message);
        res.status(500).json({success: false, error: error.message});
    }
});

app.listen(PORT, () => {
    console.log(`Core Infrastructure Engine running natively on port ${PORT}`);
});

