export class OperationDeadlineError extends Error {
	constructor() {
		super('The operation exceeded its deadline.');
		this.name = 'OperationDeadlineError';
	}
}

/** Bounds an admission call without cancelling durable work that may already be accepted. */
export function settleWithin<T>(operation: Promise<T>, maximumMilliseconds: number) {
	if (!Number.isSafeInteger(maximumMilliseconds) || maximumMilliseconds < 1) {
		throw new RangeError('The operation deadline must be a positive integer.');
	}
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new OperationDeadlineError()),
			maximumMilliseconds,
		);
		operation.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}
