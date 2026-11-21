import type { CourseDailyPlan, CourseSummary } from "../../api/courses.js";
import { pickCurrentTask } from "../courses/CourseCard.js";

/**
 * Which course owns the today page's primary surface.
 *
 * Priority (the first matching tier wins; archived courses never qualify):
 *
 *   1. a course whose current task is already in progress;
 *   2. a course with a next executable task;
 *   3. a course that is still `in_progress` but has nothing to run today;
 *   4. a paused or completed course (kept visible, never pushed over work).
 *
 * `updated_at` only orders courses *inside* the same tier. A learner renaming
 * a paused course therefore cannot make it displace an actionable task.
 *
 * The function is pure so the ordering is testable without rendering the page;
 * it never derives a task the daily plan did not return.
 */
export function selectPrimaryCourse(
	courses: readonly CourseSummary[],
	dailyByCourse: ReadonlyMap<string, CourseDailyPlan>,
): CourseSummary | undefined {
	const ordered = [...courses]
		.filter((course) => course.status !== "archived")
		.sort((a, b) => updatedAt(b) - updatedAt(a));

	const currentTaskOf = (course: CourseSummary) => pickCurrentTask(dailyByCourse.get(course.course_id));
	const isInProgress = (course: CourseSummary) => {
		const task = currentTaskOf(course);
		return task?.status === "in_progress" || task?.reason_code === "in_progress";
	};

	return ordered.find((course) => course.status === "in_progress" && isInProgress(course))
		?? ordered.find((course) => course.status === "in_progress" && Boolean(currentTaskOf(course)))
		?? ordered.find((course) => course.status === "in_progress")
		?? ordered[0];
}

function updatedAt(course: CourseSummary): number {
	const time = Date.parse(course.updated_at);
	return Number.isFinite(time) ? time : 0;
}
