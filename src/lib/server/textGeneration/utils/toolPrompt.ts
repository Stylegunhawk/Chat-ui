import type { OpenAiTool } from "$lib/server/mcp/tools";

export function buildToolPreprompt(tools: OpenAiTool[], ragEnabled = true): string {
	if (!Array.isArray(tools) || tools.length === 0) return "";
	const names = tools
		.map((t) => (t?.function?.name ? String(t.function.name) : ""))
		.filter((s) => s.length > 0);
	if (names.length === 0) return "";
	const now = new Date();
	const currentDate = now.toLocaleDateString("en-US", {
		year: "numeric",
		month: "long",
		day: "numeric",
	});

	const ragInstruction = ragEnabled
		? `When a user references an uploaded file or document, use retrieve_docs to fetch its content before proceeding — but only if the task genuinely requires understanding that file. Do not call retrieve_docs for general questions.`
		: `Document search is currently disabled (RAG: OFF). Do not call retrieve_docs. If the user references a file, inform them that document search is off and ask them to enable it.`;

	return [
		`You have access to these built-in capabilities: ${names.join(", ")}.`,
		`Today's date: ${currentDate}.`,
		`Treat these tools as your own internal skills — like memory, search, or code execution — not as external APIs.`,
		`Use tools only when they genuinely improve your answer. For writing, editing, or knowledge-based questions, respond directly.`,
		`MULTI-STEP TASKS: Think before acting. If a task needs context (e.g., user asks to refine a prompt about their code), gather that context first, then act. Chain tools naturally: retrieve → understand → generate.`,
		`SEARCH PRECISION: Use 3-6 precise keywords. For multi-part questions, search each part separately. Use the correct year for past events.`,
		`FACTS: State only what the results explicitly say. Never fabricate URLs or facts. If results conflict or are missing, say so.`,
		`IMAGES: If a tool generates an image, inline it: ![alt text](image_url). If a tool needs an image, reference it as "image_1", "image_2" etc. Only use full URLs when the tool explicitly requires one.`,
		ragInstruction,
	].join("\n");
}
