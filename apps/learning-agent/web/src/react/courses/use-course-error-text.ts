import { useTranslation } from "react-i18next";
import type { CourseErrorRef, CourseFeedback } from "../../stores/courses-store.js";

/**
 * E4.9e — render a store error in the learner's current language.
 *
 * The store deliberately keeps a translation *key* (plus parameters) rather
 * than a sentence: it has no language, and a cached translated string would
 * survive a language switch. Resolving here means an error already on screen
 * re-renders in the new language without re-fetching anything.
 *
 * The raw server message is used only when no key could be produced — a
 * diagnostics fallback, not the normal path.
 */
export function useCourseErrorText(): (error: CourseErrorRef | null | undefined) => string | null {
	const { t } = useTranslation();
	return (error) => {
		if (!error) return null;
		const text = error.messageKey
			? t(error.messageKey, error.messageParams ?? {})
			: error.message;
		return text || error.message || null;
	};
}

/**
 * The same resolution for a write's feedback (success / error / conflict).
 *
 * `CourseFeedback` carries `messageKey` + `messageParams` for the same reason as
 * an error ref: the store must not cache a translated sentence.
 */
export function useCourseFeedbackText(): (feedback: CourseFeedback | null | undefined) => string | null {
	const { t } = useTranslation();
	return (feedback) => {
		if (!feedback) return null;
		const text = feedback.messageKey
			? t(feedback.messageKey, feedback.messageParams ?? {})
			: feedback.message;
		return text || feedback.message || null;
	};
}
