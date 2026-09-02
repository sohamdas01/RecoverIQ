import { getRecentTransactions, getTransactionById } from '../../db/queries/transactions.queries.js';
import { getMessagesByTransactionId } from '../../db/queries/messages.queries.js';

export async function listTransactions(req, res, next) {
  try {
    const limit = parseInt(req.query.limit || '50', 10);
    const transactions = await getRecentTransactions(limit);
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
    const tx = await getTransactionById(id);
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
