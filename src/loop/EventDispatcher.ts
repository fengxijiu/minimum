import type { LoopEvent } from "./MiMoLoop.js";

export type EventListener = (event: LoopEvent) => void;

export class EventDispatcher {
	private listeners: Map<string, EventListener[]> = new Map();

	on(type: string, listener: EventListener): void {
		const listeners = this.listeners.get(type) || [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}

	off(type: string, listener: EventListener): void {
		const listeners = this.listeners.get(type) || [];
		const index = listeners.indexOf(listener);
		if (index > -1) {
			listeners.splice(index, 1);
		}
	}

	dispatch(event: LoopEvent): void {
		// 通用监听器
		const allListeners = this.listeners.get("*") || [];
		for (const listener of allListeners) {
			listener(event);
		}

		// 特定类型监听器
		const typeListeners = this.listeners.get(event.type) || [];
		for (const listener of typeListeners) {
			listener(event);
		}
	}

	clear(): void {
		this.listeners.clear();
	}
}
