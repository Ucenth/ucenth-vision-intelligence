/* Public document limits for the UCENTH-hosted service. Smaller than the educational
 * defaults because every analysis is billed to UCENTH's project. The page limit matters
 * as much as the byte limit: pages, not bytes, drive Gemini cost and latency. */
export const PUBLIC_LIMITS = {
  imageBytes: 2 * 1024 * 1024,
  pdfBytes: 5 * 1024 * 1024,
  docxBytes: 3 * 1024 * 1024,
  pages: 10,
  scannedPages: 5,
  textChars: 60000, // ~10 dense pages of extracted text
  translationChars: 9000, // first-pass translation; more on request in conversation
};
