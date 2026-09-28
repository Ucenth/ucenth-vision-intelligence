/* Prepares the downloadable educational source release.
 *
 * 1. Runs the targeted secret scan (release-check.js) and aborts on any finding.
 * 2. Copies ONLY the explicit allowlist in release-files.js into release/ucenth-vision-intelligence.
 *    Private folders (.local, artifacts, captures), .env, node_modules and caches can
 *    never hitch a ride because they are not on the list.
 * 3. Writes release/ucenth-vision-intelligence-source.zip from that same list, so UCENTH's website
 *    can offer "Download Source Code" with exactly the reviewed files inside.
 *
 * Nothing is published by this script. GitHub remains the canonical repository. */
import { copyFile, mkdir, access, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import JSZip from "jszip";
import { files } from "./release-files.js";
import "./release-check.js";

// Refuse to merge into an old directory: stale private files must never hitch a ride.
const destination = "release/ucenth-vision-intelligence";
try {
  await access(destination);
  throw new Error(
    "Release folder already exists. Move it aside before preparing another release.",
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const zip = new JSZip();
for (const file of files) {
  const target = join(destination, file);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(file, target);
  zip.file(`ucenth-vision-intelligence/${file}`, await readFile(file));
}
const archive = await zip.generateAsync({
  type: "nodebuffer",
  compression: "DEFLATE",
  compressionOptions: { level: 9 },
});
await writeFile("release/ucenth-vision-intelligence-source.zip", archive);
console.log(
  `Prepared ${files.length} source files in ${destination} and release/ucenth-vision-intelligence-source.zip (${Math.round(archive.length / 1024)} KB). Nothing was published.`,
);
