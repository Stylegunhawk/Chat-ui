export type ConfirmationResult = {
	action: "accept" | "reject";
};

type DeferredConfirmation = {
	resolve: (result: ConfirmationResult) => void;
	reject: (reason: unknown) => void;
};

const confirmations = new Map<string, DeferredConfirmation>();

export function createConfirmation(uuid: string): Promise<ConfirmationResult> {
	return new Promise((resolve, reject) => {
		confirmations.set(uuid, { resolve, reject });
	});
}

export function resolveConfirmation(uuid: string, action: "accept" | "reject") {
	const deferred = confirmations.get(uuid);
	if (deferred) {
		deferred.resolve({ action });
		confirmations.delete(uuid);
		return true;
	}
	return false;
}

export function cancelConfirmation(uuid: string, reason: string) {
	const deferred = confirmations.get(uuid);
	if (deferred) {
		deferred.reject(new Error(reason));
		confirmations.delete(uuid);
		return true;
	}
	return false;
}
