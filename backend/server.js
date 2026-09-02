import express from 'express';
import cors from 'cors';
import * as dotenv from 'dotenv';
import { config } from './services/config/index.js';
import { errorHandler } from './api/middleware/error.middleware.js';

import simulateRoutes from './api/routes/simulate.routes.js';
import transactionsRoutes from './api/routes/transactions.routes.js';
import decisionsRoutes from './api/routes/decisions.routes.js';
import recoveryRoutes from './api/routes/recovery.routes.js';
import webhooksRoutes from './api/routes/webhooks.routes.js';

dotenv.config();

const app = express();

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());

// Health Check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: 'recoveriq-backend',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// API Routes
app.use('/api/simulate', simulateRoutes);
app.use('/api/transactions', transactionsRoutes);
app.use('/api/decisions', decisionsRoutes);
app.use('/api/recover', recoveryRoutes);
app.use('/api/webhooks', webhooksRoutes);

// Error Handling
app.use(errorHandler);

const PORT = config.port || 4000;

app.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(` RecoverIQ Backend API is running on port ${PORT}`);
  console.log(` Health: http://localhost:${PORT}/health`);
  console.log(`=========================================`);
});

export default app;
