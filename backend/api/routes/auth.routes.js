import { Router } from 'express';
import { login, me } from '../controllers/auth.controller.js';
import { requireMerchantAuth } from '../middleware/auth.middleware.js';

const router = Router();

// POST /api/auth/login  — email + password -> access token
router.post('/login', login);

// GET /api/auth/me — current principal (also validates the stored token)
router.get('/me', requireMerchantAuth, me);

export default router;
