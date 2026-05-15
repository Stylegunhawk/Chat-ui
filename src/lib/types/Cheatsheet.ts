export type CheatsheetLanguage =
	| "python"
	| "javascript"
	| "typescript"
	| "go"
	| "rust"
	| "java"
	| "ruby"
	| "php"
	| "csharp";

export type SkillLevel = "beginner" | "intermediate" | "expert";

export type Quality = "curated" | "curated_unpersonalized";

export interface PackUsed {
	kind: "language" | "library";
	id: string;
	version: number;
	last_reviewed: string;
}

export interface RankedEntry {
	id: string;
	title: string;
	relevance_note: string;
	source_pack: string;
}

export interface CheatsheetData {
	language: CheatsheetLanguage;
	skill_level: SkillLevel;
	complexity_score: number;
	complexity_suggested_level: SkillLevel;
	detected_libraries: string[];
	packs_used: PackUsed[];
	ranked_entries: RankedEntry[];
	intro: string;
	quality: Quality;
	markdown: string;
}

export interface GatewayResponse<T> {
	success: boolean;
	data: T | { message: string } | null;
	message: string;
}

export type CheatsheetResponse = GatewayResponse<CheatsheetData>;
