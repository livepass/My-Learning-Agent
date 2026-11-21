import { useTranslation } from "react-i18next";
import { Archive, BookOpen, Loader2, MoreHorizontal, Trash2 } from "lucide-react";
import type { SessionMeta } from "../../../api/sessions.js";
import {
	Badge, DropdownMenu, DropdownMenuActionItem, DropdownMenuContent, DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../../ui/index.js";

/**
 * E4.9g-P2-1 — one conversation row on the AI learning page.
 *
 * Presentation only: opening, renaming, archiving and deleting remain the
 * page's responsibility. The row keeps the exact DOM, class names, aria
 * attributes and menu structure used before the extraction, because it is
 * reused by both the welcome history and the conversation sidebar.
 */
export function LearnSessionRow({
	session,
	active,
	busy,
	pending,
	unclassified,
	onOpen,
	onRename,
	onArchive,
	onDelete,
}: {
	session: SessionMeta;
	/** Current conversation, marked with aria-current. */
	active: boolean;
	/** Any session action is in flight: the whole row is not interactive. */
	busy: boolean;
	/** This row owns the in-flight action, so its menu trigger shows a spinner. */
	pending: boolean;
	/** Legacy conversation without a course binding; shown, never rebound. */
	unclassified: boolean;
	onOpen: () => void;
	onRename: () => void;
	onArchive: () => void;
	onDelete: () => void;
}) {
	const { t } = useTranslation();
	const name = session.name || t("learn.history.unnamed");
	const isFree = !session.course?.task_id;
	return (
		<div className="mla-session-row">
			<button
				type="button"
				className="mla-session-item"
				aria-current={active ? "true" : undefined}
				disabled={busy}
				onClick={onOpen}
			>
				<span className="mla-session-item-head">
					<strong>{name}</strong>
					{session.archived ? <Badge>{t("learn.history.archived")}</Badge> : null}
				</span>
				<span className="mla-session-item-preview">
					{session.preview || (session.messageCount > 0
						? t("learn.history.messageCount", { count: session.messageCount })
						: t("learn.history.noMessages"))}
				</span>
				<span className="mla-session-item-meta">
					{isFree ? t("learn.history.free") : t("learn.history.courseTask")}
					{unclassified ? t("learn.history.unclassifiedSuffix") : ""}
				</span>
			</button>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						className="mla-session-more"
						aria-label={t("learn.history.actions", { name })}
						disabled={busy}
					>
						{pending
							? <Loader2 size={16} className="mla-spin" aria-hidden="true" />
							: <MoreHorizontal size={16} aria-hidden="true" />}
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="mla-session-menu">
					<DropdownMenuActionItem
						icon={<BookOpen size={14} />}
						label={t("learn.history.rename")}
						onSelect={onRename}
					/>
					<DropdownMenuActionItem
						icon={<Archive size={14} />}
						label={t("learn.history.archive.label")}
						onSelect={onArchive}
					/>
					<DropdownMenuSeparator />
					<DropdownMenuActionItem
						variant="danger"
						icon={<Trash2 size={14} />}
						label={t("learn.history.delete.label")}
						onSelect={onDelete}
					/>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
