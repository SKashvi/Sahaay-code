/** Wraps a zod schema as Express middleware. On failure, responds 400 with
 * a plain list of field errors, never the raw request contents or a stack
 * trace. On success, replaces req.body with the parsed (and coerced,
 * trimmed) value so every downstream handler works with clean data. */
function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'Invalid request',
        details: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    req.body = result.data;
    next();
  };
}

module.exports = { validateBody };
