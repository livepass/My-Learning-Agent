import { useEffect, useRef, useState } from "react";
import {
	ChevronDown, ChevronRight, FileText, Link2, Loader2, RefreshCw, Upload, Unlink,
} from "lucide-react";
import { Button, Select, SelectContent, SelectOption, SelectTrigger, SelectValue } from "../ui/index.js";
import { useStoreSnapshot } from "../hooks.js";
import { coursesStore, sourceStatusLabel, type CourseSourceView } from "../../stores/courses-store.js";
import { arrayBufferToBase64 } from "../../api/uploads.js";
import { assertUploadSize, DEFAULT_UPLOAD_MAX_LABEL } from "../../utils/upload-limits.js";
import type { CourseSourceSection } from "../../api/courses.js";

/**
 * 课程知识库 (E4.5c).
 *
 * Two facts are deliberately kept apart: the binding is ownership ("this
 * document belongs to this course") and the manifest status is processing
 * ("the index finished"). The panel never merges them — an uploaded document
 * whose ingest failed shows 已关联 + 解析失败, not "已索引".
 *
 * `source_refs` (page/chapter citations) are server output. This panel has no
 * editor for them; it only displays the locators the server returned.
 */

const ACCEPT = ".md,.markdown,.txt,.pdf,.docx";

function formatDate(iso?: string): string {
	if (!iso) return "";
	const time = Date.parse(iso);
	if (Number.isNaN(time)) return "";
	return new Date(time).toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
}

function statusBadge(source: CourseSourceView) {
	const status = source.source?.status;
	const tone = status === "indexed" ? " mla-badge--success" : status === "error" ? " mla-badge--danger" : " mla-badge--warning";
	return <span className={`mla-badge${tone}`}>{sourceStatusLabel(status)}</span>;
}

/** Section locators, loaded on demand; the list stays collapsed by default. */
function SectionList({ courseId, sourceId }: { courseId: string; sourceId: string }) {
	const [sections, setSections] = useState<CourseSourceSection[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		void coursesStore.loadSourceDetail(courseId, sourceId)
			.then((detail) => { if (!cancelled) setSections(detail.sections); })
			.catch((err: unknown) => {
				if (!cancelled) setError(err instanceof Error ? err.message : "读取章节失败");
			});
		return () => { cancelled = true; };
	}, [courseId, sourceId]);

	if (error) return <p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{error}</p>;
	if (!sections) {
		return (
			<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
				<Loader2 size={12} className="mla-spin" aria-hidden="true" />正在读取章节…
			</p>
		);
	}
	if (sections.length === 0) {
		return <p className="mla-small mla-muted" style={{ margin: 0 }}>这份资料没有可用的章节定位。</p>;
	}
	return (
		<ul className="mla-list">
			{sections.map((section) => (
				<li key={`${section.ordinal}:${section.path}`}>
					<FileText size={14} aria-hidden="true" />
					<span>
						{section.heading_path || section.path}
						{section.page_start !== undefined
							? ` · P${section.page_start}${section.page_end && section.page_end !== section.page_start ? `–${section.page_end}` : ""}`
							: ""}
					</span>
				</li>
			))}
		</ul>
	);
}

function SourceRow({ courseId, source, busy }: { courseId: string; source: CourseSourceView; busy: boolean }) {
	const [expanded, setExpanded] = useState(false);
	const [confirmingUnlink, setConfirmingUnlink] = useState(false);
	const status = source.source?.status;

	return (
		<div className="mla-source-row">
			<div style={{ minWidth: 0 }}>
				<div className="mla-inline" style={{ flexWrap: "wrap" }}>
					<strong style={{ fontSize: 14, fontWeight: 500, overflowWrap: "anywhere" }}>
						{source.source?.title || source.source_id}
					</strong>
					{statusBadge(source)}
					<span className="mla-badge">{source.source?.source_type || "未知类型"}</span>
				</div>
				<div className="mla-source-meta">
					{source.source ? (
						<>
							<span>{source.source.passage_count} 个片段</span>
							{source.source.page_count ? <span>{source.source.page_count} 页</span> : null}
							<span>关联于 {formatDate(source.created_at)}</span>
							{source.source.indexed_at ? <span>索引于 {formatDate(source.source.indexed_at)}</span> : null}
						</>
					) : (
						<span>资料清单中找不到这份来源，可能已被移除。</span>
					)}
				</div>
				{status === "error" && source.source?.error ? (
					<p className="mla-small" style={{ margin: "6px 0 0", color: "var(--inno-danger)" }}>
						解析失败：{source.source.error}
					</p>
				) : null}
				{status !== "indexed" && status !== "error" ? (
					<p className="mla-small mla-muted" style={{ margin: "6px 0 0" }}>
						上传成功不等于已索引：这份资料仍在处理，暂时不能用于生成计划。
					</p>
				) : null}

				{expanded ? (
					<div style={{ marginTop: 10 }}>
						<SectionList courseId={courseId} sourceId={source.source_id} />
					</div>
				) : null}
			</div>

			<div className="mla-stack" style={{ gap: 6, justifyItems: "end" }}>
				<Button size="xs" onClick={() => setExpanded((value) => !value)}>
					{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
					{expanded ? "收起章节" : "查看章节"}
				</Button>
				{status === "error" ? (
					<Button size="xs" disabled={busy} onClick={() => void coursesStore.retrySource(courseId, source.source_id)}>
						<RefreshCw size={14} />
						重试解析
					</Button>
				) : null}
				{confirmingUnlink ? (
					<div className="mla-inline" style={{ justifyContent: "flex-end" }}>
						<Button size="xs" onClick={() => setConfirmingUnlink(false)}>取消</Button>
						<Button
							size="xs"
							variant="danger"
							disabled={busy}
							onClick={async () => {
								const done = await coursesStore.unbindSource(courseId, source.source_id);
								setConfirmingUnlink(false);
								if (done) setExpanded(false);
							}}
						>
							确认解除
						</Button>
					</div>
				) : (
					<Button size="xs" disabled={busy} onClick={() => setConfirmingUnlink(true)}>
						<Unlink size={14} />
						解除关联
					</Button>
				)}
			</div>
		</div>
	);
}

/**
 * Link an already-indexed source into this course.
 *
 * The candidate list comes from the server and includes documents that belong
 * to another course: one source may serve several courses, and attaching it
 * copies nothing. Sources the course already owns are excluded there, so the
 * picker can never offer a no-op.
 */
function BindExistingSource({ courseId }: { courseId: string }) {
	const state = useStoreSnapshot(coursesStore, () => ({
		candidates: coursesStore.sourceCandidates,
		loading: coursesStore.sourceCandidatesLoading,
		error: coursesStore.sourceCandidatesError,
		pendingAction: coursesStore.pendingAction,
	}));
	const [selected, setSelected] = useState("");

	useEffect(() => {
		void coursesStore.loadSourceCandidates(courseId);
	}, [courseId]);

	const chosen = state.candidates.find((candidate) => candidate.source_id === selected) ?? null;
	const labelOf = (candidate: typeof state.candidates[number]) => {
		const owners = candidate.courses.map((owner) => owner.title).join("、");
		return owners ? `${candidate.title}（已在 ${owners}）` : candidate.title;
	};

	if (state.error) {
		return <p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{state.error}</p>;
	}
	if (state.loading && state.candidates.length === 0) {
		return (
			<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
				<Loader2 size={14} className="mla-spin" aria-hidden="true" />正在读取可关联的资料…
			</p>
		);
	}
	if (state.candidates.length === 0) {
		return (
			<p className="mla-small mla-muted" style={{ margin: 0 }}>
				知识库中没有可以关联的其他已索引资料。上传一份新教材，或在其他课程中上传后再回到这里关联。
			</p>
		);
	}

	return (
		<div className="mla-stack" style={{ gap: 8 }}>
			<div className="mla-inline">
				<Select value={selected || "none"} disabled={state.pendingAction !== null} onValueChange={(value) => setSelected(value === "none" ? "" : value)}>
					<SelectTrigger aria-label="选择已有资料"><SelectValue /></SelectTrigger>
					<SelectContent>
						<SelectOption value="none" label="选择一份已有资料" />
						{state.candidates.map((candidate) => (
							<SelectOption key={candidate.source_id} value={candidate.source_id} label={labelOf(candidate)} />
						))}
					</SelectContent>
				</Select>
				<Button
					disabled={!selected || state.pendingAction !== null}
					onClick={async () => {
						const done = await coursesStore.bindSource(courseId, selected);
						if (done) setSelected("");
					}}
				>
					<Link2 size={14} />
					关联到本课程
				</Button>
			</div>
			{chosen ? (
				<p className="mla-small mla-muted" style={{ margin: 0 }}>
					{chosen.passage_count} 个片段
					{chosen.courses.length > 0
						? `，目前也属于 ${chosen.courses.map((owner) => owner.title).join("、")}。关联后两门课程共用同一份索引，不会复制原文件。`
						: "，尚未归入任何课程。关联不会复制或移动原文件。"}
				</p>
			) : null}
		</div>
	);
}

export function CourseLibraryPanel({ courseId }: { courseId: string }) {
	const state = useStoreSnapshot(coursesStore, () => ({
		sources: coursesStore.sources,
		sourcesLoading: coursesStore.sourcesLoading,
		sourcesError: coursesStore.sourcesError,
		pendingAction: coursesStore.pendingAction,
		feedback: coursesStore.feedback,
	}));
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [uploadError, setUploadError] = useState<string | null>(null);

	useEffect(() => {
		void coursesStore.loadSources(courseId);
	}, [courseId]);

	const uploading = state.pendingAction === "upload_source";
	const indexed = state.sources.filter((source) => source.source?.status === "indexed").length;

	const onPickFile = async (file: File | null) => {
		if (!file) return;
		setUploadError(null);
		try {
			assertUploadSize(file);
		} catch {
			setUploadError(`文件超过 ${DEFAULT_UPLOAD_MAX_LABEL} 的上传上限，请压缩或拆分后再上传。`);
			return;
		}
		const dataBase64 = arrayBufferToBase64(await file.arrayBuffer());
		const uploaded = await coursesStore.uploadSource(courseId, {
			fileName: file.name,
			mimeType: file.type || "application/octet-stream",
			dataBase64,
		});
		if (!uploaded && fileInputRef.current) fileInputRef.current.value = "";
	};

	return (
		<div className="mla-stack-lg">
			{state.feedback ? (
				<p role={state.feedback.tone === "success" ? "status" : "alert"} className={`mla-notice mla-notice--${state.feedback.tone}`}>
					{state.feedback.message}
				</p>
			) : null}

			<section className="mla-card">
				<div className="mla-card-header">
					<div>
						<h2>课程教材</h2>
						<span className="mla-small mla-muted">
							{indexed} / {state.sources.length} 份资料已建立索引
						</span>
					</div>
					<div className="mla-toolbar">
						<input
							ref={fileInputRef}
							type="file"
							accept={ACCEPT}
							aria-label="选择教材文件"
							style={{ display: "none" }}
							onChange={(event) => {
								const file = event.target.files?.[0] ?? null;
								void onPickFile(file);
							}}
						/>
						<Button variant="primary" size="xs" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
							{uploading ? <Loader2 size={14} className="mla-spin" /> : <Upload size={14} />}
							{uploading ? "正在上传…" : "上传教材"}
						</Button>
					</div>
				</div>
				<p className="mla-small mla-muted" style={{ margin: 0 }}>
					支持 Markdown、纯文本、PDF 与 DOCX，单文件不超过 {DEFAULT_UPLOAD_MAX_LABEL}。上传成功后还需要完成解析与索引，才会用于 AI 学习与计划生成。
				</p>
				{uploadError ? (
					<p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{uploadError}</p>
				) : null}

				{state.sourcesLoading && state.sources.length === 0 ? (
					<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
						<Loader2 size={14} className="mla-spin" aria-hidden="true" />正在读取课程资料…
					</p>
				) : state.sourcesError ? (
					<p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{state.sourcesError}</p>
				) : state.sources.length === 0 ? (
					<div className="mla-empty">
						<FileText size={26} aria-hidden="true" />
						<strong>还没有课程教材</strong>
						<p className="mla-small" style={{ margin: 0, maxWidth: 520 }}>
							上传教材后，AI 可以按章节生成学习计划，并在学习时引用具体位置。没有教材也可以按模型一般知识规划。
						</p>
					</div>
				) : (
					<div>
						{state.sources.map((source) => (
							<SourceRow key={source.binding_id} courseId={courseId} source={source} busy={state.pendingAction !== null} />
						))}
					</div>
				)}
			</section>

			<section className="mla-card">
				<div className="mla-card-header">
					<h2>关联已有资料</h2>
				</div>
				<p className="mla-small mla-muted" style={{ margin: 0 }}>
					同一份资料可以同时属于多门课程。这里列出知识库中已索引、且本课程还没有的资料，包括已经属于其他课程的教材；关联不会复制或移动原文件，也不会影响它原来的课程。
				</p>
				<BindExistingSource courseId={courseId} />
			</section>
		</div>
	);
}
