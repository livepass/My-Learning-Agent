import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Select, SelectContent, SelectOption, SelectTrigger, SelectValue } from "../ui/index.js";
import { LearnerProfilePanel } from "../LearnerProfilePanel.js";
import { CourseLearnerPanel } from "../courses/CourseLearnerPanel.js";
import { coursesStore } from "../../stores/courses-store.js";
import { useStoreSnapshot } from "../hooks.js";
import { useCourseErrorText } from "../courses/use-course-error-text.js";
import { KnowledgeDraftGuardProvider, useKnowledgeDraftGuard } from "../profile/KnowledgeDraftGuard.js";

/**
 * 我的学习档案 — 全部课程 / 指定课程 (E4.5e).
 *
 * "全部课程" keeps the existing `LearnerProfilePanel` and `learnerStore`
 * untouched: that panel is still the single owner of the personal profile.
 * Choosing one course swaps in a course-scoped view read from
 * `GET /api/courses/:id/learner`, which the server already filters — this page
 * never mixes two courses' knowledge itself.
 *
 * The selected course lives in `coursesStore.selectedCourseId`, not in local
 * state: that field is also the guard that drops a late response for a course
 * the learner has already left. Keeping a second copy here made the store
 * refuse every read (the course-scoped view rendered empty).
 */
/**
 * The page owns the draft guard for its whole subtree.
 *
 * A component cannot consume the provider it renders, so the exported page is
 * a thin wrapper and the real page body lives one level down.
 */
export function ProfilePage() {
	return (
		<KnowledgeDraftGuardProvider>
			<ProfilePageBody />
		</KnowledgeDraftGuardProvider>
	);
}

function ProfilePageBody() {
	const courseErrorText = useCourseErrorText();
	const { t } = useTranslation();
	const { courses, coursesLoading, coursesError, selectedCourseId } = useStoreSnapshot(coursesStore, () => ({
		courses: coursesStore.courses,
		coursesLoading: coursesStore.coursesLoading,
		coursesError: coursesStore.coursesError,
		selectedCourseId: coursesStore.selectedCourseId,
	}));

	/**
	 * E4.9i-P2-2-R1: changing the range unmounts the whole panel, so it takes
	 * the same verdict as every other exit.
	 *
	 * The Select is controlled by `selectedCourseId`, so refusing simply means
	 * not calling the store: the trigger keeps showing the old course, the
	 * editor stays mounted and the draft survives. A save in flight refuses
	 * outright — the request is already on the wire, and switching would throw
	 * away the response for a course the learner has left.
	 */
	const guard = useKnowledgeDraftGuard();
	const changeScope = (value: string) => {
		const next = value === "all" ? null : value;
		if (next === selectedCourseId) return;
		if (!guard.confirmLeave()) return;
		coursesStore.selectCourse(next);
	};

	useEffect(() => {
		void coursesStore.loadCourses();
	}, []);

	// A course that disappeared (archived/deleted elsewhere) falls back to the
	// all-courses view instead of rendering an empty detail.
	useEffect(() => {
		if (selectedCourseId && courses.length > 0 && !courses.some((course) => course.course_id === selectedCourseId)) {
			coursesStore.selectCourse(null);
		}
	}, [selectedCourseId, courses]);

	// Leaving the page drops the selection so the next course-scoped page starts
	// clean (mirrors `CourseDetailPage`).
	useEffect(() => () => { coursesStore.selectCourse(null); }, []);

	return (
		<div className="mla-profile">
			<div className="mla-page-head mla-profile-head">
				<div>
					<h1>{t("profile.page.title")}</h1>
					<p>{t("profile.page.subtitle")}</p>
				</div>
				<div className="mla-inline" style={{ alignItems: "center" }}>
					{coursesLoading && courses.length === 0 ? (
						<span className="mla-small mla-muted mla-inline" style={{ gap: 4 }}>
							<Loader2 size={12} className="mla-spin" aria-hidden="true" />{t("profile.page.loadingCourses")}
						</span>
					) : null}
					<Select
						value={selectedCourseId ?? "all"}
						onValueChange={changeScope}
					>
						<SelectTrigger aria-label={t("profile.page.scopeLabel")}><SelectValue /></SelectTrigger>
						<SelectContent>
							<SelectOption value="all" label={t("profile.page.allCourses")} />
							{courses.map((course) => (
								<SelectOption key={course.course_id} value={course.course_id} label={course.title} />
							))}
						</SelectContent>
					</Select>
				</div>
			</div>
			{coursesError ? (
				<p className="mla-small" style={{ margin: "0 0 12px", color: "var(--inno-danger)" }}>{courseErrorText(coursesError)}</p>
			) : null}
			<div className="mla-profile-body">
				{selectedCourseId ? <CourseLearnerPanel courseId={selectedCourseId} /> : <LearnerProfilePanel />}
			</div>
		</div>
	);
}
