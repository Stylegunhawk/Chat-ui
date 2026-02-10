import type { ObjectId } from "mongodb";
import type { Timestamps } from "./Timestamps";

export interface User extends Timestamps {
	_id: ObjectId;

	username?: string;
	name: string;
	email?: string;
	avatarUrl: string | undefined;
	hfUserId: string;
	/**
	 * Provider information for OIDC logins.
	 * Optional for legacy users created before we started storing these fields.
	 */
	oidcIssuer?: string;
	oidcSub?: string;
	isAdmin?: boolean;
	isEarlyAccess?: boolean;
}
