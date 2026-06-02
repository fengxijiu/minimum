export function topLevel(): number {
	return 42;
}

export class Foo {
	bar(): string {
		return "hi";
	}

	private internal(): void {}
}

export interface Iface {
	x: number;
}

export type Alias = number | string;

export enum Color {
	Red,
	Green,
}
