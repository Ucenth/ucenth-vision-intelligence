import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { createServer } from "../server.js";
import { StabilityTracker } from "../lib/stability.js";

const empty = new Uint8Array(100).fill(80);
const object = Uint8Array.from({ length: 100 }, (_, i) => (i % 2 ? 190 : 30));
test("empty background never captures; stable introduced object counts 3,2,1", () => {
  const tracker = new StabilityTracker();
  for (let t = 0; t < 5000; t += 100)
    assert.notEqual(tracker.update(empty, t).state, "capture");
  const states = [];
  for (let t = 5000; t < 9000; t += 100) states.push(tracker.update(object, t));
  assert.deepEqual(
    [...new Set(states.map((s) => s.remaining).filter(Boolean))],
    [3, 2, 1],
  );
  assert.ok(states.some((s) => s.state === "capture"));
});
test("movement and removal cancel countdown", () => {
  const tracker = new StabilityTracker();
  for (let t = 0; t < 1500; t += 100) tracker.update(empty, t);
  for (let t = 1500; t < 3200; t += 100) tracker.update(object, t);
  assert.ok(tracker.countdownAt !== null);
  const result = tracker.update(empty, 3200);
  assert.equal(result.cancelled, true);
  assert.equal(result.state, "waiting");
});

async function withServer(identify, run) {
  const server = createServer({ identify });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}
const picture = async () =>
  `data:image/jpeg;base64,${(
    await sharp({
      create: { width: 100, height: 100, channels: 3, background: "#5577bb" },
    })
      .jpeg()
      .toBuffer()
  ).toString("base64")}`;
const post = (base, payload, extra = {}) =>
  fetch(`${base}/api/identify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extra },
    body: JSON.stringify(payload),
  });
test("backend validates decoded images and never serves credentials", async () => {
  let calls = 0;
  await withServer(
    async () => {
      calls++;
      return { name: "Example body lotion" };
    },
    async (base) => {
      for (const path of [
        "/.env",
        "/server.js",
        "/package.json",
        "/.git/config",
        "/artifacts/private.jpg",
        "/captures/image.png",
        "/lib/gemini.js",
      ])
        assert.equal((await fetch(base + path)).status, 404);
      assert.equal((await post(base, { image: "bad" })).status, 400);
      assert.equal(
        (await post(base, { image: "data:image/jpeg;base64,YWJjZA==" })).status,
        400,
      );
      assert.equal(
        (
          await post(
            base,
            { image: await picture() },
            { Origin: "https://evil.example" },
          )
        ).status,
        403,
      );
      assert.equal(calls, 0);
      const response = await post(base, { image: await picture() });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).name, "Example body lotion");
      assert.equal(calls, 1);
    },
  );
});
test("backend serializes calls and caps billable attempts", async () => {
  let release;
  const pending = new Promise((r) => (release = r));
  let calls = 0;
  await withServer(
    async () => {
      calls++;
      if (calls === 1) await pending;
      return {};
    },
    async (base) => {
      const image = await picture();
      const first = post(base, { image });
      while (!calls) await new Promise((r) => setTimeout(r, 10));
      assert.equal((await post(base, { image })).status, 409);
      release();
      await first;
      for (let i = 0; i < 5; i++)
        assert.equal((await post(base, { image })).status, 200);
      assert.equal((await post(base, { image })).status, 429);
      assert.equal(calls, 6);
    },
  );
});
test("quota and credential failures are safe human-readable errors", async () => {
  for (const [code, status] of [
    [8, 429],
    [16, 503],
    [14, 502],
  ])
    await withServer(
      async () => {
        throw Object.assign(new Error("SECRET must never appear"), { code });
      },
      async (base) => {
        const response = await post(base, { image: await picture() });
        assert.equal(response.status, status);
        assert.ok(!(await response.text()).includes("SECRET"));
      },
    );
});
