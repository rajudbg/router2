export function validateApiKey(req, res, next) {
  const authHeader = req.headers.authorization;
  const configuredKey = process.env.ROUTER_API_KEY;

  if (!configuredKey) {
    return res.status(500).json({
      error: "Server misconfiguration: missing ROUTER_API_KEY"
    });
  }

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Invalid API key" });
  }

  const providedKey = authHeader.slice("Bearer ".length).trim();
  if (!providedKey || providedKey !== configuredKey) {
    return res.status(401).json({ error: "Invalid API key" });
  }

  return next();
}
