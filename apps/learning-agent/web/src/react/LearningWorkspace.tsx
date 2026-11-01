import { lazy, Suspense, useEffect, useState } from "react";
import { sessionsStore } from "../stores/sessions-store.js";
import { chatStore } from "../stores/chat-store.js";
import { appStore } from "../stores/app-store.js";
import { useStoreSnapshot } from "./hooks.js";
import { Button, Textarea, Spinner } from "./ui/index.js";
import { MarkdownArtifact } from "./MarkdownArtifact.js";
const SettingsOverlay = lazy(() => import("./settings/SettingsOverlay.js").then(module => ({ default: module.SettingsOverlay })));

/** S1 presentation over existing session/chat owners; no new conversation persistence. */
export function LearningWorkspace() {
	const [draft, setDraft] = useState("");
	const [creating, setCreating] = useState(false);
	const sessions = useStoreSnapshot(sessionsStore, () => sessionsStore.sessions);
	const chat = useStoreSnapshot(chatStore, () => ({ messages: chatStore.messages, sending: chatStore.isSending }));
	const settingsOpen = useStoreSnapshot(appStore, () => appStore.settingsOpen);
	useEffect(() => { void sessionsStore.load(); }, []);
	const send = async () => {
		if (!draft.trim() || chat.sending || creating) return;
		setCreating(true);
		try {
			if (!sessionsStore.currentSessionId) await sessionsStore.createSessionWith();
			if (!sessionsStore.currentSessionId) return;
			const prompt = draft; setDraft("");
			await chatStore.send(prompt);
		} finally { setCreating(false); }
	};
	return <div className="flex h-screen flex-col bg-[var(--inno-background)] text-[var(--inno-text)]">
		<header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--inno-border)] p-4">
			<h1>My Learning Agent</h1>
			<div className="flex gap-2">
				<Button disabled={chat.sending || creating} onClick={() => sessionsStore.beginNewSession()}>新建学习对话</Button>
				<Button onClick={() => appStore.openSettings()}>设置</Button>
			</div>
		</header>
		<main className="flex min-h-0 flex-1 max-sm:flex-col">
			<nav aria-label="学习对话" className="flex w-48 shrink-0 flex-col gap-2 overflow-y-auto border-r border-[var(--inno-border)] p-3 max-sm:max-h-32 max-sm:w-full max-sm:border-b max-sm:border-r-0">
				{sessions.length === 0 ? <p className="text-sm text-[var(--inno-text-muted)]">暂无学习对话</p> : null}
				{sessions.map(session => <Button key={session.id} disabled={chat.sending || creating} onClick={() => void sessionsStore.openSession(session.id)}>{session.name || session.id}</Button>)}
			</nav>
			<section className="flex min-w-0 flex-1 flex-col gap-3 p-4">
				<div className="min-h-0 flex-1 overflow-y-auto" aria-live="polite">
					{chat.messages.length === 0 ? <p>直接提问，或围绕一个小目标开始学习。</p> : chat.messages.map((message, index) => <article className="mb-4" key={index}>
						<p className="text-sm text-[var(--inno-text-muted)]">{message.role === "user" ? "你" : "学习助手"}</p>
						<MarkdownArtifact content={message.content} streaming={chat.sending && index === chat.messages.length - 1} />
						{message.error ? <p role="alert">{message.error}</p> : null}
					</article>)}
				</div>
				<p className="text-sm text-[var(--inno-text-muted)]">学习模式 · 当前支持对话和学习状态查询；练习评分、资料导入和学习进度恢复将在后续开放。</p>
				<Textarea aria-label="学习问题" value={draft} onChange={event => setDraft(event.target.value)} />
				<div className="flex justify-end gap-2">
					{chat.sending ? <Button onClick={() => chatStore.cancel()}>停止</Button> : <Button variant="primary" disabled={!draft.trim() || creating} onClick={() => void send()}>{creating ? <Spinner size={16} /> : "发送"}</Button>}
				</div>
			</section>
		</main>
		{settingsOpen ? <Suspense fallback={<Spinner size={16} />}><SettingsOverlay /></Suspense> : null}
	</div>;
}
