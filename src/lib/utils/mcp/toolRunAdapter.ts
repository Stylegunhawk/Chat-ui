import type { MessageToolUpdate } from "$lib/types/MessageUpdate";
import {
	isMessageToolErrorUpdate,
	isMessageToolResultUpdate,
	isMessageToolProgressUpdate,
	isMessageToolCallUpdate,
} from "$lib/utils/messageUpdates";

export type ToolRunStatus = "requested" | "streaming" | "completed" | "failed";

export interface ToolRunPayload {
	rawOutputs?: Record<string, unknown>[];
	text?: string;
	structured?: unknown;
	content?: unknown;
	errorMessage?: string;
}

export interface ToolRunViewModel {
	uuid: string;
	toolName: string | null;
	status: ToolRunStatus;
	lastUpdatedAt: number | null;
	payload: ToolRunPayload;
}

type EnrichedToolUpdate = MessageToolUpdate & { updatedAt?: number };

export function buildToolRunViewModel(updates: EnrichedToolUpdate[]): ToolRunViewModel {
	if (!updates.length) {
		return {
			uuid: "",
			toolName: null,
			status: "requested",
			lastUpdatedAt: null,
			payload: {},
		};
	}

	const uuid = updates[0].uuid;

	let toolName: string | null = null;
	let status: ToolRunStatus = "requested";
	let lastUpdatedAt: number | null = null;

	let rawOutputs: Record<string, unknown>[] | undefined;
	let text: string | undefined;
	let structured: unknown;
	let content: unknown;
	let errorMessage: string | undefined;

	for (const update of updates) {
		if (typeof update.updatedAt === "number") {
			lastUpdatedAt = lastUpdatedAt == null ? update.updatedAt : Math.max(lastUpdatedAt, update.updatedAt);
		}

		if (isMessageToolCallUpdate(update)) {
			toolName = update.call.name;
		} else if (isMessageToolResultUpdate(update)) {
			// Any result means the run has completed (success or error will be reflected in payload)
			status = "completed";
			const result = update.result;
			if ("outputs" in result && Array.isArray(result.outputs)) {
				rawOutputs = result.outputs as Record<string, unknown>[];
			}
			const first = rawOutputs?.[0] ?? {};
			if (typeof (first as Record<string, unknown>)["text"] === "string") {
				text = (first as Record<string, unknown>)["text"] as string;
			}
			if ("structured" in (first as Record<string, unknown>)) {
				structured = (first as Record<string, unknown>)["structured"];
			}
			if ("content" in (first as Record<string, unknown>)) {
				content = (first as Record<string, unknown>)["content"];
			}
		} else if (isMessageToolErrorUpdate(update)) {
			// Error marks the run as failed
			status = "failed";
			errorMessage = update.message;
		} else if (isMessageToolProgressUpdate(update)) {
			// Progress implies the tool is actively running
			if (status === "requested") {
				status = "streaming";
			}
		}
	}

	const payload: ToolRunPayload = {
		rawOutputs,
		text,
		structured,
		content,
		errorMessage,
	};

	return {
		uuid,
		toolName,
		status,
		lastUpdatedAt,
		payload,
	};
}

