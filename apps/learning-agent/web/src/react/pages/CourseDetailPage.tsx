import { useEffect, useState } from "react";
import { Archive, ArrowLeft, Loader2, MoreHorizontal, Play, Trash2 } from "lucide-react";
import {
	Button,
	DropdownMenu,
	DropdownMenuActionItem,
	DropdownMenuContent,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	IconButton,
	TabPanel,
	Tabs,
} from "../ui/index.js";
import { useStoreSnapshot } from "../hooks.js";
import { coursesStore, courseStatusLabel } from "../../stores/courses-store.js";
import {
	courseFromLocation,
	courseViewFromLocation,
	navigate,
	type CourseView,
} from "../shell/navigation.js";
import { useLocationSearch } from "../shell/use-location-search.js";
import { CoursePlanPanel } from "../courses/CoursePlanPanel.js";
import { CourseLibraryPanel } from "../courses/CourseLibraryPanel.js";
import { CourseRecordsPanel } from "../courses/CourseRecordsPanel.js";
import { CourseOverviewPanel } from "../courses/CourseOverviewPanel.js";
import { DeletionDialog, type DeletionTarget } from "../courses/DeletionDialog.js";

/**
 * 课程详情 — a second-level page, never a sidebar entry (E4.5c).
 *
 * The course id and the active tab both live in the URL
 * (`?page=course&course=<id>&view=<plan|library|records|overview>`), so a
 * refresh, a direct link and Back/Forward all restore the same view. Switching
 * tabs pushes history; switching course replaces it (the id comes from the URL,
 * not from local state), which keeps the trail free of one entry per course
 * ever visited in this session.
 */

const VIEWS: Array<{ value: CourseView; label: string }> = [
	{ value: "plan", label: "学习计划" },
	{ value: "library", label: "课程知识库" },
	{ value: "records", label: "学习记录" },
	{ value: "overview", label: "学习概况" },
];

export function CourseDetailPage() {
	// Subscribe to the URL: the shell does not re-render on a same-page
	// parameter change, so without this a tab click would keep the old view.
	const search = useLocationSearch();
	const courseId = courseFromLocation(search);
	const view = courseViewFromLocation(search);
	const state = useStoreSnapshot(coursesStore, () => ({
		detail: coursesStore.detail,
		detailLoading: coursesStore.detailLoading,
		detailError: coursesStore.detailError,
		selectedCourseId: coursesStore.selectedCourseId,
		pendingAction: coursesStore.pendingAction,
	}));
	const [deletionTarget, setDeletionTarget] = useState<DeletionTarget | null>(null);

	// One owner for the selected course: the URL names it, the store follows.
	useEffect(() => {
		if (!courseId) return;
		if (coursesStore.selectedCourseId !== courseId) coursesStore.selectCourse(courseId);
		void coursesStore.loadDetail(courseId);
	}, [courseId]);

	// Leaving the page drops the selection so no stale course facts can paint
	// on the next course the learner opens.
	useEffect(() => () => { coursesStore.selectCourse(null); }, []);

	if (!courseId) {
		return (
			<div className="mla-stack">
				<p className="mla-text mla-muted" style={{ margin: 0 }}>没有指定课程。</p>
				<Button onClick={() => navigate("today", { history: "push" })}>返回今日学习</Button>
			</div>
		);
	}

	const detail = state.selectedCourseId === courseId ? state.detail : null;
	// Panels mount only once the store has accepted this course. Child effects
	// run before the parent's, so mounting them while the selection is still the
	// previous course would issue reads the store correctly refuses to paint.
	const selectionReady = state.selectedCourseId === courseId;
	const loading = !selectionReady || (state.detailLoading && !detail);

	const changeView = (next: CourseView) => {
		if (next === view) return;
		navigate("course", { history: "push", course: { id: courseId, view: next } });
	};

	return (
		<div className="mla-stack-lg">
			<div className="mla-detail-head">
				<button type="button" className="mla-back-link" onClick={() => navigate("today", { history: "push" })}>
					<ArrowLeft size={14} aria-hidden="true" />
					返回今日学习
				</button>
				{loading ? (
					<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
						<Loader2 size={14} className="mla-spin" aria-hidden="true" />正在读取课程…
					</p>
				) : state.detailError ? (
					<div>
						<p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{state.detailError}</p>
						<Button size="xs" style={{ marginTop: 8 }} onClick={() => void coursesStore.loadDetail(courseId)}>
							重试
						</Button>
					</div>
				) : detail ? (
					<>
						<div className="mla-inline" style={{ flexWrap: "wrap", justifyContent: "space-between" }}>
							<div className="mla-inline" style={{ gap: 8, flexWrap: "wrap", minWidth: 0 }}>
								<h1>{detail.course.title}</h1>
								<span className={`mla-badge${detail.course.status === "in_progress" ? " mla-badge--accent" : ""}`}>
									{courseStatusLabel(detail.course.status)}
								</span>
								{/* E4.7-R1: a restored course lands on `paused`; without this
								    explicit step the badge would have no way forward. It only
								    changes the status — no session, no learning record. */}
								{detail.course.status === "paused" ? (
									<Button
										size="xs"
										variant="primary"
										disabled={Boolean(state.pendingAction)}
										onClick={() => void coursesStore.resumeCourse(courseId)}
									>
										<Play size={14} />
										继续课程
									</Button>
								) : null}
							</div>
							{/* E4.7: course management lives here, not inline with the
							    study actions. Both entries keep history: archiving hides
							    the course, deleting is only offered after the server
							    confirms there is nothing to preserve. */}
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<IconButton aria-label="课程管理">
										<MoreHorizontal size={16} aria-hidden="true" />
									</IconButton>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									<DropdownMenuActionItem
										icon={<Archive size={14} />}
										label={detail.course.status === "archived" ? "已归档" : "归档课程"}
										disabled={detail.course.status === "archived"}
										onSelect={() => void coursesStore.archiveCourse(courseId)}
									/>
									<DropdownMenuSeparator />
									<DropdownMenuActionItem
										icon={<Trash2 size={14} />}
										label="删除课程"
										variant="danger"
										onSelect={() => setDeletionTarget({
											kind: "course",
											courseId,
											title: detail.course.title,
										})}
									/>
								</DropdownMenuContent>
							</DropdownMenu>
						</div>
						{detail.course.description ? (
							<p className="mla-text mla-muted" style={{ margin: 0 }}>{detail.course.description}</p>
						) : null}
						<div className="mla-inline mla-small mla-muted" style={{ gap: 12, flexWrap: "wrap" }}>
							<span>{detail.counts.goals} 个目标</span>
							<span>{detail.counts.plans} 份计划</span>
							<span>{detail.counts.tasks} 个任务</span>
							<span>{detail.counts.sessions} 个学习会话</span>
							<span>{detail.counts.sources} 份资料</span>
						</div>
					</>
				) : null}
			</div>

			<div className="mla-course-tabs">
				<Tabs
					id="course-detail"
					value={view}
					onValueChange={(next) => changeView(next as CourseView)}
					ariaLabel="课程详情页签"
					items={VIEWS.map((item) => ({ value: item.value, label: item.label, panelId: "course-detail-panel" }))}
				/>
			</div>

			<TabPanel id="course-detail-panel" labelledBy={`course-detail-tab-${view}`}>
				{selectionReady ? (
					<>
						{view === "plan" ? <CoursePlanPanel courseId={courseId} /> : null}
						{view === "library" ? <CourseLibraryPanel courseId={courseId} /> : null}
						{view === "records" ? <CourseRecordsPanel courseId={courseId} /> : null}
						{view === "overview" ? <CourseOverviewPanel courseId={courseId} /> : null}
					</>
				) : null}
			</TabPanel>

			{/* A deleted course has no page left: return to today's list, which
			    the store has already re-read. */}
			<DeletionDialog
				target={deletionTarget}
				onClose={() => setDeletionTarget(null)}
				onDeleted={() => navigate("today", { history: "push" })}
				onArchive={async () => (deletionTarget
					? coursesStore.archiveCourse(deletionTarget.courseId)
					: false)}
			/>
		</div>
	);
}
