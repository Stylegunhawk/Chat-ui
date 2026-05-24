<script lang="ts">
	import type { Model } from "$lib/types/Model";

	interface Props {
		currentModel: Model;
		onmessage?: (content: string) => void;
	}

	let { currentModel: _currentModel, onmessage }: Props = $props();

	$effect(() => {
		void _currentModel;
		void onmessage;
	});
</script>

<div class="my-auto grid items-center justify-center gap-6 text-center">
	<!-- DevForge Branding -->
	<div class="flex -translate-y-12 select-none flex-col items-center gap-3">
		<h1
			class="text-4xl font-light uppercase tracking-[10px] md:text-5xl"
			style="
				background: linear-gradient(135deg, #ffffff 0%, #777777 100%);
				background-clip: text;
				-webkit-background-clip: text;
				-webkit-text-fill-color: transparent;
			"
		>
			DevForge
		</h1>
		<p class="text-sm uppercase tracking-widest text-gray-500">Ask anything. Build anything.</p>
	</div>
</div>
