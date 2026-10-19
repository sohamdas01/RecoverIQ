import { getRecentTransactions, getTransactionById } from '../../db/queries/transactions.queries.js';
import { getMessagesByTransactionId } from '../../db/queries/messages.queries.js';
import { parseLimit, merchantScope } from '../utils/http.js';

export async function listTransactions(req, res, next) {
  try {
    const limit = parseLimit(req.query.limit);
    const transactions = await getRecentTransactions(limit, merchantScope(req));
    return res.status(200).json({
      success: true,
      count: transactions.length,
      data: transactions,
    });
  } catch (error) {
    next(error);
  }
}

export async function getTransaction(req, res, next) {
  try {
    const { id } = req.params;
    // Another merchant's transaction id reads as "not found" (no existence leak)
    const tx = await getTransactionById(id, merchantScope(req));
    if (!tx) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }
    const messages = await getMessagesByTransactionId(id);
    return res.status(200).json({
      success: true,
      data: {
        ...tx,
        messages,
      },
    });
  } catch (error) {
    next(error);
  }
}
