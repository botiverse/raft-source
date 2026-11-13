// A `feedback:submit` card's draft bounds (the card's schema is in
// actionCards.ts). Kept apart, without imports, so the standalone mobile
// feedback page, which sends that draft, can use them without zod.

/** Same bound as the in-app product feedback form (POST /api/product-feedback). */
export const FEEDBACK_SUBMIT_MESSAGE_MAX_LENGTH = 10_000;
export const FEEDBACK_SUBMIT_TYPES = ["idea", "problem"] as const;
export type FeedbackSubmitType = (typeof FEEDBACK_SUBMIT_TYPES)[number];
