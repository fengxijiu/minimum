export interface ChoiceOption {
	id: string;
	title: string;
	summary?: string;
}

export interface ChoicePayload {
	question: string;
	options: ChoiceOption[];
	allowCustom: boolean;
	/** Structured background info rendered separately from the question (e.g. DAG flow). */
	context?: string;
}

export type ChoiceVerdict =
	| { type: "pick"; optionId: string }
	| { type: "text"; text: string }
	| { type: "cancel" };

export interface ConfirmationGate {
	ask(payload: ChoicePayload): Promise<ChoiceVerdict>;
}

/** Default gate: no TUI connected — immediately cancels to avoid blocking. */
export class CancelledConfirmationGate implements ConfirmationGate {
	async ask(_payload: ChoicePayload): Promise<ChoiceVerdict> {
		return { type: "cancel" };
	}
}

/** Test gate: pre-seed a verdict via resolve() before calling tool.execute(). */
export class DeferredConfirmationGate implements ConfirmationGate {
	private pending?: Promise<ChoiceVerdict>;
	private resolver?: (v: ChoiceVerdict) => void;

	ask(_payload: ChoicePayload): Promise<ChoiceVerdict> {
		if (!this.pending) {
			this.pending = new Promise<ChoiceVerdict>((res) => {
				this.resolver = res;
			});
		}
		return this.pending;
	}

	resolve(verdict: ChoiceVerdict): void {
		if (!this.resolver) {
			this.pending = Promise.resolve(verdict);
			return;
		}
		this.resolver(verdict);
		this.resolver = undefined;
	}
}
