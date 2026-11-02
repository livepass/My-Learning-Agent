import { MarkdownArtifact } from "./MarkdownArtifact.js";
import { appStore } from "../stores/app-store.js";
import { chatStore } from "../stores/chat-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { useStoreSnapshot } from "./hooks.js";
import { Button, Spinner, Textarea } from "./ui/index.js";

/**
 * Chat surface over the existing session/chat owners.
 *
 * No conversation persistence lives here: `sessionsStore` owns session
 * lifecycle and `chatStore` owns the stream. The shell owns the draft so a page
 * switch does not discard what the user was typing.
 */
export function LearningWorkspace() {
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
	}));

	const busy = chat.sending;

	const send = async () => {
		if (!draft.trim() || busy) return;
		const prompt = draft;
		appStore.setChatDraft("");
		try {
			if (!sessionsStore.currentSessionId) await sessionsStore.createSessionWith();
			if (!sessionsStore.currentSessionId) {
				appStore.setChatDraft(prompt);
				return;
			}
			await chatStore.send(prompt);
		} catch {
			appStore.setChatDraft(prompt);
		}
	};

	return (
		<div className="mla-chat">
			<div className="mla-chat-scroll" aria-live="polite" aria-busy={chat.sending}>
				{chat.loadingHistory ? (
					<p className="mla-small mla-muted" style={{ margin: 0 }}>正在加载会话…</p>
				) : null}

				{/* Covers stream failures and a deep link to a session that no longer
				    exists; both arrive through `chatStore.streamingError`. */}
				{chat.error ? (
					<p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
						{chat.error}
					</p>
				) : null}

				{!chat.loadingHistory && chat.messages.length === 0 ? (
					<div className="mla-empty">
						<strong>直接提问，或围绕一个小目标开始学习。</strong>
						<p className="mla-small" style={{ margin: 0 }}>
							学习助手会结合你的学习档案回答；先讲清目标，再逐步练习。
						</p>
					</div>
				) : null}

				{chat.messages.map((message, index) => {
					const isLast = index === chat.messages.length - 1;
					if (message.role === "user") {
						return (
							<div className="mla-message-user" key={index}>
								<span className="mla-message-label">你</span>
								<div className="mla-message-user-bubble">{message.content}</div>
							</div>
						);
					}
					return (
						<article className="mla-message-assistant" key={index}>
							<span className="mla-message-label">学习助手</span>
							<MarkdownArtifact content={message.content} streaming={chat.sending && isLast} />
							{message.error ? (
								<p role="alert" className="mla-small" style={{ margin: 0, color: "var(--inno-danger)" }}>
									{message.error}
								</p>
							) : null}
						</article>
					);
				})}
			</div>

			<div className="mla-composer">
				<div className="mla-composer-inner">
					<Textarea
						aria-label="学习问题"
						placeholder={session.currentSessionId ? "继续提问…" : "说说你想学什么…"}
						value={draft}
						rows={2}
						onChange={(event) => appStore.setChatDraft(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
								event.preventDefault();
								void send();
							}
						}}
					/>
					<div className="mla-composer-actions">
						<span className="mla-small mla-muted">
							学习模式 · 练习评分与资料导入尚未开放
						</span>
						<div className="mla-inline">
							{busy ? (
								<Button onClick={() => chatStore.cancel()}>停止</Button>
							) : (
								<Button
									variant="primary"
									disabled={!draft.trim() || Boolean(session.openingSessionId)}
									onClick={() => void send()}
								>
									{session.openingSessionId ? <Spinner size={16} /> : "发送"}
								</Button>
							)}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
