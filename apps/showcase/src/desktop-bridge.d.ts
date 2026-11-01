declare global {
	interface Window {
		innoDesktop?: {
			setCloseDialogCopy(copy: {
				title: string;
				message: string;
				detail: string;
				buttons: { hide: string; quit: string; cancel: string };
				remember: string;
			}): void;
			expandWindowWidth(side: "left" | "right", additionalWidth: number): Promise<boolean>;
			getWindowWidthCapacity(side: "left" | "right"): Promise<number>;
			openLocalFile(file: File): Promise<boolean>;
		};
	}
}

export {};
