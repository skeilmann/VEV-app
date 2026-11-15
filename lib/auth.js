/**
 * Express middleware: requires "Authorization: Bearer <customer token>" and
 * sets req.customerId from the verified token. Routes must use req.customerId
 * and never a customer ID sent in the query or body.
 */

const { verifyCustomerToken } = require('./customerToken');

function requireCustomer(getSecret = () => process.env.CUSTOMER_TOKEN_SECRET) {
  return (req, res, next) => {
    const secret = getSecret();
    if (!secret) {
      console.error('CUSTOMER_TOKEN_SECRET is not configured; refusing customer requests');
      return res.status(503).json({ success: false, message: 'Service not configured' });
    }

    const header = req.get('Authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const customerId = verifyCustomerToken(token, secret);

    if (!customerId) {
      return res.status(401).json({ success: false, message: 'Invalid or expired customer token' });
    }

    req.customerId = customerId;
    next();
  };
}

module.exports = { requireCustomer };
