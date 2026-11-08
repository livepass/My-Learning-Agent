/**
 * Shape check for a course id read from the URL.
 *
 * The URL is user-editable, so a value taken from `?course=` is only treated as
 * a course when it looks like a server-issued id. Both the navigation layer and
 * the initial-page guess in `appStore` need the same rule; keeping it in one
 * place stops a malformed link from rendering a course page with no course.
 */
export const COURSE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function isSafeCourseParam(value: string | null | undefined): value is string {
	return typeof value === "string" && COURSE_ID_PATTERN.test(value);
}
