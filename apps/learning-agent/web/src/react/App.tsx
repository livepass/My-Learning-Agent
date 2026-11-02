import { LearningWorkspace } from "./LearningWorkspace.js";

/**
 * Single learning product. The workbench shell (terminal, workspace, notebook,
 * search, jobs) was removed with the legacy feature set, so there is no runtime
 * profile branch here anymore: this component only mounts the learning surface.
 */
export function App() {
	return <LearningWorkspace />;
}
