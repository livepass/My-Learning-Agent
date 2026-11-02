import { useEffect } from "react";
import { CircleDashed, GraduationCap, Lightbulb } from "lucide-react";
import { learningStore } from "../../stores/learning-store.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { useStoreSnapshot } from "../hooks.js";
import { Button } from "../ui/index.js";
import { navigate } from "../shell/navigation.js";

/**
 * 练习与反馈 — structure only.
 *
 * Generating questions, scoring an answer and recording evidence are not
 * implemented. The page therefore renders the real structure and an explicit
 * empty state; it never fabricates a question, a score or a submit action that
 * cannot complete.
 */
export function PracticePage() {
	const { currentSessionId } = useStoreSnapshot(sessionsStore, () => ({
		currentSessionId: sessionsStore.currentSessionId,
	}));
	const learning = useStoreSnapshot(learningStore, () => ({
		state: learningStore.state,
	}));

	useEffect(() => {
		if (currentSessionId) void learningStore.load(currentSessionId);
 	}, [currentSessionId]);

	const checkpoint = learning.state?.checkpoint;
	const question = checkpoint?.question
		? learning.state?.questions?.find(
			(item) =>
				item.question_id === checkpoint.question!.question_id &&
				item.question_version === checkpoint.question!.question_version,
		)
		: undefined;

	return (
		<>
			<div className="mla-page-head">
				<div>
					<h1>练习与反馈</h1>
					<p>把「看懂了」，变成一次能独立完成的回答。</p>
				</div>
				<div className="mla-page-meta">
					<Button onClick={() => navigate("learn", { history: "push" })}>返回 AI 学习</Button>
				</div>
			</div>

			<div className="mla-split">
				<div className="mla-stack">
					<section className="mla-card" aria-labelledby="practice-question">
						<div className="mla-card-header">
							<h2 id="practice-question">当前题目</h2>
							<span className="mla-badge">出题尚未开放</span>
						</div>

						{question ? (
							<div className="mla-stack" style={{ gap: 10 }}>
								<p className="mla-text" style={{ margin: 0 }}>{question.prompt}</p>
								<span className="mla-small mla-muted">
									题号 {question.question_id} · 版本 {question.question_version}
								</span>
							</div>
						) : (
							<div className="mla-empty">
								<GraduationCap size={30} aria-hidden="true" />
								<strong>还没有可练习的题目</strong>
								<p className="mla-small" style={{ margin: 0, maxWidth: 420 }}>
									自动出题、作答评分与学习证据写入尚未开发。当前页面只展示真实存在的题目；
									没有题目时不会生成示例题，也不会提供无法完成评分的提交动作。
								</p>
								<Button onClick={() => navigate("learn", { history: "push" })}>
									先去 AI 学习里提问
								</Button>
							</div>
						)}
					</section>

					<section className="mla-card" aria-labelledby="practice-answer">
						<div className="mla-card-header">
							<h2 id="practice-answer">我的作答</h2>
							<span className="mla-small mla-muted">评分尚未开放</span>
						</div>
						<p className="mla-small mla-muted" style={{ margin: 0 }}>
							作答输入框会在评分能力上线后启用。现在提交无法得到真实评分，因此这里不提供提交动作，
							避免把「已提交」误认为「已评估」。
						</p>
					</section>

					<section className="mla-card" aria-labelledby="practice-feedback">
						<div className="mla-card-header">
							<h2 id="practice-feedback">反馈与证据</h2>
							<span className="mla-badge">待开放</span>
						</div>
						<ul className="mla-list">
							<li>
								<CircleDashed size={14} aria-hidden="true" />
								<span>评分结果、提示使用情况与是否独立作答，会在评分能力上线后分别记录。</span>
							</li>
							<li>
								<CircleDashed size={14} aria-hidden="true" />
								<span>未作答、跳过与评估失败都不会被计为答错。</span>
							</li>
						</ul>
					</section>
				</div>

				<aside className="mla-rail" aria-label="练习说明">
					<section className="mla-card">
						<h2>这道题在验证什么</h2>
						<p className="mla-small mla-muted" style={{ margin: 0 }}>
							练习会围绕当前学习目标与检查点推进：先独立作答，再理解反馈，最后记录证据并安排复习。
						</p>
					</section>
					<section className="mla-card">
						<h2>帮助会被如实记录</h2>
						<div className="mla-inline">
							<Lightbulb size={16} aria-hidden="true" style={{ color: "var(--inno-accent)" }} />
							<span className="mla-small mla-muted">提示后答对与无提示答对会分开记录。</span>
						</div>
					</section>
				</aside>
			</div>
		</>
	);
}
