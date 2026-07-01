import { Router, Request, Response } from 'express';
import { executeRecurringBillingRun } from '../workers/billingWorker';
import logger from '../utils/logger';

const router = Router();

/**
 * POST /v1/admin/trigger-billing
 * Explicit manual trigger for testing the subscription renewal process
 */
router.post('/trigger-billing', async (req: Request, res: Response) => {
    try {
        // Basic static header guard for simple environment authorization
        const adminSecret = req.headers['x-admin-secret'];
        if (!adminSecret || adminSecret !== process.env.ADMIN_TRIGGER_SECRET) {
            return res.status(401).json({ success: false, error: 'Unauthorized manual execution attempt.' });
        }

        logger.info('⚠️ Manual subscription renewal run triggered via admin endpoint.');
        
        // Run the background worker logic asynchronously so the HTTP request doesn't timeout
        executeRecurringBillingRun()
            .then(() => logger.info('Manual billing execution run completed successfully.'))
            .catch((err) => logger.error('Manual billing execution run failed:', err.message));

        return res.status(202).json({
            success: true,
            message: 'Billing worker run pipeline initiated in the background. Check systems logs for progress.'
        });

    } catch (error: any) {
        logger.error('Admin billing trigger execution error:', error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
});

export default router;