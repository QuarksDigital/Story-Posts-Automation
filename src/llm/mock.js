// Offline provider for local testing: deterministic, free, no network. It
// rotates through a small topic bank so duplicate-detection is exercised too.

const BANK = {
  Educational: [
    { t: "list", topic: "5 website mistakes that quietly cost small businesses customers", headline: "5 website mistakes that cost you customers", points: ["No clear headline about what you do", "Contact details buried in the footer", "Slow pages on mobile data", "No single next step for the visitor", "Stock photos instead of your real work"] },
    { t: "tip", topic: "Write your homepage headline for a stranger", headline: "Write your homepage for a stranger", subtext: "If someone who has never heard of you cannot tell what you do in one line, rewrite it." },
    { t: "myth_fact", topic: "SEO is a one-time setup", headline: "SEO is not a setup task", myth: "SEO is something you set up once when the site launches.", fact: "Search rankings follow ongoing work: technical fixes, useful content and earned links." },
  ],
  Service: [
    { t: "service_spotlight", topic: "Automating lead follow-ups for small teams", service_id: "automation", headline: "Stop copying data between spreadsheets", points: ["Lead routing", "CRM sync", "Automatic reports"] },
    { t: "service_spotlight", topic: "SEO as an ongoing service", service_id: "seo", headline: "Get found by people already searching", points: ["Technical audit", "Content architecture", "Digital PR"] },
  ],
  "Industry Insight": [
    { t: "insight", topic: "Distribution beats product quality", headline: "Good products lose to worse products with better distribution.", subtext: "Design how you get found at the same time as what you build." },
    { t: "tip", topic: "Google Business Profile for local shops", headline: "Your Google Business Profile is your new storefront", subtext: "Keep hours, photos and services current. It is often the first thing local customers see." },
  ],
  "Problem/Solution": [
    { t: "list", topic: "Why your enquiries go unanswered", headline: "Why enquiries slip through the cracks", points: ["Leads arrive in five different inboxes", "Nobody owns the first reply", "No reminder when a lead goes quiet"] },
  ],
  "Case Study": [
    { t: "case_study", topic: "Building a storefront for a laptop retailer", case_id: "kcpl", headline: "A storefront built around how people buy laptops" },
  ],
  "Behind the Scenes": [
    { t: "list", topic: "How one team runs a project from brief to launch", headline: "How a project moves at Quarks", points: ["One brief, one board", "Design and marketing start together", "You talk to the people doing the work"] },
  ],
  Engagement: [
    { t: "question", topic: "Which task would you automate first", headline: "Which weekly task would you hand to software first?", subtext: "Tell us in the comments." },
  ],
};

export const mockProvider = {
  name: "mock",
  /** Tests can replace this to simulate bad output or failures. */
  override: null,
  async generate(req) {
    if (this.override) return this.override(req);
    const { pillar = "Educational", allowedTemplates = [], history = [], avoid = [] } = req.context || {};
    const used = new Set([...history.map((h) => h.topic), ...avoid]);
    const options = (BANK[pillar] || BANK.Educational).filter((o) => !allowedTemplates.length || allowedTemplates.includes(o.t));
    const pick = options.find((o) => !used.has(o.topic)) || options[history.length % Math.max(options.length, 1)] || BANK.Educational[0];

    const data = {
      content_pillar: pillar,
      topic: pick.topic,
      angle: "Practical and specific",
      hook: pick.headline,
      visual_concept: `${pick.t} card on brand background`,
      post: {
        template: pick.t,
        eyebrow: pillar.toUpperCase(),
        headline: pick.headline,
        subtext: pick.subtext || "",
        points: pick.points || [],
        service_id: pick.service_id || "",
        case_id: pick.case_id || "",
        testimonial_index: -1,
        myth: pick.myth || "",
        fact: pick.fact || "",
      },
      caption: `${pick.headline}\n\nMost small businesses do not need more tools. They need the basics done properly and kept up.\n\nPick one item from this post and fix it this week.\n\nSave this for your next review.`,
      hashtags: ["smallbusiness", "digitalmarketing", "webdesign", "bhubaneswar"],
      cta: "Save this for your next review",
      story: {
        template: pillar === "Engagement" ? "story_question" : "story_tip",
        text: pillar === "Engagement" ? pick.headline : `New post today: ${pick.topic}`.slice(0, 110),
        subtext: "",
        cta: "",
      },
    };
    return { data, model: "mock", inputTokens: Math.round((req.system.length + req.user.length) / 4), outputTokens: 600 };
  },
};
