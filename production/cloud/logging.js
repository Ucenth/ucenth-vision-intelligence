/* Operational logging as one JSON object per line, which Cloud Logging indexes.
 * Only reliability data is logged: route, status, latency, broad request type, quota
 * decision and error category. Never document text, images, transcripts, prompts,
 * synthesized text, cookies or tokens. */
export function logEvent(fields) {
  const line = { time: new Date().toISOString(), ...fields };
  const level = fields.status >= 500 ? "ERROR" : fields.status >= 400 ? "WARNING" : "INFO";
  process.stdout.write(JSON.stringify({ severity: level, ...line }) + "\n");
}
export function requestType(pathname) {
  return {
    "/api/identify": "identify",
    "/api/document": "document",
    "/api/follow-up": "follow-up",
    "/api/speech": "speech",
    "/api/quota": "quota",
    "/health": "health",
  }[pathname] || (pathname.startsWith("/download/") ? "download" : "static");
}
