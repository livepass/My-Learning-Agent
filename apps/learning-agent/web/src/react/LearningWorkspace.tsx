import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ArrowUp, ChevronDown, Copy, Pencil, Square } from "lucide-react";
import { MarkdownArtifact } from "./MarkdownArtifact.js";
import { appStore } from "../stores/app-store.js";
import { chatStore } from "../stores/chat-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { settingsStore } from "../stores/settings-store.js";
import { useStoreSnapshot } from "./hooks.js";
import {
	Button,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
	IconButton,
	Spinner,
	Textarea,
} from "./ui/index.js";
import { branchSessionBeforeMessage } from "../api/sessions.js";
import { getLearningState } from "../api/learning.js";
import type { ChatAttachments, ChatMessage } from "../types/chat.js";
import type { InnoModelInfo } from "../types/settings.js";
import { navigate } from "./shell/navigation.js";
import { learnWorkbenchStore, type CreatedConversation } from "../stores/learn-workbench-store.js";

const MAX_COMPOSER_HEIGHT = 200;
const COPY_FEEDBACK_MS = 2_400;

interface EditState {
	sessionId: string;
	entryId: string;
	original: string;
	/** The server branch has landed; a failed resend must not branch again. */
	branched: boolean;
	/** Branch head created by the server; the resend must still append to it. */
	branchMarkerId?: string;
}

interface CopyFeedback {
	key: string;
	ok: boolean;
}

function modelKey(provider: string, model: string): string {
	return JSON.stringify([provider, model]);
}

function parseModelKey(value: string): { provider: string; model: string } | null {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
			return { provider: parsed[0], model: parsed[1] };
		}
	} catch {
		// Ignore malformed option values.
	}
	return null;
}

function hasAttachmentFiles(attachments?: ChatAttachments): boolean {
	return Boolean(attachments && (attachments.bindings.some((binding) => binding.files.length > 0) || attachments.loose.length > 0));
}

/** Persisted, pure-text user turn with a PI entry id. */
function isEditableUserMessage(message: ChatMessage): boolean {
	return message.role === "user"
		&& Boolean(message.entryId)
		&& !message.transient
		&& !message.images?.length
		&& !hasAttachmentFiles(message.attachments)
		&& Boolean(message.content.trim())
		&& (!message.channel || message.channel === "web");
}

/**
 * Conservative edit guard. Editing a user turn branches the conversation away
 * from every later answer, so a session that already carries formal evidence
 * (or an in-progress question/attempt) is refused rather than risking an
 * inconsistent B2/L1 account. Nothing in the learning store is modified here.
 */
async function editingBlockReason(sessionId: string, t: TFunction): Promise<string | null> {
	let state: Awaited<ReturnType<typeof getLearningState>>;
	try {
		state = await getLearningState(sessionId);
	} catch {
		return t("learn.workspace.edit.unavailable");
	}
	if (!state.exists) return null;

	const checkpoint = state.checkpoint;
	const attempts = state.attempts ?? [];
	const recorded = Boolean(checkpoint?.last_completed_attempt_id)
		|| checkpoint?.status === "completed"
		|| attempts.some((attempt) =>
			attempt.stage === "completed"
			|| attempt.stage === "evidence_recorded"
			|| attempt.stage === "profile_projected");
	if (recorded) {
		return t("learn.workspace.edit.evidenceLocked");
	}
	// Same conservative policy the server enforces inside the branch: any saved
	// answer — even one still waiting for evaluation — blocks the edit.
	if (attempts.length > 0) {
		return t("learn.workspace.edit.attemptPending");
	}
	if (
		checkpoint?.question
		|| checkpoint?.pending_attempt_id
		|| state.pending_action
		|| (state.questions ?? []).length > 0
	) {
		return t("learn.workspace.edit.taskPending");
	}
	return null;
}

function branchErrorMessage(error: unknown, t: TFunction): string {
	const status = (error as { status?: number } | undefined)?.status;
	const data = (error as { data?: Record<string, unknown> } | undefined)?.data;
	// The server refuses with a specific code; prefer its own Chinese message.
	const message = typeof data?.message === "string" ? data.message : "";
	const code = (typeof data?.code === "string" ? data.code : undefined)
		?? (typeof data?.error === "string" ? data.error : undefined);
	if (code === "entry_not_found") return t("learn.workspace.edit.entryNotFound");
	if (code === "not_active_branch") return t("learn.workspace.edit.notActiveBranch");
	if (code === "learning_evidence_locked"
		|| code === "learning_attempt_pending"
		|| code === "learning_task_pending") {
		return message || t("learn.workspace.edit.learningLocked");
	}
	if (code === "session_deleting") return t("learn.workspace.edit.sessionDeleting");
	if (code === "learning_corrupt" || code === "learning_unavailable" || code === "learning_read_only") {
		return t("learn.workspace.edit.unavailable");
	}
	if (status === 409) return message || t("learn.workspace.edit.busy");
	if (status === 404) return t("learn.workspace.edit.gone");
	return error instanceof Error ? error.message : t("learn.workspace.edit.branchFailed");
}

async function writeClipboard(text: string): Promise<void> {
	if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(text);
		return;
	}
	if (typeof document === "undefined") throw new Error("Clipboard unavailable");
	const area = document.createElement("textarea");
	area.value = text;
	area.setAttribute("readonly", "");
	area.style.position = "fixed";
	area.style.opacity = "0";
	document.body.appendChild(area);
	area.select();
	const copied = typeof document.execCommand === "function" && document.execCommand("copy");
	document.body.removeChild(area);
	if (!copied) throw new Error("Copy failed");
}

function useAutoGrow(value: string, maxHeight = MAX_COMPOSER_HEIGHT) {
	const ref = useRef<HTMLTextAreaElement | null>(null);
	useLayoutEffect(() => {
		const node = ref.current;
		if (!node) return;
		node.style.height = "auto";
		const scrollHeight = node.scrollHeight || 0;
		node.style.height = `${Math.max(44, Math.min(scrollHeight, maxHeight))}px`;
		node.style.overflowY = scrollHeight > maxHeight ? "auto" : "hidden";
	}, [value, maxHeight]);
	return ref;
}

interface ModelPickerProps {
	models: InnoModelInfo[];
	provider: string;
	model: string;
	loading: boolean;
	disabled: boolean;
	onSelect: (provider: string, model: string) => void;
	onOpenSettings: () => void;
}

/** Compact global-default model picker; values come only from configured models. */
function ModelPicker({ models, provider, model, loading, disabled, onSelect, onOpenSettings }: ModelPickerProps) {
	const { t } = useTranslation();
	if (loading) {
		return <span className="mla-model-status">{t("learn.workspace.model.loading")}</span>;
	}
	if (models.length === 0) {
		return (
			<button type="button" className="mla-model-connect" onClick={onOpenSettings}>
				{t("learn.workspace.model.connect")}
			</button>
		);
	}
	const current = models.find((item) => item.provider === provider && item.id === model);
	const value = current ? modelKey(current.provider, current.id) : "";
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button type="button" className="mla-model-trigger" aria-label={t("learn.workspace.model.select")} disabled={disabled}>
					<span className="mla-model-current">
						<span className="mla-model-name">
							{current?.name || model || t("learn.workspace.model.select")}
						</span>
						<span className="mla-model-provider">
							{current?.provider || provider || t("learn.workspace.model.disconnected")}
						</span>
					</span>
					<ChevronDown size={14} className="mla-model-chevron" aria-hidden="true" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="mla-model-menu">
				<DropdownMenuRadioGroup
					value={value}
					onValueChange={(next) => {
						const parsed = parseModelKey(next);
						if (parsed) onSelect(parsed.provider, parsed.model);
					}}
				>
					{models.map((item) => (
						<DropdownMenuRadioItem
							key={modelKey(item.provider, item.id)}
							value={modelKey(item.provider, item.id)}
							className="mla-model-option"
						>
							<span className="mla-model-option-text">
								<span>{item.name || item.id}</span>
								<small>{item.provider}</small>
							</span>
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

interface MessageActionsProps {
	messageKey: string;
	user: boolean;
	copyState: CopyFeedback | null;
	onCopy: () => void;
	onEdit?: () => void;
	editDisabled?: boolean;
	copyDisabled?: boolean;
}

function MessageActions({ messageKey, user, copyState, onCopy, onEdit, editDisabled, copyDisabled }: MessageActionsProps) {
	const { t } = useTranslation();
	const feedback = copyState?.key === messageKey ? copyState : null;
	return (
		<div className={`mla-message-actions${user ? " mla-message-actions--user" : ""}`}>
			<IconButton
				size="xs"
				aria-label={user ? t("learn.workspace.copy.userAria") : t("learn.workspace.copy.replyAria")}
				title={user ? t("learn.workspace.copy.userTitle") : t("learn.workspace.copy.replyTitle")}
				disabled={copyDisabled}
				onClick={onCopy}
			>
				<Copy size={14} aria-hidden="true" />
			</IconButton>
			{user && onEdit ? (
				<IconButton
					size="xs"
					aria-label={t("learn.workspace.edit.aria")}
					title={editDisabled ? t("learn.workspace.edit.disabledTitle") : t("learn.workspace.edit.title")}
					disabled={editDisabled}
					onClick={onEdit}
				>
					<Pencil size={14} aria-hidden="true" />
				</IconButton>
			) : null}
			{feedback ? (
				<span
					role={feedback.ok ? "status" : "alert"}
					className={feedback.ok ? "mla-copy-feedback" : "mla-copy-feedback mla-copy-feedback--error"}
				>
					{feedback.ok ? t("learn.workspace.copy.done") : t("learn.workspace.copy.failed")}
				</span>
			) : null}
		</div>
	);
}

interface EditBoxProps {
	draft: string;
	error: string;
	sending: boolean;
	models: InnoModelInfo[];
	provider: string;
	model: string;
	modelsLoading: boolean;
	modelSaving: boolean;
	onDraft: (value: string) => void;
	onCancel: () => void;
	onSend: () => void;
	onSelectModel: (provider: string, model: string) => void;
	onOpenSettings: () => void;
}

function EditBox({
	draft,
	error,
	sending,
	models,
	provider,
	model,
	modelsLoading,
	modelSaving,
	onDraft,
	onCancel,
	onSend,
	onSelectModel,
	onOpenSettings,
}: EditBoxProps) {
	const { t } = useTranslation();
	const ref = useAutoGrow(draft);
	const busy = sending || modelSaving;
	return (
		<div className="mla-message-edit" role="group" aria-label={t("learn.workspace.edit.group")}>
			<Textarea
				ref={ref}
				aria-label={t("learn.workspace.edit.content")}
				value={draft}
				rows={1}
				disabled={sending}
				onChange={(event) => onDraft(event.target.value)}
			/>
			{error ? <p role="alert" className="mla-message-edit-error">{error}</p> : null}
			<div className="mla-message-edit-actions">
				<ModelPicker
					models={models}
					provider={provider}
					model={model}
					loading={modelsLoading}
					disabled={busy}
					onSelect={onSelectModel}
					onOpenSettings={onOpenSettings}
				/>
				<div className="mla-inline">
					<Button variant="ghost" onClick={onCancel} disabled={sending}>
						{t("learn.workspace.edit.cancel")}
					</Button>
					<Button
						variant="primary"
						aria-label={t("learn.workspace.edit.send")}
						disabled={!draft.trim() || busy}
						onClick={onSend}
					>
						{sending ? <Spinner size={16} /> : t("learn.workspace.edit.send")}
					</Button>
				</div>
			</div>
		</div>
	);
}

/**
 * Chat surface over the existing session/chat owners.
 *
 * No conversation persistence lives here: `sessionsStore` owns session
 * lifecycle and `chatStore` owns the stream. The shell owns the draft so a page
 * switch does not discard what the user was typing. Editing keeps a separate
 * draft and never writes to `appStore.chatDraft`.
 */
/**
 * `readOnly` keeps a history-only conversation readable without a composer.
 *
 * Two independent states produce it and they need different advice: the session
 * itself was archived, or its parent course was. The server refuses writes in
 * both cases, so the banner must not tell the learner to restore the wrong one.
 */
export type LearningReadOnlyReason = "session" | "course" | "unclassified";

/** Why the composer is unavailable on the course workbench (E4.8). */
export interface LearningBlock {
	title: string;
	description: string;
	actionLabel?: string;
	onAction?: () => void;
}

export function LearningWorkspace({
	readOnly = false,
	blocked = null,
	creating = false,
	createError = null,
	createConversation,
	welcome,
	emptyState,
	composerPlaceholder,
	composerDisabled = false,
}: {
	readOnly?: LearningReadOnlyReason | false;
	/**
	 * E4.8: shown instead of the composer when the workbench cannot accept a
	 * message at all — no course yet, or a course whose status forbids new
	 * learning.
	 */
	blocked?: LearningBlock | null;
	/** `learning/start` is in flight; blocks a second click. */
	creating?: boolean;
	/** Failure of the conversation creation, kept above the composer. */
	createError?: string | null;
	/**
	 * Creates the course-bound conversation for the first turn. Its result names
	 * both the conversation and the course, so the send can verify it has not
	 * been overtaken by a course switch. Replaced by a course-less
	 * `createSessionWith()` only when absent (legacy callers/tests).
	 */
	createConversation?: () => Promise<CreatedConversation | null>;
	/**
	 * E4.8b: content of the conversation-style home (greeting, course cards or
	 * quick starts). Rendered *above* the composer in place of the message list,
	 * so the first screen of the page reads as a chat home.
	 */
	welcome?: ReactNode;
	/**
	 * E4.8f: content for a conversation that exists but has no message yet — a
	 * short, course-specific hint plus a few starter questions. It replaces the
	 * generic empty card, so opening a fresh conversation is not a blank page.
	 * Never rendered once a message exists.
	 */
	emptyState?: ReactNode;
	/** E4.8b: composer hint; the caller knows the selected course. */
	composerPlaceholder?: string;
	/**
	 * E4.8b: the composer is visible but cannot send yet (no course selected, or
	 * a course whose status forbids new learning). The textarea and the send
	 * button are disabled; `blocked` still replaces the composer with a notice.
	 */
	composerDisabled?: boolean;
} = {}) {
	const { t } = useTranslation();
	const { draft } = useStoreSnapshot(appStore, () => ({ draft: appStore.chatDraft }));
	const session = useStoreSnapshot(sessionsStore, () => ({
		currentSessionId: sessionsStore.currentSessionId,
		openingSessionId: sessionsStore.openingSessionId,
	}));
	const chat = useStoreSnapshot(chatStore, () => ({
		messages: chatStore.messages,
		sending: chatStore.isSending,
		loadingHistory: chatStore.isLoadingHistory,
		error: chatStore.streamingError,
		streamingText: chatStore.streamingText,
		streamingActivity: chatStore.streamingActivity,
	}));
	const modelState = useStoreSnapshot(settingsStore, () => ({
		settings: settingsStore.settings,
		loading: settingsStore.isLoading,
		saving: settingsStore.isSavingModel,
		error: settingsStore.error,
	}));

	const [editing, setEditing] = useState<EditState | null>(null);
	const [editDraft, setEditDraft] = useState("");
	const [editError, setEditError] = useState("");
	const [editChecking, setEditChecking] = useState(false);
	const [editSending, setEditSending] = useState(false);
	const [blockedNotice, setBlockedNotice] = useState("");
	const [modelError, setModelError] = useState("");
	const [copyState, setCopyState] = useState<CopyFeedback | null>(null);

	const scrollRef = useRef<HTMLDivElement | null>(null);
	const stickToBottom = useRef(true);
	const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const composerRef = useAutoGrow(draft);
	const normalTextareaRef = composerRef;

	const models = modelState.settings?.configuredModels ?? [];
	const provider = modelState.settings?.defaultProvider ?? "";
	const model = modelState.settings?.defaultModel ?? "";
	const modelSaving = modelState.saving;
	const modelsLoading = modelState.loading || (!modelState.settings && !modelState.error);
	const busy = chat.sending;

	useEffect(() => {
		if (!settingsStore.settings && !settingsStore.isLoading) void settingsStore.load();
	}, []);

	useEffect(() => () => {
		if (copyTimer.current) clearTimeout(copyTimer.current);
	}, []);

	useEffect(() => {
		stickToBottom.current = true;
	}, [session.currentSessionId]);

	useLayoutEffect(() => {
		if (!stickToBottom.current) return;
		const node = scrollRef.current;
		if (!node) return;
		node.scrollTop = node.scrollHeight;
	}, [chat.messages.length, chat.streamingText, chat.loadingHistory, chat.sending]);

	useEffect(() => {
		if (editing && editing.sessionId !== session.currentSessionId) {
			setEditing(null);
			setEditDraft("");
			setEditError("");
			setEditSending(false);
			setBlockedNotice("");
		}
	}, [editing, session.currentSessionId]);

	const resetEdit = () => {
		setEditing(null);
		setEditDraft("");
		setEditError("");
		setEditSending(false);
	};

	const send = async () => {
		if (!draft.trim() || busy || modelSaving || editing || blocked || creating || composerDisabled) return;
		const prompt = draft;
		stickToBottom.current = true;
		appStore.setChatDraft("");

		// The send is bound to the course and conversation visible right now. Any
		// switch bumps the workbench epoch, so a late answer cannot send this
		// prompt elsewhere or put the draft back into another course's composer.
		const courseBefore = learnWorkbenchStore.courseId;
		const sessionBefore = sessionsStore.currentSessionId;
		/** The prompt goes back only if this exact intent is still on screen. */
		const restoreDraft = () => {
			if (learnWorkbenchStore.courseId === courseBefore && sessionsStore.currentSessionId === sessionBefore) {
				appStore.setChatDraft(prompt);
			}
		};

		try {
			// E4.8: a Web learning conversation is always course-bound. The
			// workbench creates it through `learning/start` on the first send, so
			// the message is only dispatched after the server confirmed the binding
			// and the learning record. When a course-aware factory is provided a
			// failure ends this send: falling back to `createSessionWith()` would
			// create exactly the unbound Web conversation the rule forbids.
			if (!sessionBefore && createConversation) {
				const created = await createConversation();
				if (!created) {
					restoreDraft();
					return;
				}
				// The conversation was created inside `created.courseId`; if the
				// workbench or the open conversation moved while it was being
				// created, the message is dropped instead of landing in the new one.
				if (!learnWorkbenchStore.isCurrent(created.courseId, created.sessionId)) return;
				await chatStore.send(prompt);
				return;
			}
			// Compatibility path for callers without a course-aware factory.
			if (!sessionBefore) await sessionsStore.createSessionWith();
			if (!sessionsStore.currentSessionId) {
				restoreDraft();
				return;
			}
			// Final re-check immediately before the write.
			if (learnWorkbenchStore.courseId !== courseBefore) return;
			if (sessionBefore && sessionsStore.currentSessionId !== sessionBefore) return;
			await chatStore.send(prompt);
		} catch {
			restoreDraft();
		}
	};

	const chooseModel = async (nextProvider: string, nextModel: string) => {
		if (busy || editSending || modelSaving) return;
		setModelError("");
		const ok = await settingsStore.switchModel(nextProvider, nextModel);
		if (!ok) setModelError(settingsStore.error || t("learn.workspace.model.switchFailed"));
	};

	const copyMessage = async (key: string, text: string) => {
		try {
			await writeClipboard(text);
			setCopyState({ key, ok: true });
		} catch {
			setCopyState({ key, ok: false });
		}
		if (copyTimer.current) clearTimeout(copyTimer.current);
		copyTimer.current = setTimeout(() => setCopyState(null), COPY_FEEDBACK_MS);
	};

	const beginEdit = async (message: ChatMessage) => {
		if (busy || editSending || editChecking || modelSaving) return;
		if (!isEditableUserMessage(message)) return;
		const sessionId = sessionsStore.currentSessionId;
		if (!sessionId) return;
		setBlockedNotice("");
		setEditError("");
		setEditChecking(true);
		try {
			const reason = await editingBlockReason(sessionId, t);
			if (sessionsStore.currentSessionId !== sessionId) {
				setBlockedNotice(t("learn.workspace.edit.sessionSwitched"));
				return;
			}
			if (reason) {
				setBlockedNotice(reason);
				return;
			}
			setEditing({
				sessionId,
				entryId: message.entryId!,
				original: message.content,
				branched: false,
			});
			setEditDraft(message.content);
		} finally {
			setEditChecking(false);
		}
	};

	const sendEdit = async () => {
		if (!editing || editSending || busy || modelSaving) return;
		const sessionId = sessionsStore.currentSessionId;
		if (sessionId !== editing.sessionId) {
			setEditError(t("learn.workspace.edit.sessionSwitchedSend"));
			return;
		}
		const text = editDraft.trim();
		if (!text) return;
		if (!editing.branched && !chatStore.messages.some((message) =>
			message.role === "user" && message.entryId === editing.entryId)) {
			setEditError(t("learn.workspace.edit.notInBranch"));
			return;
		}

		setEditSending(true);
		setEditError("");
		setBlockedNotice("");
		let branched = editing.branched;
		let branchMarkerId = editing.branchMarkerId;
		try {
			if (!branched) {
				const reason = await editingBlockReason(sessionId, t);
				if (reason) {
					setEditError(reason);
					return;
				}
				if (sessionsStore.currentSessionId !== sessionId) {
					setEditError(t("learn.workspace.edit.sessionSwitchedSend"));
					return;
				}
				try {
					const branch = await branchSessionBeforeMessage(sessionId, editing.entryId);
					branchMarkerId = branch.branchMarkerId;
				} catch (err) {
					setEditError(branchErrorMessage(err, t));
					return;
				}
				// From here the server branch exists. Keep this flag even if the
				// resend fails so a retry never branches the same entry twice.
				branched = true;
				setEditing((current) => current ? { ...current, branched: true, branchMarkerId } : current);
				if (sessionsStore.currentSessionId !== sessionId) {
					setEditError(t("learn.workspace.edit.sessionSwitchedSend"));
					return;
				}
				if (!chatStore.branchBefore(editing.entryId)) {
					setEditError(t("learn.workspace.edit.branchViewStale"));
					return;
				}
			}

			if (sessionsStore.currentSessionId !== sessionId) {
				setEditError(t("learn.workspace.edit.sessionSwitchedSend"));
				return;
			}

			stickToBottom.current = true;
			chatStore.lastSendOutcome = null;
			chatStore.lastTerminalCode = null;
			// The server verifies this branch marker in the queue slot that runs
			// the prompt. If another request changed the conversation in between,
			// the message is refused instead of being appended to the new context.
			await chatStore.send(text, undefined, undefined, undefined, branchMarkerId);
			if (chatStore.lastSendOutcome !== "completed") {
				setEditing((current) => current ? { ...current, branched: true, branchMarkerId } : current);
				setEditError(chatStore.lastTerminalCode === "stale_branch"
					? t("learn.workspace.edit.staleBranch")
					: chatStore.lastSendOutcome === "aborted"
						? t("learn.workspace.edit.aborted")
						: t("learn.workspace.edit.sendFailed"));
				return;
			}
			resetEdit();
		} finally {
			setEditSending(false);
		}
	};

	const showInlineEditor = Boolean(editing && !editing.branched && chat.messages.some((message) =>
		message.role === "user" && message.entryId === editing.entryId));
	const showTrailingEditor = Boolean(editing && !showInlineEditor && !editSending);
	const streamingVisible = chat.sending && (Boolean(chat.streamingText) || Boolean(chat.streamingActivity));

	const emptyStart = Boolean(emptyState) && !welcome && !blocked && !readOnly
		&& !chat.loadingHistory && chat.messages.length === 0 && !chat.sending;

	return (
		<div className={`mla-chat${emptyStart ? " mla-chat--empty-start" : ""}`}>
			<div
				className="mla-chat-scroll"
				ref={scrollRef}
				aria-live="polite"
				aria-busy={chat.sending}
				onScroll={() => {
					const node = scrollRef.current;
					if (!node) return;
					stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
				}}
			>
				{chat.loadingHistory ? (
					<p className="mla-small mla-muted" style={{ margin: 0 }}>{t("learn.workspace.loadingSession")}</p>
				) : null}

				{chat.error ? (
					<p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
						{chat.error}
					</p>
				) : null}

				{welcome ? (
					// E4.8b/E4.8f: the conversation-style home owns the scroll area; it
					// is only rendered when no conversation is open, so no message can
					// be hidden behind it. Its slot is centred together with the
					// composer below, which keeps greeting → cards → input one group.
					<div className="mla-welcome-slot">{welcome}</div>
				) : null}

				{!welcome && emptyState && !blocked && !readOnly && !chat.loadingHistory
					&& chat.messages.length === 0 && !chat.sending ? (
					// E4.8f: a conversation exists but is still empty. The hint and
					// starters sit in the same centred group as the composer.
					<div className="mla-empty-slot">{emptyState}</div>
				) : null}

				{!welcome && !emptyState && !blocked && !readOnly && !chat.loadingHistory
					&& chat.messages.length === 0 && !chat.sending ? (
					<div className="mla-empty">
						<strong>{t("learn.workspace.empty.title")}</strong>
						<p className="mla-small" style={{ margin: 0 }}>
							{t("learn.workspace.empty.description")}
						</p>
					</div>
				) : null}

				{chat.messages.map((message, index) => {
					const key = message.entryId ?? `${message.role}-${index}`;
					const isLast = index === chat.messages.length - 1;
					if (message.role === "user") {
						if (editing && !editing.branched && editing.entryId === message.entryId) {
							return (
								<div className="mla-message-user mla-message-user--editing" key={key}>
									<EditBox
										draft={editDraft}
										error={editError}
										sending={editSending}
										models={models}
										provider={provider}
										model={model}
										modelsLoading={modelsLoading}
										modelSaving={modelSaving}
										onDraft={setEditDraft}
										onCancel={resetEdit}
										onSend={() => void sendEdit()}
										onSelectModel={(nextProvider, nextModel) => void chooseModel(nextProvider, nextModel)}
										onOpenSettings={() => navigate("settings", { history: "push", settingsTab: "models" })}
									/>
								</div>
							);
						}
						const editable = !readOnly && isEditableUserMessage(message);
						return (
							<div className="mla-message-user" key={key}>
								<div className="mla-message-user-bubble">{message.content}</div>
								<MessageActions
									messageKey={key}
									user
									copyState={copyState}
									onCopy={() => void copyMessage(key, message.content)}
									onEdit={editable ? () => void beginEdit(message) : undefined}
									editDisabled={busy || editChecking || Boolean(editing)}
								/>
							</div>
						);
					}
					return (
						<article className="mla-message-assistant" key={key}>
							<MarkdownArtifact content={message.content} streaming={chat.sending && isLast} />
							{message.error ? (
								<p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
									{message.error}
								</p>
							) : null}
							<MessageActions
								messageKey={key}
								user={false}
								copyState={copyState}
								onCopy={() => void copyMessage(key, message.content)}
								copyDisabled={!message.content.trim() || (chat.sending && isLast)}
							/>
						</article>
					);
				})}

				{streamingVisible ? (
					<article className="mla-message-assistant mla-message-assistant--streaming" aria-busy="true">
						{chat.streamingText ? (
							<MarkdownArtifact content={chat.streamingText} streaming />
						) : (
							<p className="mla-streaming-status" role="status">
								{chat.streamingActivity || t("learn.workspace.generating")}
							</p>
						)}
					</article>
				) : null}

				{showTrailingEditor ? (
					<div className="mla-message-user mla-message-user--editing">
						<EditBox
							draft={editDraft}
							error={editError}
							sending={editSending}
							models={models}
							provider={provider}
							model={model}
							modelsLoading={modelsLoading}
							modelSaving={modelSaving}
							onDraft={setEditDraft}
							onCancel={resetEdit}
							onSend={() => void sendEdit()}
							onSelectModel={(nextProvider, nextModel) => void chooseModel(nextProvider, nextModel)}
							onOpenSettings={() => navigate("settings", { history: "push", settingsTab: "models" })}
						/>
					</div>
				) : null}
			</div>

			{blockedNotice ? (
				<p role="alert" className="mla-composer-notice">{blockedNotice}</p>
			) : null}

			{createError ? (
				<p role="alert" className="mla-composer-notice">{createError}</p>
			) : null}

			{blocked ? (
				<div className="mla-notice mla-notice--info mla-composer-blocked" role="status">
					<strong>{blocked.title}</strong>
					<p className="mla-small" style={{ margin: "4px 0 0" }}>{blocked.description}</p>
					{blocked.actionLabel && blocked.onAction ? (
						<Button style={{ marginTop: 8 }} onClick={blocked.onAction}>
							{blocked.actionLabel}
						</Button>
					) : null}
				</div>
			) : readOnly ? (
				<p className="mla-notice mla-notice--info" role="status">
					{readOnly === "session"
						? t("learn.workspace.readOnly.session")
						: readOnly === "unclassified"
							? t("learn.workspace.readOnly.unclassified")
							: t("learn.workspace.readOnly.course")}
				</p>
			) : (
			<div className="mla-composer">
				<div className="mla-composer-inner">
					<Textarea
						ref={normalTextareaRef}
						aria-label={t("learn.workspace.composer.aria")}
						placeholder={composerPlaceholder
							?? (session.currentSessionId
								? t("learn.workspace.composer.continue")
								: t("learn.workspace.composer.start"))}
						value={draft}
						rows={1}
						disabled={Boolean(editing) || creating || composerDisabled}
						onChange={(event) => {
							// A disabled composer must never stage a draft either: the
							// draft is shared with the shell, so a programmatic change
							// event (or a stale IME commit) would otherwise survive the
							// "no course selected" gate.
							if (composerDisabled) return;
							appStore.setChatDraft(event.target.value);
						}}
					/>
					<div className="mla-composer-actions">
						<div className="mla-composer-model">
							<ModelPicker
								models={models}
								provider={provider}
								model={model}
								loading={modelState.loading}
								disabled={busy || modelSaving || Boolean(editing)}
								onSelect={(nextProvider, nextModel) => void chooseModel(nextProvider, nextModel)}
								onOpenSettings={() => navigate("settings", { history: "push", settingsTab: "models" })}
							/>
							{modelError ? (
								<span role="alert" className="mla-model-error">{modelError}</span>
							) : null}
						</div>
						<div className="mla-composer-send">
							{busy ? (
								<IconButton
									variant="secondary"
									shape="pill"
									className="mla-send-button mla-send-button--stop"
									aria-label={t("learn.workspace.send.stopAria")}
									title={t("learn.workspace.send.stopTitle")}
									onClick={() => chatStore.cancel()}
								>
									<Square size={14} aria-hidden="true" />
								</IconButton>
							) : (
								<IconButton
									variant="primary"
									shape="pill"
									className="mla-send-button"
									aria-label={t("learn.workspace.send.aria")}
									title={t("learn.workspace.send.title")}
									disabled={!draft.trim() || modelSaving || Boolean(editing) || Boolean(session.openingSessionId) || creating || composerDisabled}
									onClick={() => void send()}
								>
									{session.openingSessionId || creating ? <Spinner size={16} /> : <ArrowUp size={16} aria-hidden="true" />}
								</IconButton>
							)}
						</div>
					</div>
				</div>
			</div>
			)}
		</div>
	);
}
