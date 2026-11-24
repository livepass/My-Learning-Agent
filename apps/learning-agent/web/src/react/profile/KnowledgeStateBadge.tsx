import { useTranslation } from "react-i18next";
import { knowledgeStateLabelKey, knowledgeStateTone } from "../knowledge-state.js";
import { Badge } from "../ui/index.js";

/**
 * The one state badge both profile views render (E4.9i-P2-2).
 *
 * P2-1 gave the two views a single source for the *text* and *tone*; each call
 * site still had to remember to pair `knowledgeStateLabelKey` with
 * `knowledgeStateTone` and pass them to `Badge`. Bundling the three steps here
 * means a new view cannot render the right label in the wrong colour.
 */
export function KnowledgeStateBadge({ stateLabel, className }: { stateLabel: unknown; className?: string }) {
	const { t } = useTranslation();
	return (
		<Badge tone={knowledgeStateTone(stateLabel)} className={className}>
			{t(knowledgeStateLabelKey(stateLabel))}
		</Badge>
	);
}
