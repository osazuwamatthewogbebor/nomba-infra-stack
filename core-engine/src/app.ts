import express, { NextFunction, Request, Response } from "express";
import swaggerUi from "swagger-ui-express";
import { swaggerDocument } from "./utils/swaggerSpec";
import merchantRoutes from './routes/merchant';
import checkoutRouter from './routes/checkout';
import webhookRouter from './routes/webhook'; 
import pool from './utils/db';
import adminRouter from './routes/admin';

const app = express();
app.use(express.json());

// Serve Live UI Documentation Interactive Manual instantly with Cache-Control bypass
app.use('/api-docs', (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store'); // Tells Cloudflare explicitly not to cache
    next();
}, swaggerUi.serve, swaggerUi.setup(swaggerDocument));

app.use(
  '/api-docs',
  swaggerUi.serve,
  swaggerUi.setup(swaggerDocument, {
    swaggerOptions: { persistAuthorization: true },
    customSiteTitle: "Subflow Core Billing Docs Core"
  })
);

// Mount modular sub-routers
app.use('/v1', merchantRoutes);
app.use('/v1/checkout', checkoutRouter);
app.use('/v1/webhooks', webhookRouter);
app.use('/v1/admin', adminRouter);

app.get('/health', async (_req: Request, res: Response) => {
    try {
        await pool.query('SELECT 1');
        return res.status(200).json({ status: 'healthy', timeStamp: new Date() });
    } catch (error: any) {
        return res.status(500).json({ status: 'unhealthy', error: error.message });
    }
});

app.get('/', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'All systems GO', message: "Welcome to Subflow. Live docs available at /docs" })
});

export default app;