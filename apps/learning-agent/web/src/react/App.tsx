import { appStore } from "../stores/app-store.js";
import { useStoreSnapshot } from "./hooks.js";
import { AppShell } from "./shell/AppShell.js";
import { TodayPage } from "./pages/TodayPage.js";
import { LearnPage } from "./pages/LearnPage.js";
import { PracticePage } from "./pages/PracticePage.js";
import { ProfilePage } from "./pages/ProfilePage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { CourseDetailPage } from "./pages/CourseDetailPage.js";

/**
 * Single learning product with a five-page shell plus the second-level course
 * detail page.
 *
 * Pages render inside the shell; the shell owns navigation, the responsive
 * frame and the composer draft. Conversation state still belongs to
 * `sessionsStore` / `chatStore`, the learner profile to `learnerStore`, and
 * course facts to `coursesStore`.
 */
export function App() {
	const { activePage } = useStoreSnapshot(appStore, () => ({ activePage: appStore.activePage }));

	return (
		<AppShell>
			{activePage === "today" ? <TodayPage /> : null}
			{activePage === "learn" ? <LearnPage /> : null}
			{activePage === "practice" ? <PracticePage /> : null}
			{activePage === "profile" ? <ProfilePage /> : null}
			{activePage === "settings" ? <SettingsPage /> : null}
			{activePage === "course" ? <CourseDetailPage /> : null}
		</AppShell>
	);
}
