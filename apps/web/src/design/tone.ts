// What a coloured thing means. Every badge, alert, stat, avatar and card picks one of these,
// and components.css turns it into colours (data-tone), so meaning and colour never drift
// apart: danger is always emergencies and anything final, warning is urgent or needs a look.
export type Tone = "neutral" | "brand" | "info" | "success" | "warning" | "danger";
