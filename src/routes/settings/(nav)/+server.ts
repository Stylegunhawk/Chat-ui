import { collections } from "$lib/server/database";
import { z } from "zod";
import { authCondition } from "$lib/server/auth";
import { DEFAULT_SETTINGS, type SettingsEditable } from "$lib/types/Settings";
import type { RequestEvent } from "@sveltejs/kit";

export async function POST({ request, locals }: RequestEvent) {
	const body = await request.json();

	const { welcomeModalSeen, ...settings } = z
		.object({
			shareConversationsWithModelAuthors: z
				.boolean()
				.default(DEFAULT_SETTINGS.shareConversationsWithModelAuthors),
			welcomeModalSeen: z.boolean().optional(),
			activeModel: z.string().default(DEFAULT_SETTINGS.activeModel),
			customPrompts: z.record(z.string()).default({}),
			multimodalOverrides: z.record(z.boolean()).default({}),
			toolsOverrides: z.record(z.boolean()).default({}),
			providerOverrides: z.record(z.string()).default({}),
			disableStream: z.boolean().default(false),
			directPaste: z.boolean().default(false),
			hidePromptExamples: z.record(z.boolean()).default({}),
			billingOrganization: z.string().optional(),
			githubToken: z.string().nullable().optional(),
		})
		.parse(body) satisfies SettingsEditable;

	// Handle githubToken separately to avoid overwriting real token with masked placeholder
	const shouldUnsetToken = settings.githubToken === null;
	if (
		settings.githubToken === "ghp_****" ||
		settings.githubToken === "" ||
		settings.githubToken === null
	) {
		delete settings.githubToken;
	}

	await collections.settings.updateOne(
		authCondition(locals),
		{
			$set: {
				...settings,
				...(welcomeModalSeen && { welcomeModalSeenAt: new Date() }),
				updatedAt: new Date(),
			},
			...(shouldUnsetToken && { $unset: { githubToken: "" } }),
			$setOnInsert: {
				createdAt: new Date(),
			},
		},
		{
			upsert: true,
		}
	);
	// return ok response
	return new Response();
}
