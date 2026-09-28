// Opt-in real, billable test. Supply your own image; nothing is saved to disk.
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
const file = process.argv[2];
if (!file) {
  console.error(
    "Usage: npm run test:real -- path/to/image.jpg (server must be running)",
  );
  process.exit(1);
}
const mime = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
}[extname(file).toLowerCase()];
if (!mime) throw new Error("Use JPEG or PNG.");
const bytes = await readFile(file);
if (bytes.length > 2 * 1024 * 1024)
  throw new Error("Image must be smaller than 2 MB.");
const response = await fetch("http://localhost:3000/api/identify", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    image: `data:${mime};base64,${bytes.toString("base64")}`,
  }),
});
const result = await response.json();
if (!response.ok) throw new Error(result.error || "Identification failed.");
console.log(
  JSON.stringify({
    name: result.name,
    status: result.status,
    elapsedMs: result.elapsedMs,
  }),
);
