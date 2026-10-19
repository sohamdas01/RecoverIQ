import { Router } from 'express';
import { handleRazorpayWebhook } from '../controllers/webhooks.controller.js';

const router = Router();

// Per-merchant endpoint: the signature is verified with that merchant's webhook secret.
router.post('/razorpay/:merchantId', handleRazorpayWebhook);

export default router;
