import { LearnerProfilePanel } from "../LearnerProfilePanel.js";

/**
 * 我的学习档案 — the existing panel and `learnerStore` are the only owner of
 * the profile; this page only provides the shell slot, heading and scroll box.
 */
export function ProfilePage() {
	return (
		<div className="mla-profile">
			<div className="mla-page-head mla-profile-head">
				<div>
					<h1>我的学习档案</h1>
					<p>学习目标、知识掌握、薄弱点与教学偏好都来自同一份本机档案。</p>
				</div>
			</div>
			<div className="mla-profile-body">
				<LearnerProfilePanel />
			</div>
		</div>
	);
}
