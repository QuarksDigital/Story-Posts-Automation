import { test } from "node:test";
import assert from "node:assert/strict";
import { sandbox, goodContent } from "./helpers.js";

sandbox();
const { loadBusiness } = await import("../src/config.js");
const { validateContent, similarity } = await import("../src/validate.js");
const { POST_TEMPLATES } = await import("../src/content.js");
const biz = loadBusiness("quarks");
const check = (c, opts = {}) => validateContent(c, biz, { allowedTemplates: POST_TEMPLATES, ...opts });
const hasError = (r, re) => r.errors.some((e) => re.test(e));

test("clean content passes", () => {
  const r = check(goodContent());
  assert.equal(r.ok, true, r.errors.join("\n"));
});

test("every fallback.json item passes validation", () => {
  for (const fb of biz.fallbacks) {
    const r = check(fb);
    assert.equal(r.ok, true, `${fb.topic}: ${r.errors.join("; ")}`);
  }
});

test("rejects a phone number that is not in the profile", () => {
  const r = check(goodContent({ caption: "Call us on +91 98765 43210 today." }));
  assert.ok(hasError(r, /phone number/));
});

test("rejects unknown URLs and emails, allows the real ones", () => {
  assert.ok(hasError(check(goodContent({ caption: "Visit quarks-agency.com now" })), /URL/));
  assert.ok(hasError(check(goodContent({ caption: "Mail hello@quarks.io" })), /email/));
  const ok = check(goodContent({ caption: "See www.quarksdigital.in or mail quarksdigitalmarketing@gmail.com" }));
  assert.equal(ok.ok, true, ok.errors.join("; "));
});

test("rejects invented prices, offers and statistics", () => {
  assert.ok(hasError(check(goodContent({ caption: "Websites from ₹9,999 only." })), /price/));
  assert.ok(hasError(check(goodContent({ caption: "Get a free audit this week." })), /offer/));
  assert.ok(hasError(check(goodContent({ post: { headline: "Boost traffic by 300%" } })), /statistic/));
  assert.ok(hasError(check(goodContent({ caption: "Clients see 3x more leads." })), /statistic/));
});

test("rejects banned phrases", () => {
  assert.ok(hasError(check(goodContent({ caption: "This is a game-changer for you." })), /banned phrase/));
});

test("auto-fixes em dashes, emojis, hashtags and business-name casing", () => {
  const r = check(
    goodContent({
      caption: "Fast sites win — every time \u{1F680}. Ask QUARKS DIGITAL. #inline",
      hashtags: ["#WebDesign", "web design", "webdesign", "SEO!"],
    })
  );
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.ok(!r.content.caption.includes("—"));
  assert.ok(!/\u{1F680}/u.test(r.content.caption));
  assert.ok(r.content.caption.includes("Quarks Digital"));
  assert.ok(!r.content.caption.includes("#inline"));
  assert.deepEqual(r.content.hashtags.slice(0, 2), ["webdesign", "seo"]);
  assert.ok(r.content.hashtags.length >= 3, "topped up to hashtags_min from pool");
});

test("rejects references to services/case studies that do not exist", () => {
  assert.ok(hasError(check(goodContent({ post: { template: "service_spotlight", service_id: "crypto" } })), /not a listed service/));
  assert.ok(hasError(check(goodContent({ post: { template: "case_study", case_id: "acme" } })), /not a listed case study/));
  assert.ok(hasError(check(goodContent({ post: { template: "testimonial", testimonial_index: 0 } })), /testimonial/));
});

test("rejects templates not allowed for the pillar", () => {
  const r = validateContent(goodContent({ post: { template: "question" } }), biz, { allowedTemplates: ["list", "tip"] });
  assert.ok(hasError(r, /not allowed/));
});

test("enforces length limits", () => {
  assert.ok(hasError(check(goodContent({ post: { headline: "x".repeat(120) } })), /headline is 120 chars/));
  assert.ok(hasError(check(goodContent({ caption: "word ".repeat(400) })), /caption is/));
});

test("blocks repeated topics and hooks from history", () => {
  const history = [{ date: "2026-09-20", topic: "Three checks before you redesign your website", hook: "x", headline: "y" }];
  assert.ok(hasError(check(goodContent(), { history }), /topic too similar/));
  assert.ok(similarity("5 website mistakes small businesses make", "Five website mistakes small businesses make") > 0.6);
  assert.ok(similarity("Why SEO takes time", "How to price a logo") < 0.2);
});

test("does not flag ordinary numbers or dates", () => {
  const r = check(goodContent({ caption: "5 steps, 3 weeks, done by 2026-10-30. Next.js and Three.js both work." }));
  assert.equal(r.ok, true, r.errors.join("; "));
});
