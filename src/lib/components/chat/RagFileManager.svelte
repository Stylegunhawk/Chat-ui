<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import { page } from "$app/state";
	import Modal from "../Modal.svelte";
	import CarbonDocument from "~icons/carbon/document";
	import CarbonClose from "~icons/carbon/close";
	import CarbonUpload from "~icons/carbon/upload";
	import CarbonTrashCan from "~icons/carbon/trash-can";
	import EosIconsLoading from "~icons/eos-icons/loading";
	import { browserRagClient as ragClient } from "$lib/rag/browserClient";
	import type { RagFileMetadata } from "$lib/rag/client";

	interface Props {
		onclose?: () => void;
	}

	let { onclose }: Props = $props();

	let files = $state<RagFileMetadata[]>([]);
	let loading = $state(false);
	let uploading = $state(false);
	let errorMsg = $state("");
	let fileInputEl: HTMLInputElement | undefined = $state();
	let pollInterval: ReturnType<typeof setInterval> | undefined = undefined;

	// Get tenant ID from session
	function getTenantId(): string {
		return page.data.user?._id?.toString() || page.data.sessionId || "";
	}

	// Start polling for file status updates
	function startPolling() {
		if (pollInterval) return;
		console.log("[RAG] Starting poll for file status...");
		pollInterval = setInterval(() => {
			loadFiles(true); // true = silent update
		}, 1000);
	}

	// Stop polling
	function stopPolling() {
		if (pollInterval) {
			console.log("[RAG] Stopping poll.");
			clearInterval(pollInterval);
			pollInterval = undefined;
		}
	}

	// Fetch file list from backend
	async function loadFiles(silent = false) {
		if (!silent) loading = true;
		errorMsg = "";
		try {
			// Use centralized client
			files = await ragClient.listFiles(getTenantId());

			// Check if any file is still processing
			// finishEmbedding is false while processing
			const hasProcessing = files.some((f) => !f.finishEmbedding);

			if (hasProcessing) {
				startPolling();
			} else {
				stopPolling();
			}
		} catch (e) {
			// If polling fails, we might want to stop polling to avoid log spam, 
			// but transient network issues shouldn't kill it permanently.
			// For now, only show error in UI if standard load.
			if (!silent) {
				errorMsg = e instanceof Error ? e.message : "Failed to load files";
			}
			console.error("[RAG] Load files failed:", e);
		} finally {
			if (!silent) loading = false;
		}
	}

	// Handle file upload
	async function handleUpload(selectedFiles: FileList | null) {
		if (!selectedFiles || selectedFiles.length === 0) return;

		uploading = true;
		errorMsg = "";

		try {
			// Convert FileList to Array
			const fileArray = Array.from(selectedFiles);
			
			// Use centralized client
			await ragClient.uploadFiles(fileArray, getTenantId());

			// Reload file list after successful upload
			await loadFiles();

			// Reset file input
			if (fileInputEl) fileInputEl.value = "";
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : "Upload failed";
			console.error("[RAG] Upload failed:", e);
		} finally {
			uploading = false;
		}
	}

	// Delete file
	async function deleteFile(fileId: string) {
		if (!confirm("Are you sure you want to delete this file?")) return;

		try {
			// Use centralized client
			await ragClient.deleteFile(fileId, getTenantId());

			// Reload file list
			await loadFiles();
		} catch (e) {
			alert(e instanceof Error ? e.message : "Delete failed");
			console.error("[RAG] Delete failed:", e);
		}
	}

	// Format file size
	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	// Format date
	function formatDate(isoDate: string): string {
		const date = new Date(isoDate);
		return date.toLocaleDateString(undefined, {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	}

	// Truncate middle of filename
	function truncateMiddle(text: string, maxLength: number): string {
		if (text.length <= maxLength) return text;
		const halfLength = Math.floor((maxLength - 1) / 2);
		return `${text.substring(0, halfLength)}…${text.substring(text.length - halfLength)}`;
	}

	// Load files on mount
	onMount(() => {
		loadFiles();
	});

	// Clean up on destroy
	onDestroy(() => {
		stopPolling();
	});
</script>

<Modal width="max-w-2xl" onclose={onclose} closeButton={true}>
	{#snippet children()}
		<div class="flex flex-col gap-4 p-6">
			<!-- Header -->
			<div class="flex items-center justify-between">
				<h2 class="text-xl font-semibold text-gray-800 dark:text-gray-200">Manage RAG Files</h2>
			</div>

			<!-- Upload Section -->
			<div
				class="flex flex-col gap-3 rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50"
			>
				<div class="flex items-center justify-between">
					<div class="flex items-center gap-2">
						<CarbonUpload class="size-5 text-gray-600 dark:text-gray-400" />
						<span class="text-sm font-medium text-gray-700 dark:text-gray-300">Upload Files</span>
					</div>
					<button
						class="inline-flex items-center gap-1.5 rounded-xl border border-gray-900 bg-gray-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-black disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-100 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white"
						onclick={() => fileInputEl?.click()}
						disabled={uploading || loading}
					>
						{#if uploading}
							<EosIconsLoading class="size-4" />
							Uploading...
						{:else}
							Choose Files
						{/if}
					</button>
				</div>

				<input
					bind:this={fileInputEl}
					type="file"
					multiple
					accept=".pdf,.py,.js,.ts,.tsx,.jsx,.java,.go,.cpp,.c,.rs,.rb,.php,.swift,.kt,.cs,.md,.txt"
					onchange={(e) => handleUpload(e.currentTarget.files)}
					class="hidden"
				/>

				<p class="text-xs text-gray-500 dark:text-gray-400">
					Supported: Code files, PDFs, Markdown. Max 10MB per file.
				</p>
			</div>

			<!-- Error Message -->
			{#if errorMsg}
				<div class="rounded-xl border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-900/20">
					<p class="text-sm text-red-600 dark:text-red-400">{errorMsg}</p>
				</div>
			{/if}

			<!-- File List -->
			<div class="flex flex-col gap-2">
				<h3 class="text-sm font-medium text-gray-700 dark:text-gray-300">
					Uploaded Files ({files.length})
				</h3>

				{#if loading}
					<div class="flex items-center justify-center py-12">
						<EosIconsLoading class="size-8 text-gray-400" />
					</div>
				{:else if files.length === 0}
					<div
						class="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-gray-300 bg-gray-50 py-12 dark:border-gray-700 dark:bg-gray-800/50"
					>
						<CarbonDocument class="size-12 text-gray-300 dark:text-gray-600" />
						<p class="text-sm text-gray-500 dark:text-gray-400">No files uploaded yet</p>
						<p class="text-xs text-gray-400 dark:text-gray-500">Upload files to enable RAG search</p>
					</div>
				{:else}
					<div class="scrollbar-custom max-h-96 space-y-2 overflow-y-auto">
						{#each files as file (file.id)}
							<div
								class="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800"
							>
								<!-- Icon -->
								<div
									class="grid size-10 flex-none place-items-center rounded-lg bg-gray-100 dark:bg-gray-700"
								>
									<CarbonDocument class="size-5 text-gray-600 dark:text-gray-400" />
								</div>

								<!-- File Info -->
								<div class="flex min-w-0 flex-1 flex-col">
									<p class="truncate text-sm font-medium text-gray-800 dark:text-gray-200" title={file.name}>
										{truncateMiddle(file.name, 40)}
									</p>
									<div class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
										<span>{formatSize(file.size)}</span>
										<span>•</span>
										<span>{file.chunkCount} chunks</span>
										<span>•</span>
										<span>{formatDate(file.createdAt)}</span>
									</div>

									<!-- Status Badges -->
									<div class="mt-1 flex items-center gap-1.5">
										{#if !file.finishEmbedding}
											<span
												class="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
											>
												<EosIconsLoading class="size-3" />
												Processing
											</span>
										{:else if file.chunkingError || file.embeddingError}
											<span
												class="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400"
												title={file.chunkingError || file.embeddingError || "Error"}
											>
												Failed
											</span>
										{:else}
											<span
												class="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400"
											>
												Ready
											</span>
										{/if}
									</div>
								</div>

								<!-- Delete Button -->
								<button
									class="flex-none rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-red-600 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-red-400"
									onclick={() => deleteFile(file.id)}
									aria-label="Delete file"
									title="Delete file"
								>
									<CarbonTrashCan class="size-5" />
								</button>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</div>
	{/snippet}
</Modal>
