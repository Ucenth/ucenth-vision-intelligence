/* Public document limits for the UCENTH-hosted service. Smaller than the educational
 * defaults because every analysis is billed to UCENTH's project. The page limit matters
 * as much as the byte limit: pages, not bytes, drive Gemini cost and latency. */
/* Per-instance guards for the hosted service. The educational defaults (one active
 * request, six per minute) protect a single developer's bill; here the visitor-level
 * allowance does that job, so the instance guards only cap what one Cloud Run instance
 * will run at once. Concurrency 8 matches the Cloud Run --concurrency setting; document
 * analysis is heavier (PDF parsing, image decoding) and gets a smaller share. */
export const HOSTED_GUARDS = {
  identify: { perMinute: 600, concurrent: 8 },
  followUp: { perMinute: 600, concurrent: 8 },
  speech: { perMinute: 600, concurrent: 8 },
  document: { perMinute: 300, concurrent: 4 },
};
export const PUBLIC_LIMITS = {
  imageBytes: 2 * 1024 * 1024,
  pdfBytes: 5 * 1024 * 1024,
  docxBytes: 3 * 1024 * 1024,
  pages: 10,
  scannedPages: 5,
  textChars: 60000, // ~10 dense pages of extracted text
  translationChars: 9000, // first-pass translation; more on request in conversation
};
