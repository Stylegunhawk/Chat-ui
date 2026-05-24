import type { ToolRunViewModel } from "$lib/utils/mcp/toolRunAdapter";

import ArtifactRenderer from "$lib/components/tools/ArtifactRenderer.svelte";
import FallbackRenderer from "$lib/components/tools/FallbackRenderer.svelte";
import InlineRenderer from "$lib/components/tools/InlineRenderer.svelte";
import HiddenRenderer from "$lib/components/tools/HiddenRenderer.svelte";
import GraphRenderer from "$lib/components/tools/GraphRenderer.svelte";

export type ToolStreamMode = "buffered" | "text" | "none";

export interface ToolRendererResolution {
	component:
		| typeof ArtifactRenderer
		| typeof FallbackRenderer
		| typeof InlineRenderer
		| typeof HiddenRenderer
		| typeof GraphRenderer;
	streamMode: ToolStreamMode;
	suppressAssistantText: boolean;
}

type Resolver = (vm: ToolRunViewModel) => ToolRendererResolution;

const fallbackResolver: Resolver = () => ({
	component: FallbackRenderer,
	streamMode: "none",
	suppressAssistantText: false,
});

const registry: Record<string, Resolver> = {
	generate_data: () => ({
		component: ArtifactRenderer,
		streamMode: "buffered",
		suppressAssistantText: true,
	}),
	refine_prompt: () => ({
		component: InlineRenderer,
		streamMode: "text",
		suppressAssistantText: false,
	}),
	retrieve_docs: () => ({
		component: HiddenRenderer,
		streamMode: "none",
		suppressAssistantText: false,
	}),
	rerank_docs: () => ({
		component: HiddenRenderer,
		streamMode: "none",
		suppressAssistantText: false,
	}),
	get_code_graph_related: () => ({
		component: GraphRenderer,
		streamMode: "none",
		suppressAssistantText: false,
	}),
};

export function resolveToolRenderer(vm: ToolRunViewModel): ToolRendererResolution {
	const name = vm.toolName ?? "";
	const resolver = registry[name] ?? fallbackResolver;
	return resolver(vm);
}
