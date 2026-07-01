import app from './app';
import dotenv from 'dotenv';
import logger from './utils/logger';

dotenv.config();

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    logger.info(`Core Infrastructure Engine running natively on port ${PORT}`);
});