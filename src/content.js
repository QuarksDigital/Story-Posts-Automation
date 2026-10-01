// The one-call-per-day content contract: schema, prompt, and caption assembly.
import { z } from "zod";

export const POST_TEMPLATES = ["tip", "list", "service_spotlight", "question", "insight", "myth_fact", "case_study", "testimonial"];
export const STORY_TEMPLATES = ["story_question", "story_tip", "story_cta"];

// Field limits live here (not in the JSON schema) so the validator can report
// them precisely and ask for one corrected retry.
export const LIMITS = {
  eyebrow: 28,
  headline: 90,
  subtext: 170,
  point: 70,
  points_max: 5,
  myth: 110,
  fact: 140,
  story_text: 110,
  story_subtext: 90,
  story_cta: 40,
};

export const ContentSchema = z.object({
  content_pillar: z.string(),
  topic: z.string().describe("One specific topic, phrased as a short title"),
  angle: z.string(),
  hook: z.string().describe("First line of the caption; must stop the scroll"),
  visual_concept: z.string().describe("One line describing the layout idea"),
  post: z.object({
    template: z.enum(POST_TEMPLATES),
    eyebrow: z.string().describe("Tiny label above the headline, e.g. 'WEBSITE CHECK'"),
    headline: z.string(),
    subtext: z.string().describe("Supporting line, or empty string"),
    points: z.array(z.string()).describe("Only for list / service_spotlight; otherwise empty array"),
    service_id: z.string().describe("Only for service_spotlight: an id from services; otherwise empty"),
    case_id: z.string().describe("Only for case_study: an id from case_studies; otherwise empty"),
    testimonial_index: z.number().int().describe("Only for testimonial: index into testimonials; otherwise -1"),
    myth: z.string().describe("Only for myth_fact; otherwise empty"),
    fact: z.string().describe("Only for myth_fact; otherwise empty"),
  }),
  caption: z.string().describe("Full caption WITHOUT hashtags"),
  hashtags: z.array(z.string()),
  cta: z.string(),
  story: z.object({
    template: z.enum(STORY_TEMPLATES),
    text: z.string(),
    subtext: z.string().describe("Optional second line, or empty"),
    cta: z.string().describe("Short call to action, or empty"),
  }),
});

const TEMPLATE_GUIDE = {
  tip: "One practical tip. headline = the tip in <= 10 words, subtext = why it matters.",
  list: "Numbered list (mistakes, checklist, steps). headline = list title, points = 3-5 short items.",
  service_spotlight: "Explain ONE listed service. Set service_id. headline = the problem it solves (not the service name; the name is printed from the profile). points = up to 3 benefits.",
  question: "A question to the audience. headline = the question, subtext = context or 'Tell us in the comments'.",
  insight: "A sharp opinion/insight statement. headline = the statement, subtext = one line of reasoning.",
  myth_fact: "Debunk a common belief. myth = the belief, fact = the correction. headline can be a short title.",
  case_study: "About a LISTED case study only. Set case_id. headline = the problem the project solved or what was delivered. Never invent numbers; client name/sector/deliverables are printed from the profile.",
  testimonial: "ONLY if testimonials is non-empty. Set testimonial_index. The quote is printed verbatim from the profile; headline is a short lead-in.",
  story_question: "Story with one question. text = the question.",
  story_tip: "Story with one quick tip. text = the tip.",
  story_cta: "Story with a soft call to action. text = the line, cta = e.g. 'DM us'.",
};

/** Builds the system + user prompt for the day's single LLM call. */
export function buildPrompt({ biz, date, weekday, pillar, history, avoid = [], feedback = [] }) {
  const { profile, strategy } = biz;
  const rules = profile.content_rules || {};
  const pillarCfg = strategy.pillars[pillar] || {};
  let allowedTemplates = pillarCfg.templates?.length ? pillarCfg.templates : POST_TEMPLATES;
  if (!profile.testimonials?.length) allowedTemplates = allowedTemplates.filter((t) => t !== "testimonial");
  if (!profile.case_studies?.length) allowedTemplates = allowedTemplates.filter((t) => t !== "case_study");
  if (!allowedTemplates.length) allowedTemplates = ["tip", "list", "insight"];

  const system = [
    `You write the daily Instagram feed post and story for ${profile.business_name}, in the business's own voice.`,
    "You never invent facts. Phone numbers, URLs, emails, addresses, prices, offers, discounts, statistics, percentages, client results and testimonials may appear ONLY if they are present verbatim in the business profile you are given. When unsure, leave it out.",
    "Write useful, specific content a small-business owner can act on. No generic motivational lines, no hype, no filler.",
    rules.use_emojis ? "Emojis are allowed but use at most two." : "Do not use emojis anywhere.",
    rules.use_em_dash ? "" : "Never use the em dash character (—) or en dash (–). Use a comma, colon, period or ' - ' instead.",
    rules.avoid_hard_selling ? "Avoid hard selling. The CTA should be a low-pressure next step." : "",
    rules.allow_statistics ? "" : "Do not use statistics or percentages at all.",
    profile.banned_phrases?.length ? `Never use these phrases: ${profile.banned_phrases.join("; ")}.` : "",
    "Do not repeat a topic, hook, CTA, visual concept or caption structure used in the recent history.",
    "Text on the image must be short. The caption carries the detail.",
    "Respond only with the JSON object described by the schema.",
  ]
    .filter(Boolean)
    .join("\n");

  const cap = strategy.caption || {};
  const context = {
    today: { date, weekday, content_pillar: pillar, pillar_ideas: pillarCfg.ideas || [] },
    business: {
      name: profile.business_name,
      display_name: profile.display_name,
      description: profile.description,
      positioning: profile.positioning,
      location: profile.location,
      website: profile.website,
      instagram_handle: profile.instagram_handle,
      services: profile.services,
      target_audience: profile.target_audience,
      case_studies: profile.case_studies,
      testimonials: profile.testimonials,
      verified_facts: profile.verified_facts,
      offers: profile.offers,
      prices: profile.prices,
      tone: profile.tone,
      voice_notes: profile.voice_notes,
      default_cta: profile.default_cta,
    },
    post_templates_allowed: Object.fromEntries(allowedTemplates.map((t) => [t, TEMPLATE_GUIDE[t]])),
    story_templates_allowed: Object.fromEntries((strategy.story_templates || STORY_TEMPLATES).map((t) => [t, TEMPLATE_GUIDE[t]])),
    limits_in_characters: LIMITS,
    caption_rules: {
      structure: cap.structure || ["hook", "value", "takeaway", "cta"],
      max_chars: cap.max_chars || 900,
      first_line_is_the_hook: true,
      hashtags: `${cap.hashtags_min ?? 3}-${cap.hashtags_max ?? 8} relevant hashtags, lowercase, no spaces. Prefer from pool when relevant.`,
      hashtag_pool: cap.hashtag_pool || [],
    },
    story_rules: "The story is simpler than the post. It may tease today's post topic or stand alone. One idea only.",
    recent_history_do_not_repeat: history,
    rejected_topics_do_not_use: avoid,
  };

  let user = `Create today's content.\n\n${JSON.stringify(context, null, 2)}`;
  if (feedback.length) {
    user += `\n\nYour previous attempt failed validation. Fix every issue:\n- ${feedback.join("\n- ")}`;
  }
  return { system, user, allowedTemplates };
}

/** Final caption = model caption + normalized hashtags (deterministic, no AI). */
export function assembleCaption(caption, hashtags) {
  const body = (caption || "").trim();
  const tags = (hashtags || []).map((h) => `#${h}`).join(" ");
  return tags ? `${body}\n\n${tags}` : body;
}
