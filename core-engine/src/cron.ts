import cron from 'node-cron';
import dotenv from 'dotenv';
import { executeRecurringBillingRun } from './workers/billingWorker';
import logger from './utils/logger';

dotenv.config();

logger.info('Background Cron Worker Process Initiated.');

// Triggers every day at 1:00 AM WAT (safely outside peak midnight banking strain)
cron.schedule('0 1 * * *', async () => {
    logger.info('--- Instigating Scheduled Subscription Billing Run ---');
    try {
        await executeRecurringBillingRun();
    } catch (err: any) {
        logger.error('Critical failure caught within automated billing cron lifecycle:', err.message);
    }
});