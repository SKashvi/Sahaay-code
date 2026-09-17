const express = require('express');
const { validateBody } = require('../middleware/validate');
const { chatSchema } = require('../schemas');
const { chatLimiter } = require('../middleware/rateLimiters');
const { customerForSession } = require('../middleware/customerAuth');
const { isOwnUploadUrl } = require('../lib/storage');
const ai = require('../lib/ai');

const router = express.Router();

router.post('/', chatLimiter, validateBody(chatSchema), async (req, res, next) => {
  try {
    const { sessionId, message, attachmentUrl } = req.body;

    // Only photos this server issued are ever handed to the agent. An
    // attacker supplying an external URL gets rejected here, before the
    // model or any tool sees it.
    if (attachmentUrl && !isOwnUploadUrl(attachmentUrl)) {
      return res.status(400).json({ error: 'That photo could not be attached, please upload it again.' });
    }

    const customer = customerForSession(req, sessionId);

    const outcome = await ai.replyTo({
      sessionId,
      userMessage: message,
      attachmentUrl: attachmentUrl || null,
      customer,
    });

    res.json({
      reply: outcome.reply,
      blocks: outcome.blocks || [],
      verified: Boolean(customer),
      orderDisplayId: customer ? customer.orderDisplayId : null,
      // True when the model could not be reached at all. The widget uses it to
      // show a verified customer their order rather than an apology.
      degraded: Boolean(outcome.degraded),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
