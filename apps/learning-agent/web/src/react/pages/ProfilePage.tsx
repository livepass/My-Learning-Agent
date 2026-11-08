import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { Select, SelectContent, SelectOption, SelectTrigger, SelectValue } from "../ui/index.js";
import { LearnerProfilePanel } from "../LearnerProfilePanel.js";
import { CourseLearnerPanel } from "../courses/CourseLearnerPanel.js";
import { coursesStore } from "../../stores/courses-store.js";
import { useStoreSnapshot } from "../hooks.js";

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
export function ProfilePage() {
	const { courses, coursesLoading, coursesError, selectedCourseId } = useStoreSnapshot(coursesStore, () => ({
		courses: coursesStore.courses,
		coursesLoading: coursesStore.coursesLoading,
		coursesError: coursesStore.coursesError,
		selectedCourseId: coursesStore.selectedCourseId,
	}));

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
					<h1>我的学习档案</h1>
					<p>学习目标、知识掌握、薄弱点与教学偏好都来自同一份本机档案。</p>
				</div>
				<div className="mla-inline" style={{ alignItems: "center" }}>
					{coursesLoading && courses.length === 0 ? (
						<span className="mla-small mla-muted mla-inline" style={{ gap: 4 }}>
							<Loader2 size={12} className="mla-spin" aria-hidden="true" />读取课程…
						</span>
					) : null}
					<Select
						value={selectedCourseId ?? "all"}
						onValueChange={(value) => coursesStore.selectCourse(value === "all" ? null : value)}
					>
						<SelectTrigger aria-label="选择学习档案范围"><SelectValue /></SelectTrigger>
						<SelectContent>
							<SelectOption value="all" label="全部课程" />
							{courses.map((course) => (
								<SelectOption key={course.course_id} value={course.course_id} label={course.title} />
							))}
						</SelectContent>
					</Select>
				</div>
			</div>
			{coursesError ? (
				<p className="mla-small" style={{ margin: "0 0 12px", color: "var(--inno-danger)" }}>{coursesError}</p>
			) : null}
			<div className="mla-profile-body">
				{selectedCourseId ? <CourseLearnerPanel courseId={selectedCourseId} /> : <LearnerProfilePanel />}
			</div>
		</div>
	);
}
