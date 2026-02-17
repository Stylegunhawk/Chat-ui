import type { Conversation } from "./Conversation";

export type SharedConversation = Pick<
	Conversation,
	| "model"
	| "title"
	| "rootMessageId"
	| "messages"
	| "preprompt"
	| "createdAt"
	| "updatedAt"
	| "ragEnabled"
> & {
	_id: string;
	hash: string;
};
