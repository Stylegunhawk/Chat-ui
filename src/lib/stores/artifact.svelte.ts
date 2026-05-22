export type ArtifactType =
	| "text/html"
	| "image/svg+xml"
	| "text/x-mermaid"
	| "application/json"
	| "text/markdown"
	| "text/csv";

export const TYPE_LABELS: Record<string, string> = {
	"text/html": "HTML",
	"image/svg+xml": "SVG",
	"text/x-mermaid": "Mermaid",
	"application/json": "JSON",
	"text/markdown": "Markdown",
	"text/csv": "CSV",
};

export const TYPE_COLORS: Record<string, string> = {
	"text/html": "bg-orange-500",
	"image/svg+xml": "bg-purple-500",
	"text/x-mermaid": "bg-teal-500",
	"application/json": "bg-yellow-500",
	"text/markdown": "bg-blue-500",
	"text/csv": "bg-green-500",
};

export interface Artifact {
	id: string;
	type: ArtifactType;
	title: string;
	content: string;
	createdAt: Date;
}

class ArtifactStore {
	artifacts = $state<Artifact[]>([]);
	activeArtifactId = $state<string | null>(null);
	panelOpen = $state(false);

	get activeArtifact(): Artifact | undefined {
		return this.artifacts.find((a) => a.id === this.activeArtifactId);
	}

	get activeIndex(): number {
		return this.artifacts.findIndex((a) => a.id === this.activeArtifactId);
	}

	pushArtifact(artifact: Omit<Artifact, "id" | "createdAt">): string {
		const id = crypto.randomUUID();
		const newArtifact: Artifact = { ...artifact, id, createdAt: new Date() };
		this.artifacts = [...this.artifacts, newArtifact];
		this.activeArtifactId = id;
		this.panelOpen = true;
		return id;
	}

	setActive(id: string): void {
		if (this.artifacts.some((a) => a.id === id)) {
			this.activeArtifactId = id;
		}
	}

	navigatePrev(): void {
		const i = this.activeIndex;
		if (i > 0) this.activeArtifactId = this.artifacts[i - 1].id;
	}

	navigateNext(): void {
		const i = this.activeIndex;
		if (i < this.artifacts.length - 1) this.activeArtifactId = this.artifacts[i + 1].id;
	}

	closePanel(): void {
		this.panelOpen = false;
	}

	openPanel(): void {
		this.panelOpen = true;
	}

	reset(): void {
		this.artifacts = [];
		this.activeArtifactId = null;
		this.panelOpen = false;
	}
}

export const artifactStore = new ArtifactStore();
