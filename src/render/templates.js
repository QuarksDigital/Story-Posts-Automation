// Brand templates as Satori element trees (flexbox CSS subset, no browser).
// Text that must be exact (service names, client names, testimonials, handle,
// website, logo) is always taken from the business profile, never from the AI.

const h = (type, style, ...children) => ({
  type,
  props: { style: { display: "flex", ...style }, children: children.flat().filter((c) => c !== null && c !== undefined && c !== false && c !== "") },
});
const text = (style, value) => ({ type: "div", props: { style: { display: "flex", ...style }, children: value } });
const img = (src, style) => ({ type: "img", props: { src, style, width: style.width, height: style.height } });

/** Bigger type for shorter lines. */
function fit(str, steps) {
  const n = (str || "").length;
  for (const [max, size] of steps) if (n <= max) return size;
  return steps[steps.length - 1][1];
}

function palette(brand, theme) {
  const c = brand.colors;
  return theme === "light"
    ? { bg: c.light_background, text: c.light_text, muted: c.light_muted, accent: c.light_accent, line: "rgba(11,12,15,0.14)", chip: "rgba(11,12,15,0.06)", glow: "rgba(11,126,160,0.10)", badge: c.light_text }
    : { bg: c.background, text: c.text, muted: c.muted, accent: c.accent, line: "rgba(241,240,236,0.14)", chip: "rgba(241,240,236,0.06)", glow: "rgba(58,219,255,0.16)", badge: c.surface };
}

// Which background each template uses. Fixed per template for consistency.
const THEME = { question: "light", myth_fact: "light", story_question: "light" };

function frame({ W, H, pad, p, ctx, eyebrow, children, footer = true }) {
  const { profile, logo } = ctx;
  return h(
    "div",
    {
      width: W,
      height: H,
      flexDirection: "column",
      backgroundColor: p.bg,
      backgroundImage: `radial-gradient(circle at 88% 6%, ${p.glow}, transparent 48%)`,
      color: p.text,
      fontFamily: profile.brand.font_family,
      padding: pad,
    },
    h(
      "div",
      { alignItems: "center", justifyContent: "space-between", width: "100%" },
      eyebrow ? text({ fontSize: 26, fontWeight: 600, letterSpacing: 5, color: p.accent, textTransform: "uppercase" }, eyebrow) : h("div", {}),
      text({ fontSize: 24, fontWeight: 500, letterSpacing: 2, color: p.muted }, profile.website.replace(/^https?:\/\/(www\.)?/, ""))
    ),
    h("div", { flexDirection: "column", flexGrow: 1, justifyContent: "center", width: "100%" }, children),
    footer &&
      h(
        "div",
        { alignItems: "center", justifyContent: "space-between", width: "100%", borderTop: `2px solid ${p.line}`, paddingTop: 36 },
        h(
          "div",
          { alignItems: "center" },
          // the mark is white, so it always sits on a dark badge (visible on light themes too)
          h("div", { width: 64, height: 64, borderRadius: 16, backgroundColor: p.badge, alignItems: "center", justifyContent: "center" }, img(logo, { width: 64, height: 64, borderRadius: 16 })),
          text({ fontSize: 30, fontWeight: 700, letterSpacing: 7, marginLeft: 22 }, profile.display_name || profile.business_name)
        ),
        text({ fontSize: 26, fontWeight: 500, color: p.muted }, `@${profile.instagram_handle}`)
      )
  );
}

const rule = (p, mt = 44, mb = 40) => h("div", { width: 96, height: 6, backgroundColor: p.accent, marginTop: mt, marginBottom: mb, borderRadius: 3 });
const chip = (p, label) =>
  text({ fontSize: 28, fontWeight: 500, padding: "14px 26px", borderRadius: 40, border: `2px solid ${p.line}`, backgroundColor: p.chip, marginRight: 16, marginBottom: 16 }, label);

// ---------------- feed posts (1080 x 1350) ----------------

const POST = {
  tip(f, p) {
    return [
      text({ fontSize: fit(f.headline, [[28, 104], [48, 90], [70, 78], [999, 66]]), fontWeight: 700, lineHeight: 1.05, letterSpacing: -2 }, f.headline),
      f.subtext && rule(p),
      f.subtext && text({ fontSize: 38, lineHeight: 1.4, color: p.muted, maxWidth: 860 }, f.subtext),
    ];
  },

  list(f, p) {
    return [
      text({ fontSize: fit(f.headline, [[34, 80], [60, 68], [999, 58]]), fontWeight: 700, lineHeight: 1.08, letterSpacing: -1.5, marginBottom: 44 }, f.headline),
      h(
        "div",
        { flexDirection: "column", width: "100%" },
        f.points.map((pt, i) =>
          h(
            "div",
            { alignItems: "flex-start", width: "100%", paddingTop: 24, paddingBottom: 24, borderTop: `2px solid ${p.line}` },
            text({ fontSize: 30, fontWeight: 600, color: p.accent, width: 76, paddingTop: 4, letterSpacing: 1 }, String(i + 1).padStart(2, "0")),
            text({ fontSize: f.points.length > 4 ? 34 : 38, fontWeight: 500, lineHeight: 1.3, flex: 1 }, pt)
          )
        )
      ),
    ];
  },

  service_spotlight(f, p, ctx) {
    const svc = ctx.profile.services.find((s) => s.id === f.service_id);
    const chips = (f.points?.length ? f.points : svc.points).slice(0, 4);
    return [
      text({ fontSize: 34, fontWeight: 600, color: p.accent, marginBottom: 28 }, svc.name),
      text({ fontSize: fit(f.headline, [[34, 92], [60, 78], [999, 64]]), fontWeight: 700, lineHeight: 1.06, letterSpacing: -2 }, f.headline),
      f.subtext && text({ fontSize: 36, lineHeight: 1.4, color: p.muted, marginTop: 36, maxWidth: 880 }, f.subtext),
      h("div", { flexWrap: "wrap", marginTop: 52 }, chips.map((c) => chip(p, c))),
    ];
  },

  question(f, p) {
    return [
      text({ fontSize: 220, fontWeight: 700, color: p.accent, lineHeight: 0.9, marginBottom: 20 }, "?"),
      text({ fontSize: fit(f.headline, [[40, 92], [70, 76], [999, 64]]), fontWeight: 700, lineHeight: 1.08, letterSpacing: -2 }, f.headline),
      f.subtext && text({ fontSize: 36, color: p.muted, marginTop: 40 }, f.subtext),
    ];
  },

  insight(f, p) {
    return [
      text({ fontSize: 200, fontWeight: 700, color: p.accent, lineHeight: 0.6, height: 110 }, "“"),
      text({ fontSize: fit(f.headline, [[40, 88], [70, 74], [999, 62]]), fontWeight: 600, lineHeight: 1.12, letterSpacing: -1.5 }, f.headline),
      f.subtext && rule(p),
      f.subtext && text({ fontSize: 36, lineHeight: 1.4, color: p.muted, maxWidth: 860 }, f.subtext),
    ];
  },

  myth_fact(f, p) {
    const block = (label, body, strong) =>
      h(
        "div",
        { flexDirection: "column", width: "100%", padding: "40px 44px", borderRadius: 28, backgroundColor: strong ? p.text : p.chip, marginBottom: 28 },
        text({ fontSize: 26, fontWeight: 700, letterSpacing: 6, color: strong ? p.bg : p.muted, marginBottom: 18 }, label),
        text({ fontSize: fit(body, [[60, 50], [110, 42], [999, 38]]), fontWeight: strong ? 600 : 500, lineHeight: 1.28, color: strong ? p.bg : p.text }, body)
      );
    return [
      f.headline && text({ fontSize: 56, fontWeight: 700, letterSpacing: -1, marginBottom: 44 }, f.headline),
      block("MYTH", f.myth, false),
      block("FACT", f.fact, true),
    ];
  },

  case_study(f, p, ctx) {
    const cs = ctx.profile.case_studies.find((c) => c.id === f.case_id);
    return [
      text({ fontSize: 28, fontWeight: 600, letterSpacing: 4, color: p.muted, marginBottom: 20, textTransform: "uppercase" }, cs.sector),
      text({ fontSize: fit(cs.name, [[8, 150], [14, 120], [999, 92]]), fontWeight: 700, letterSpacing: -3, lineHeight: 1 }, cs.name),
      rule(p),
      text({ fontSize: fit(f.headline, [[50, 54], [999, 46]]), fontWeight: 500, lineHeight: 1.25, maxWidth: 880 }, f.headline),
      h("div", { flexWrap: "wrap", marginTop: 48 }, cs.delivered.slice(0, 4).map((d) => chip(p, d))),
      ...(cs.verified_results || []).slice(0, 3).map((r) => text({ fontSize: 34, fontWeight: 600, color: p.accent, marginTop: 8 }, r)),
    ];
  },

  testimonial(f, p, ctx) {
    const t = ctx.profile.testimonials[f.testimonial_index];
    return [
      f.headline && text({ fontSize: 28, fontWeight: 600, letterSpacing: 4, color: p.muted, marginBottom: 28, textTransform: "uppercase" }, f.headline),
      text({ fontSize: fit(t.quote, [[80, 64], [160, 52], [999, 42]]), fontWeight: 500, lineHeight: 1.3 }, `“${t.quote}”`),
      rule(p),
      text({ fontSize: 34, fontWeight: 700 }, t.author),
      t.role && text({ fontSize: 28, color: p.muted, marginTop: 8 }, t.role),
    ];
  },
};

// ---------------- stories (1080 x 1920) ----------------
// Instagram overlays UI on the top ~250px and bottom ~300px; content stays clear.

const STORY = {
  story_question(f, p) {
    return [
      text({ fontSize: 260, fontWeight: 700, color: p.accent, lineHeight: 0.9, marginBottom: 30 }, "?"),
      text({ fontSize: fit(f.text, [[40, 116], [80, 96], [999, 80]]), fontWeight: 700, lineHeight: 1.08, letterSpacing: -2 }, f.text),
      f.subtext && text({ fontSize: 42, color: p.muted, marginTop: 48, lineHeight: 1.35 }, f.subtext),
    ];
  },
  story_tip(f, p) {
    return [
      text({ fontSize: 34, fontWeight: 600, letterSpacing: 6, color: p.accent, marginBottom: 40 }, "QUICK TIP"),
      text({ fontSize: fit(f.text, [[40, 116], [80, 96], [999, 80]]), fontWeight: 700, lineHeight: 1.08, letterSpacing: -2 }, f.text),
      f.subtext && rule(p, 56, 48),
      f.subtext && text({ fontSize: 44, color: p.muted, lineHeight: 1.35 }, f.subtext),
    ];
  },
  story_cta(f, p, ctx) {
    return [
      text({ fontSize: fit(f.text, [[40, 116], [80, 96], [999, 80]]), fontWeight: 700, lineHeight: 1.08, letterSpacing: -2 }, f.text),
      f.subtext && text({ fontSize: 44, color: p.muted, marginTop: 44, lineHeight: 1.35 }, f.subtext),
      h(
        "div",
        { marginTop: 72, alignSelf: "flex-start", backgroundColor: p.accent, color: p.bg, borderRadius: 60, padding: "28px 52px" },
        text({ fontSize: 42, fontWeight: 700 }, f.cta || `DM @${ctx.profile.instagram_handle}`)
      ),
    ];
  },
};

export function buildElement(templateName, fields, ctx) {
  const isStory = templateName.startsWith("story_");
  const W = 1080;
  const H = isStory ? 1920 : 1350;
  const p = palette(ctx.profile.brand, THEME[templateName] || "dark");
  const fn = (isStory ? STORY : POST)[templateName];
  if (!fn) throw new Error(`No template named "${templateName}"`);
  return frame({
    W,
    H,
    pad: isStory ? "260px 96px 320px" : "80px 88px 72px",
    p,
    ctx,
    eyebrow: isStory ? null : fields.eyebrow,
    children: fn(fields, p, ctx),
  });
}
