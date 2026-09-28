// Opt-in real, billable contextual-person test against the running server.
// Fixtures are built at run time from openly licensed photographs and local HTML
// pages; downloads and screenshots stay in ignored artifacts/. Nothing else is saved.
import { chromium } from "playwright";
import sharp from "sharp";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";

const base = process.env.TEST_BASE_URL || "http://localhost:3000";
const dir = "artifacts/person-context";
await mkdir(dir, { recursive: true });
const commons = (file) => `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=900`;
const pexels = (id) => `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?w=1000`;
const sources = {
  huang: commons("Jensen Huang (cropped).jpg"), // Wikimedia Commons, CC BY-SA
  cook: commons("Tim Cook (2017, cropped).jpg"), // Wikimedia Commons, CC BY
  pair: commons("Josep Borrell with NVIDIA CEO and founder Jensen Huang (2024).jpg"), // Wikimedia Commons, CC BY
  unknown: pexels(7862615), // Pexels license
  holding: pexels(6976293), // Pexels license
  chair: pexels(7862491), // Pexels license
};
async function photo(name) {
  const file = `${dir}/${name}.jpg`;
  try {
    await access(file);
  } catch {
    const response = await fetch(sources[name], { headers: { "User-Agent": "UCENTH-Vision-Intelligence-test/1.0 (local development test)" } });
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(file, await sharp(bytes).resize({ width: 900, height: 900, fit: "inside" }).jpeg({ quality: 86 }).toBuffer());
  }
  return `data:image/jpeg;base64,${(await readFile(file)).toString("base64")}`;
}
const style = `<style>body{margin:0;background:#fff;color:#111;font-family:Georgia,serif;width:960px}header{padding:14px 40px;border-bottom:1px solid #ddd;font:600 14px/1.2 Arial,sans-serif;display:flex;gap:28px}main{padding:28px 40px}h1{font:700 30px/1.15 Arial,sans-serif;margin:0 0 14px}p{font-size:17px;line-height:1.55;max-width:60ch}.card{display:inline-block;width:240px;margin:8px 16px 8px 0;font:14px/1.4 Arial,sans-serif;vertical-align:top}.card img{width:240px;height:280px;object-fit:cover;display:block}.card b{display:block;font-size:17px;margin-top:8px}.byline{color:#666;font:13px Arial,sans-serif}figure{margin:0 0 18px;width:520px}figure img{width:520px;display:block}figcaption{font:13px/1.4 Arial,sans-serif;color:#444;margin-top:6px}</style>`;
const pages = {
  leadership: (h) => `${style}<header><span>Company</span><span>Products</span><span>Leadership</span><span>Newsroom</span></header><main><h1>Executive leadership</h1><div class="card"><img src="${h}"><b>Jensen Huang</b>President and CEO<br>NVIDIA</div></main>`,
  caption: (h) => `${style}<header><span>Technology</span><span>Markets</span></header><main><h1>Keynote closes the spring developer conference</h1><figure><img src="${h}"><figcaption>Jensen Huang, NVIDIA founder and CEO, speaking after the keynote. Photo: press pool.</figcaption></figure><p>The conference drew several thousand attendees over three days.</p></main>`,
  manyNames: (c) => `${style}<header><span>Business</span><span>Opinion</span></header><main><h1>Technology chiefs weigh in on the year ahead</h1><p class="byline">By Priya Raman · Staff writer</p><img src="${c}" style="width:360px;display:block;margin:0 0 16px"><p>Executives including Satya Nadella, Tim Cook, Sundar Pichai and Andy Jassy offered contrasting outlooks in interviews this week, while Lisa Su declined to comment.</p><p>Analysts said the remarks reflected caution rather than consensus.</p></main>`,
  group: (g) => `${style}<header><span>Newsroom</span></header><main><h1>Photo gallery: Brussels meetings, 2024</h1><img src="${g}" style="width:600px;display:block;margin:0 0 12px"><p>Participants in this week's meetings included Ursula von der Leyen, Jensen Huang, Josep Borrell and Margrethe Vestager, among others. Photographs are shown in no particular order.</p></main>`,
};
const shoot = async (browser, html, name) => {
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
  await page.setContent(html);
  await page.waitForLoadState("networkidle");
  const buffer = await page.screenshot({ type: "png", fullPage: true });
  await writeFile(`${dir}/${name}.png`, buffer);
  await page.close();
  return `data:image/png;base64,${buffer.toString("base64")}`;
};
const identify = async (image, attempt = 0) => {
  const response = await fetch(`${base}/api/identify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image }) });
  if (response.status === 429 && attempt < 2) {
    // The local server allows six billable identifications per minute; wait it out.
    await new Promise((r) => setTimeout(r, 61000));
    return identify(image, attempt + 1);
  }
  const result = await response.json();
  if (!response.ok && response.status >= 500 && attempt < 1) {
    // One retry for a transient upstream failure; the model itself is not re-rolled on a wrong answer.
    await new Promise((r) => setTimeout(r, 4000));
    return identify(image, attempt + 1);
  }
  if (!response.ok) throw new Error(result.error || "Identification failed.");
  return result;
};
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
let failures = 0;
try {
  const [huang, cook, pair, unknown, , chair] = await Promise.all(["huang", "cook", "pair", "unknown", "holding", "chair"].map(photo));
  const meta = await sharp(`${dir}/holding.jpg`).metadata();
  const closeHolding = `data:image/jpeg;base64,${(await sharp(`${dir}/holding.jpg`)
    .extract({ left: Math.round(meta.width * 0.32), top: Math.round(meta.height * 0.3), width: Math.round(meta.width * 0.42), height: Math.round(meta.height * 0.4) })
    .jpeg({ quality: 86 }).toBuffer()).toString("base64")}`;
  const cases = [
    ["1 leadership page with associated name/title", await shoot(browser, pages.leadership(huang), "leadership"), (r) => r.subjectType === "person" && r.identityEstablished && /jensen huang/i.test(r.identityName)],
    ["2 photograph with a direct caption", await shoot(browser, pages.caption(huang), "caption"), (r) => r.subjectType === "person" && r.identityEstablished && /jensen huang/i.test(r.identityName)],
    ["3 screenshot with several names and no caption", await shoot(browser, pages.manyNames(cook), "many-names"), (r) => r.subjectType === "person" && !r.identityEstablished && r.identityName === ""],
    ["4 standalone famous portrait without context", huang, (r) => r.subjectType === "person" && !r.identityEstablished && r.identityName === "" && !/huang|nvidia/i.test(JSON.stringify(r))],
    ["5 unknown person portrait", unknown, (r) => r.subjectType === "person" && !r.identityEstablished && r.identityName === ""],
    ["6 product clearly presented by a person", closeHolding, (r) => r.subjectType === "object" && !r.identityEstablished],
    ["7 two people with a list of names nearby", await shoot(browser, pages.group(pair), "group"), (r) => !r.identityEstablished && r.identityName === ""],
    ["8 non-person object (empty chair)", chair, (r) => r.subjectType === "object" && /chair/i.test(r.name) && !r.identityEstablished],
  ];
  for (const [label, image, expect] of cases) {
    const started = Date.now();
    try {
      const r = await identify(image);
      const ok = expect(r);
      if (!ok) failures++;
      results.push({ label, ok, name: r.name, subjectType: r.subjectType, identityEstablished: r.identityEstablished, identitySource: r.identitySource, roleOrTitle: r.roleOrTitle, elapsedMs: Date.now() - started });
      console.log(JSON.stringify(results.at(-1)));
    } catch (error) {
      failures++;
      console.log(JSON.stringify({ label, ok: false, error: error.message }));
    }
  }
} finally {
  await browser.close();
}
console.log(failures ? `Contextual person checks: ${failures} of 8 failed.` : "Contextual person checks passed: 8 of 8 real identifications behaved as specified.");
process.exit(failures ? 1 : 0);
