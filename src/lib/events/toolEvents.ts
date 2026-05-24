/**
 * Tool Event Contract
 *
 * Defines DOM event names and typed payloads for tool renderer side effects.
 * Renderers dispatch these events; parent components handle the actual side effects
 * (opening modals, artifact panels, etc.)
 */

// Event name constants
export const TOOL_EVENTS = {
	/** Open artifact panel with structured data */
	OPEN_ARTIFACT: "tool:open-artifact",
	/** Open cheatsheet in expanded view */
	OPEN_CHEATSHEET: "tool:open-cheatsheet",
	/** Request consent/approval for a tool action */
	REQUEST_CONSENT: "tool:request-consent",
	/** Copy tool output to clipboard */
	COPY_OUTPUT: "tool:copy-output",
} as const;

// Payload types for each event

export interface ToolArtifactPayload {
	/** Tool name that produced this artifact */
	toolName: string;
	/** Unique identifier for this tool run */
	uuid: string;
	/** Structured data to display in artifact panel */
	data: unknown;
	/** Optional title for the artifact */
	title?: string;
	/** Optional description */
	description?: string;
}

export interface ToolCheatsheetPayload {
	/** Tool name (should be "generate_cheatsheet") */
	toolName: string;
	/** Unique identifier for this tool run */
	uuid: string;
	/** Markdown content of the cheatsheet */
	markdown: string;
	/** Section titles for navigation */
	sections?: Array<{ title: string }>;
	/** Language/skill level metadata */
	metadata?: {
		language?: string;
		skillLevel?: string;
	};
}

export interface ToolConsentPayload {
	/** Tool name requiring consent */
	toolName: string;
	/** Unique identifier for this tool run */
	uuid: string;
	/** Human-readable description of what the tool will do */
	action: string;
	/** Parameters that will be passed to the tool */
	parameters?: Record<string, unknown>;
	/** Risk level indicator */
	riskLevel?: "low" | "medium" | "high";
}

export interface ToolCopyPayload {
	/** Tool name */
	toolName: string;
	/** Content to copy */
	content: string;
	/** Content type hint (e.g., "json", "markdown", "text") */
	contentType?: string;
}

// Custom event types for type safety

export interface ToolOpenArtifactEvent extends CustomEvent<ToolArtifactPayload> {
	type: typeof TOOL_EVENTS.OPEN_ARTIFACT;
}

export interface ToolOpenCheatsheetEvent extends CustomEvent<ToolCheatsheetPayload> {
	type: typeof TOOL_EVENTS.OPEN_CHEATSHEET;
}

export interface ToolRequestConsentEvent extends CustomEvent<ToolConsentPayload> {
	type: typeof TOOL_EVENTS.REQUEST_CONSENT;
}

export interface ToolCopyOutputEvent extends CustomEvent<ToolCopyPayload> {
	type: typeof TOOL_EVENTS.COPY_OUTPUT;
}

// Helper functions to dispatch events from renderers

/**
 * Dispatch an artifact open event from a renderer.
 * Call this when user wants to see full artifact data in a panel.
 */
export function dispatchOpenArtifact(
	element: HTMLElement | EventTarget,
	payload: ToolArtifactPayload
): void {
	const event = new CustomEvent(TOOL_EVENTS.OPEN_ARTIFACT, {
		detail: payload,
		bubbles: true,
		composed: true,
	});
	if (element instanceof HTMLElement) {
		element.dispatchEvent(event);
	} else {
		element.dispatchEvent(event);
	}
}

/**
 * Dispatch a cheatsheet open event from a renderer.
 * Call this when user wants to see cheatsheet in expanded view.
 */
export function dispatchOpenCheatsheet(
	element: HTMLElement | EventTarget,
	payload: ToolCheatsheetPayload
): void {
	const event = new CustomEvent(TOOL_EVENTS.OPEN_CHEATSHEET, {
		detail: payload,
		bubbles: true,
		composed: true,
	});
	if (element instanceof HTMLElement) {
		element.dispatchEvent(event);
	} else {
		element.dispatchEvent(event);
	}
}

/**
 * Dispatch a consent request event from a renderer.
 * Call this when a tool requires user approval before execution.
 */
export function dispatchRequestConsent(
	element: HTMLElement | EventTarget,
	payload: ToolConsentPayload
): void {
	const event = new CustomEvent(TOOL_EVENTS.REQUEST_CONSENT, {
		detail: payload,
		bubbles: true,
		composed: true,
	});
	if (element instanceof HTMLElement) {
		element.dispatchEvent(event);
	} else {
		element.dispatchEvent(event);
	}
}

/**
 * Dispatch a copy output event from a renderer.
 * Call this when user wants to copy tool output to clipboard.
 */
export function dispatchCopyOutput(
	element: HTMLElement | EventTarget,
	payload: ToolCopyPayload
): void {
	const event = new CustomEvent(TOOL_EVENTS.COPY_OUTPUT, {
		detail: payload,
		bubbles: true,
		composed: true,
	});
	if (element instanceof HTMLElement) {
		element.dispatchEvent(event);
	} else {
		element.dispatchEvent(event);
	}
}

// Type guard helpers for event handlers

export function isToolOpenArtifactEvent(event: Event): event is ToolOpenArtifactEvent {
	return event instanceof CustomEvent && event.type === TOOL_EVENTS.OPEN_ARTIFACT;
}

export function isToolOpenCheatsheetEvent(event: Event): event is ToolOpenCheatsheetEvent {
	return event instanceof CustomEvent && event.type === TOOL_EVENTS.OPEN_CHEATSHEET;
}

export function isToolRequestConsentEvent(event: Event): event is ToolRequestConsentEvent {
	return event instanceof CustomEvent && event.type === TOOL_EVENTS.REQUEST_CONSENT;
}

export function isToolCopyOutputEvent(event: Event): event is ToolCopyOutputEvent {
	return event instanceof CustomEvent && event.type === TOOL_EVENTS.COPY_OUTPUT;
}
