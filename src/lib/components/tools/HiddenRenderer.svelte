<script lang="ts">
	import type { ToolRunViewModel } from "$lib/utils/mcp/toolRunAdapter";

	interface Props {
		vm: ToolRunViewModel;
	}

	let { vm }: Props = $props();

	void vm;
</script>

<!-- Intentionally hidden: used for tools whose output is only for internal context -->
