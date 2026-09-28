import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createGeminiDetector } from "../lib/gemini.js";
import { createServer } from "../server.js";

test("a fresh setup cannot silently use the developer cloud project", async () => {
  const previous = process.env.GOOGLE_CLOUD_PROJECT;
  delete process.env.GOOGLE_CLOUD_PROJECT;
  try {
    await assert.rejects(
      createGeminiDetector()(Buffer.from("unused"), "image/jpeg"),
      /project configuration/,
    );
  } finally {
    if (previous !== undefined) process.env.GOOGLE_CLOUD_PROJECT = previous;
  }
});

test("setup and license are public but captures and authentication are not", async () => {
  const server = createServer({ identify: async () => ({}) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of ["/how-to.html", "/how-to.css", "/how-to.js", "/setup.html", "/LICENSE"])
      assert.equal((await fetch(base + path)).status, 200);
    for (const path of [
      "/.env",
      "/.local/subjects/results.json",
      "/artifacts/photo.jpg",
      "/application_default_credentials.json",
      "/lib/identity-prompt.js",
    ])
      assert.equal((await fetch(base + path)).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the beginner guide links to real local sections and contains no fake repository link", async () => {
  const html = await readFile("how-to.html", "utf8");
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((x) => x[1]));
  for (const match of html.matchAll(/href="#([^"]+)"/g))
    assert.ok(ids.has(match[1]), match[1]);
  assert.ok(html.includes("git clone https://github.com/Ucenth/ucenth-vision-intelligence.git"));
  assert.ok(!/href="https:\/\/github.com\/YOUR/.test(html));
});
