import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { currentLocale } from "../../i18n/index.js";
import {
	ChevronDown, ChevronRight, FileText, Link2, Loader2, RefreshCw, Upload, Unlink,
} from "lucide-react";
import { Button, Select, SelectContent, SelectOption, SelectTrigger, SelectValue } from "../ui/index.js";
import { useStoreSnapshot } from "../hooks.js";
import { coursesStore, type CourseSourceView } from "../../stores/courses-store.js";
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
	return new Date(time).toLocaleDateString(currentLocale(), { month: "long", day: "numeric" });
}

function statusBadge(source: CourseSourceView) {
	const { t } = useTranslation();
	const status = source.source?.status;
	const tone = status === "indexed" ? " mla-badge--success" : status === "error" ? " mla-badge--danger" : " mla-badge--warning";
	return <span className={`mla-badge${tone}`}>{t(`course.sourceStatus.${status ?? "unknown"}`)}</span>;
}

/** Section locators, loaded on demand; the list stays collapsed by default. */
function SectionList({ courseId, sourceId }: { courseId: string; sourceId: string }) {
	const { t } = useTranslation();
	const [sections, setSections] = useState<CourseSourceSection[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		void coursesStore.loadSourceDetail(courseId, sourceId)
			.then((detail) => { if (!cancelled) setSections(detail.sections); })
			.catch((err: unknown) => {
				if (!cancelled) setError(err instanceof Error ? err.message : t("course.library.sectionsFailed"));
			});
		return () => { cancelled = true; };
	}, [courseId, sourceId, t]);

	if (error) return <p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{error}</p>;
	if (!sections) {
		return (
			<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
				<Loader2 size={12} className="mla-spin" aria-hidden="true" />{t("course.library.sectionsLoading")}
			</p>
		);
	}
	if (sections.length === 0) {
		return <p className="mla-small mla-muted" style={{ margin: 0 }}>{t("course.library.noSections")}</p>;
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
	const { t } = useTranslation();
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
					<span className="mla-badge">{source.source?.source_type || t("course.library.unknownType")}</span>
				</div>
				<div className="mla-source-meta">
					{source.source ? (
						<>
							<span>{t("course.library.passageCount", { count: source.source.passage_count })}</span>
							{source.source.page_count ? <span>{t("course.library.pageCount", { count: source.source.page_count })}</span> : null}
							<span>{t("course.library.linkedAt", { date: formatDate(source.created_at) })}</span>
							{source.source.indexed_at ? (
								<span>{t("course.library.indexedAt", { date: formatDate(source.source.indexed_at) })}</span>
							) : null}
						</>
					) : (
						<span>{t("course.library.sourceMissing")}</span>
					)}
				</div>
				{status === "error" && source.source?.error ? (
					<p className="mla-small" style={{ margin: "6px 0 0", color: "var(--inno-danger)" }}>
						{t("course.library.parseFailed", { message: source.source.error })}
					</p>
				) : null}
				{status !== "indexed" && status !== "error" ? (
					<p className="mla-small mla-muted" style={{ margin: "6px 0 0" }}>
						{t("course.library.notIndexedYet")}
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
					{expanded ? t("course.library.hideSections") : t("course.library.showSections")}
				</Button>
				{status === "error" ? (
					<Button size="xs" disabled={busy} onClick={() => void coursesStore.retrySource(courseId, source.source_id)}>
						<RefreshCw size={14} />
						{t("course.library.retryParse")}
					</Button>
				) : null}
				{confirmingUnlink ? (
					<div className="mla-inline" style={{ justifyContent: "flex-end" }}>
						<Button size="xs" onClick={() => setConfirmingUnlink(false)}>{t("course.library.cancel")}</Button>
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
							{t("course.library.confirmUnlink")}
						</Button>
					</div>
				) : (
					<Button size="xs" disabled={busy} onClick={() => setConfirmingUnlink(true)}>
						<Unlink size={14} />
						{t("course.library.unlink")}
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
	const { t } = useTranslation();
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
		const owners = candidate.courses.map((owner) => owner.title).join(t("course.library.ownerSeparator"));
		return owners ? t("course.library.candidateOwnedBy", { title: candidate.title, owners }) : candidate.title;
	};

	if (state.error) {
		return <p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{state.error}</p>;
	}
	if (state.loading && state.candidates.length === 0) {
		return (
			<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
				<Loader2 size={14} className="mla-spin" aria-hidden="true" />{t("course.library.candidatesLoading")}
			</p>
		);
	}
	if (state.candidates.length === 0) {
		return (
			<p className="mla-small mla-muted" style={{ margin: 0 }}>
				{t("course.library.noCandidates")}
			</p>
		);
	}

	return (
		<div className="mla-stack" style={{ gap: 8 }}>
			<div className="mla-inline">
				<Select value={selected || "none"} disabled={state.pendingAction !== null} onValueChange={(value) => setSelected(value === "none" ? "" : value)}>
					<SelectTrigger aria-label={t("course.library.selectSourceAria")}><SelectValue /></SelectTrigger>
					<SelectContent>
						<SelectOption value="none" label={t("course.library.selectSourcePlaceholder")} />
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
					{t("course.library.bindToCourse")}
				</Button>
			</div>
			{chosen ? (
				<p className="mla-small mla-muted" style={{ margin: 0 }}>
					{t("course.library.passageCount", { count: chosen.passage_count })}
					{chosen.courses.length > 0
						? t("course.library.chosenShared", {
							owners: chosen.courses.map((owner) => owner.title).join(t("course.library.ownerSeparator")),
						})
						: t("course.library.chosenUnowned")}
				</p>
			) : null}
		</div>
	);
}

export function CourseLibraryPanel({ courseId }: { courseId: string }) {
	const { t } = useTranslation();
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
			setUploadError(t("course.library.uploadTooLarge", { limit: DEFAULT_UPLOAD_MAX_LABEL }));
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
						<h2>{t("course.library.title")}</h2>
						<span className="mla-small mla-muted">
							{t("course.library.indexedSummary", { indexed, total: state.sources.length })}
						</span>
					</div>
					<div className="mla-toolbar">
						<input
							ref={fileInputRef}
							type="file"
							accept={ACCEPT}
							aria-label={t("course.library.pickFileAria")}
							style={{ display: "none" }}
							onChange={(event) => {
								const file = event.target.files?.[0] ?? null;
								void onPickFile(file);
							}}
						/>
						<Button variant="primary" size="xs" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
							{uploading ? <Loader2 size={14} className="mla-spin" /> : <Upload size={14} />}
							{uploading ? t("course.library.uploading") : t("course.library.upload")}
						</Button>
					</div>
				</div>
				<p className="mla-small mla-muted" style={{ margin: 0 }}>
					{t("course.library.uploadHint", { limit: DEFAULT_UPLOAD_MAX_LABEL })}
				</p>
				{uploadError ? (
					<p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{uploadError}</p>
				) : null}

				{state.sourcesLoading && state.sources.length === 0 ? (
					<p className="mla-small mla-muted mla-inline" style={{ margin: 0 }}>
						<Loader2 size={14} className="mla-spin" aria-hidden="true" />{t("course.library.sourcesLoading")}
					</p>
				) : state.sourcesError ? (
					<p className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>{state.sourcesError}</p>
				) : state.sources.length === 0 ? (
					<div className="mla-empty">
						<FileText size={26} aria-hidden="true" />
						<strong>{t("course.library.emptyTitle")}</strong>
						<p className="mla-small" style={{ margin: 0, maxWidth: 520 }}>
							{t("course.library.emptyHint")}
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
					<h2>{t("course.library.bindTitle")}</h2>
				</div>
				<p className="mla-small mla-muted" style={{ margin: 0 }}>
					{t("course.library.bindHint")}
				</p>
				<BindExistingSource courseId={courseId} />
			</section>
		</div>
	);
}
