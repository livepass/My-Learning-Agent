import { useEffect } from "react";
import { ArchiveRestore, BookOpen, ClipboardList, Loader2, RotateCcw } from "lucide-react";
import { Button } from "../ui/index.js";
import { useStoreSnapshot } from "../hooks.js";
import { coursesStore } from "../../stores/courses-store.js";
import { navigate } from "../shell/navigation.js";

/**
 * 归档课程 (E4.7-R1b).
 *
 * Archived courses leave 今日学习 entirely and are managed here:
 *
 * - 课程详情 / 学习记录 open the existing course page (its history is read-only
 *   because the server refuses learning writes while the course is archived);
 * - 恢复课程 calls `POST /restore`, which always lands on `paused`. The course ID,
 *   plans, tasks, material bindings and session links are kept; nothing restarts
 *   on its own.
 */
export function ArchivedCoursesSettings() {
	const state = useStoreSnapshot(coursesStore, () => ({
		courses: coursesStore.courses,
		loading: coursesStore.coursesLoading,
		error: coursesStore.coursesError,
		feedback: coursesStore.feedback,
		pendingAction: coursesStore.pendingAction,
	}));

	useEffect(() => {
		void coursesStore.loadCourses();
	}, []);

	const archived = state.courses.filter((course) => course.status === "archived");
	const busy = Boolean(state.pendingAction);

	return (
		<section className="mla-card" aria-labelledby="settings-archived-courses">
			<div className="mla-card-header">
				<div>
					<h2 id="settings-archived-courses">归档课程</h2>
					<span className="mla-small mla-muted">
						归档课程不在今日学习中显示；计划、任务、教材与学习记录都保留，可随时恢复。
					</span>
				</div>
				<span className="mla-badge">{archived.length} 门</span>
			</div>

			{state.feedback && state.feedback.tone !== "success" ? (
				<p role="alert" className="mla-notice mla-notice--error">{state.feedback.message}</p>
			) : null}

			{state.loading && state.courses.length === 0 ? (
				<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
					<Loader2 size={14} className="mla-spin" aria-hidden="true" />
					正在读取课程…
				</p>
			) : state.error ? (
				<p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
					{state.error}
				</p>
			) : archived.length === 0 ? (
				<div className="mla-empty">
					<ArchiveRestore size={26} aria-hidden="true" />
					<strong>没有归档课程</strong>
					<p className="mla-small" style={{ margin: 0, maxWidth: 520 }}>
						在今日学习的课程「更多操作」中选择「归档课程」，它会出现在这里。
					</p>
				</div>
			) : (
				<div className="mla-state-list">
					{archived.map((course) => (
						<div className="mla-state-row" key={course.course_id}>
							<div>
								<div className="mla-inline" style={{ flexWrap: "wrap" }}>
									<strong>{course.title}</strong>
									<span className="mla-badge">已归档</span>
								</div>
								<p>
									{course.counts.plans} 份计划 · {course.counts.tasks} 个任务 · {course.counts.sessions} 个学习会话
									{course.counts.sources > 0 ? ` · ${course.counts.sources} 份资料` : ""}
								</p>
								<p className="mla-small mla-muted">
									归档于 {new Date(course.updated_at).toLocaleDateString("zh-CN")}；恢复后状态为「已暂停」，不会自动开始学习。
								</p>
							</div>
							<div className="mla-inline" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
								<Button
									size="xs"
									disabled={busy}
									onClick={() => navigate("course", { history: "push", course: { id: course.course_id, view: "overview" } })}
								>
									<BookOpen size={14} />
									课程详情
								</Button>
								<Button
									size="xs"
									disabled={busy}
									onClick={() => navigate("course", { history: "push", course: { id: course.course_id, view: "records" } })}
								>
									<ClipboardList size={14} />
									学习记录
								</Button>
								<Button
									size="xs"
									variant="primary"
									disabled={busy}
									onClick={() => void coursesStore.restoreCourse(course.course_id)}
								>
									{busy ? <Loader2 size={14} className="mla-spin" /> : <RotateCcw size={14} />}
									恢复课程
								</Button>
							</div>
						</div>
					))}
				</div>
			)}
		</section>
	);
}
