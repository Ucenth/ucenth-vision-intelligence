import { readFile } from "node:fs/promises";
import { files } from "./release-files.js";
import { checkHowTo, formatReport } from "./how-to-sync.js";

// Report names and categories only, never matching values. This is a targeted
// secret scan, not a guarantee that arbitrary secrets can always be detected.
const patterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["Google access token", /ya29\.[A-Za-z0-9_-]{20,}/],
  ["Google API key", /AIza[A-Za-z0-9_-]{30,}/],
  [
    "credential JSON",
    /"(?:private_key|refresh_token|client_secret)"\s*:\s*"[^"\s]+/,
  ],
  [
    "personal path",
    /(?:[A-Z]:[\\/]Users[\\/]|\/Users\/|\/home\/)[A-Za-z0-9_.-]+[\\/]/,
  ],
];
let findings = 0;
for (const file of files) {
  const buffer = await readFile(file);
  if (file.endsWith(".png")) continue;
  const text = buffer.toString("utf8");
  for (const [label, pattern] of patterns)
    if (pattern.test(text)) {
      console.error(`${file}: possible ${label}`);
      findings++;
    }
}
const ignore = await readFile(".gitignore", "utf8");
for (const entry of [
  ".env",
  "node_modules/",
  "artifacts/",
  ".local/",
  "benchmark/",
]) {
  if (!ignore.split(/\r?\n/).includes(entry)) {
    console.error(`Missing ignore: ${entry}`);
    findings++;
  }
}
// The How To guide's real-source excerpts must match the marked regions in the code.
const drift = checkHowTo();
if (drift.length) {
  console.error(formatReport(drift));
  findings += drift.length;
}
if (findings) process.exit(1);
console.log(
  `Release scan passed: ${files.length} explicitly listed files; no targeted secret patterns found.`,
);
