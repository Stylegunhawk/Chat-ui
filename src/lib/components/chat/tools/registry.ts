import type { Component } from "svelte";
import type { MessageToolResultUpdate } from "$lib/types/MessageUpdate";
import DataTableRenderer from "./DataTableRenderer.svelte";
import ArtifactOpener from "./ArtifactOpener.svelte";

export interface ToolRendererProps {
	update: MessageToolResultUpdate;
	parseToolOutputs: (outputs: unknown[]) => unknown[];
	formatValue: (value: unknown) => string;
}

export const toolRendererRegistry: Record<string, Component<ToolRendererProps>> = {
	generate_data: DataTableRenderer as unknown as Component<ToolRendererProps>,
	generate_artifact: ArtifactOpener as unknown as Component<ToolRendererProps>,
};

export function getToolRenderer(toolName: string): Component<ToolRendererProps> | null {
	return toolRendererRegistry[toolName] ?? null;
}
