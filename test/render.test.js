import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import sharp from "sharp";
import { sandbox } from "./helpers.js";

const { dir } = sandbox();
const { loadBusiness } = await import("../src/config.js");
const { renderCreative } = await import("../src/render/index.js");
const { validateImage } = await import("../src/validate.js");
const biz = loadBusiness("quarks");

const CASES = {
  tip: { eyebrow: "TIP", headline: "Short headline", subtext: "Support line." },
  list: { eyebrow: "LIST", headline: "A list", points: ["One", "Two", "Three", "Four", "Five"] },
  service_spotlight: { eyebrow: "SERVICE", service_id: "seo", headline: "Get found", points: [] },
  question: { eyebrow: "Q", headline: "What would you automate first?", subtext: "" },
  insight: { eyebrow: "INSIGHT", headline: "A sharp statement about distribution.", subtext: "Why it matters." },
  myth_fact: { eyebrow: "MYTH", headline: "Myth vs fact", myth: "A belief.", fact: "The correction." },
  case_study: { eyebrow: "CASE", case_id: "mosaram", headline: "A launch built backwards from the showroom floor." },
  testimonial: { eyebrow: "", headline: "Client words", testimonial_index: 0 },
  story_question: { text: "A question?", subtext: "" },
  story_tip: { text: "A tip.", subtext: "More." },
  story_cta: { text: "Need help?", subtext: "", cta: "DM us" },
};

// testimonial template needs a listed testimonial
biz.profile.testimonials = [{ quote: "They shipped the site and the marketing together.", author: "Test Client", role: "Founder" }];

for (const [template, fields] of Object.entries(CASES)) {
  test(`renders ${template} as an Instagram-ready JPEG`, async () => {
    const type = template.startsWith("story_") ? "story" : "post";
    const file = await renderCreative(biz, { template, fields, date: "2026-10-01", type, outFile: path.join(dir, `${template}.jpg`) });
    const v = await validateImage(file, type);
    assert.equal(v.ok, true, v.errors.join("; "));
    assert.ok(v.bytes < 1_000_000, `small file (${v.bytes} bytes)`);
  });
}

test("handles worst-case long text without throwing", async () => {
  const long = "Long words that keep going and going to stress wrapping ".repeat(3).slice(0, 90);
  const file = await renderCreative(biz, { template: "list", fields: { eyebrow: "X".repeat(28), headline: long, points: Array(5).fill("y".repeat(70)) }, date: "x", type: "post", outFile: path.join(dir, "long.jpg") });
  assert.equal((await validateImage(file, "post")).ok, true);
});

test("validateImage rejects wrong size and wrong format", async () => {
  const png = path.join(dir, "bad.png");
  await sharp({ create: { width: 1000, height: 1000, channels: 3, background: "#fff" } }).png().toFile(png);
  const v = await validateImage(png, "post");
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /JPEG/.test(e)));
  assert.ok(v.errors.some((e) => /1000x1000/.test(e)));
  assert.equal((await validateImage(path.join(dir, "missing.jpg"), "post")).ok, false);
});

test("unknown template is an error, not a blank image", async () => {
  await assert.rejects(renderCreative(biz, { template: "nope", fields: {}, date: "x", type: "post" }), /No template/);
});
