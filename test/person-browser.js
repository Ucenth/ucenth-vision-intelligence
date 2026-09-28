// Contextual person intelligence UI and voice hand-off, with explicit mocked model and cloud responses.
import { chromium } from "playwright";
import sharp from "sharp";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

const base = process.env.TEST_BASE_URL || "http://localhost:3000";
const artifact = "artifacts/person";
await mkdir(artifact, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const image = await sharp({ create: { width: 400, height: 500, channels: 3, background: "#5a6a7a" } }).jpeg().toBuffer();
const wav = Buffer.alloc(44 + 24000 * 0.3 * 2);
wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
const common = { provider: "gemini", status: "hypothesis", confidence: "high", brand: "", model: "",
  observations: ["Dark jacket", "Indoor stage lighting"], needsAnotherView: false, requestedView: "" };
const identified = { ...common, subjectType: "person", name: "Jensen Huang", category: "Human",
  identityEstablished: true, identityName: "Jensen Huang", identitySource: "page_context",
  identityEvidence: "Leadership card heading directly under the photograph reads Jensen Huang, President and CEO.",
  roleOrTitle: "President and CEO · NVIDIA", description: "A man in a dark jacket on a corporate leadership page.",
  conversationIntro: "I've identified the person shown here as Jensen Huang. What would you like to know about them?" };
const detected = { ...common, subjectType: "person", name: "Person", category: "Human", identityEstablished: false,
  identityName: "", identitySource: "none", identityEvidence: "", roleOrTitle: "",
  description: "A person standing indoors.",
  conversationIntro: "I can see a person in this image, but I don't have enough context to establish who they are. I can still tell you about what is visible." };
const object = { ...common, subjectType: "object", name: "Blue notebook", brand: "Not determined", category: "Notebook",
  description: "A synthetic fixture.", identityEstablished: false, identityName: "", identitySource: "none",
  identityEvidence: "", roleOrTitle: "", conversationIntro: "" };
try {
  const context = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(); const errors = [], speech = [], followUps = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem("ucenth-voice", "on");
    window.SpeechRecognition = class { start() {} abort() { this.onend?.(); } };
  });
  let identity = identified;
  await page.route("**/api/identify", (route) => route.fulfill({ json: identity }));
  await page.route("**/api/speech", (route) => { speech.push(route.request().postDataJSON().text); return route.fulfill({ contentType: "audio/wav", body: wav }); });
  await page.route("**/api/follow-up", (route) => {
    const body = route.request().postDataJSON(); followUps.push(body);
    return route.fulfill({ json: /this is /i.test(body.question)
      ? { answer: "Understood, I will use that name.", userSuppliedIdentity: "Jensen Huang" }
      : { answer: "A person stands indoors under stage lighting.", userSuppliedIdentity: "" } });
  });
  const upload = () => page.locator("#upload").setInputFiles({ name: "fixture.jpg", mimeType: "image/jpeg", buffer: image });
  const text = (selector) => page.locator(selector).first().textContent();
  const listening = () => page.waitForFunction(() => document.querySelector(".voice-panel")?.dataset.state === "LISTENING", null, { timeout: 20000 });
  await page.goto(base);
  await upload();
  await page.locator("#reset").waitFor();
  assert.equal(await text(".result-state"), "PERSON IDENTIFIED");
  assert.equal(await text(".identity-name"), "Jensen Huang");
  assert.equal(await text(".identity-role"), "President and CEO · NVIDIA");
  assert.equal(await text(".identity-basis"), "Identified from page context");
  assert.equal(await page.locator("#results dl").count(), 0);
  assert.match(await text(".identity-evidence"), /Leadership card heading/);
  assert.equal(await page.locator("#state-label").textContent(), "PERSON IDENTIFIED");
  await listening();
  assert.equal(speech[0], identified.conversationIntro);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.screenshot({ path: `${artifact}/identified-${width}.png`, fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no overflow at ${width}`);
    // Role and basis stay visible beside the conversation; details fold into the disclosure.
    assert.ok(await page.locator(".identity-role").isVisible());
    assert.ok(await page.locator(".identity-basis").isVisible());
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Pause microphone", exact: true }).click();
  await page.locator("#reset").click();
  identity = detected;
  await upload();
  await page.locator("#reset").waitFor();
  assert.equal(await text(".result-state"), "PERSON DETECTED");
  assert.equal(await text(".identity-name"), "Person");
  assert.equal(await page.locator(".identity-role").count(), 0);
  assert.equal(await text(".identity-basis"), "Identity not established from the available context.");
  assert.equal(await page.locator(".identity-evidence").count(), 0);
  await listening();
  assert.equal(speech[1], detected.conversationIntro);
  const type = async (question) => {
    await page.locator(".voice-typed").evaluate((n) => (n.open = true));
    await page.getByRole("textbox", { name: "Question about the scanned object" }).fill(question);
    await page.getByRole("button", { name: "Send" }).click();
    await page.waitForFunction(() => document.querySelector(".voice-panel")?.dataset.state !== "THINKING" && document.querySelector(".voice-answer")?.textContent, null, { timeout: 20000 });
  };
  await type("Describe the image.");
  assert.equal(followUps[0].identification.identityEstablished, false);
  assert.equal(followUps[0].identification.identitySource, "none");
  assert.equal(followUps[0].identification.identityName, "");
  await listening();
  await type("This is Jensen Huang.");
  await listening();
  await type("Where is he standing?");
  assert.equal(followUps[2].identification.identitySource, "user_context");
  assert.equal(followUps[2].identification.identityName, "Jensen Huang");
  assert.equal(followUps[2].identification.identityEstablished, false);
  assert.equal(await text(".identity-name"), "Person", "user context never rewrites the verified result");
  await page.screenshot({ path: `${artifact}/detected-1440.png`, fullPage: true });
  await listening();
  await page.getByRole("button", { name: "Pause microphone", exact: true }).click();
  await page.locator("#reset").click();
  identity = object;
  await upload();
  await page.locator("#reset").waitFor();
  assert.equal(await text(".result-state"), "LIKELY IDENTIFICATION");
  assert.equal(await text(".identity-name"), "Blue notebook");
  assert.equal(await page.locator("#results dl div").count(), 2);
  assert.equal(await page.locator(".identity-role, .identity-basis, .identity-evidence").count(), 0);
  await listening();
  assert.equal(speech.at(-1), "I've identified this as Blue notebook. What would you like to know about it?");
  await page.getByRole("button", { name: "End conversation", exact: true }).click();
  assert.deepEqual(errors, []);
  console.log("Person Chrome checks passed: identified/detected/object states, restrained basis line, evidence disclosure, intro hand-off to LISTENING, user-supplied context labelling, 1440/390 layout.");
} finally { await browser.close(); }
