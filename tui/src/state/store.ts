import { useReducer, useCallback, useRef } from 'react';
import type { AppState } from '../types.js';
import type { AgentEvent } from './events.js';
import { reduce } from './reducer.js';

export type Dispatch = (event: AgentEvent) => void;

/**
 * useAgentStore — useReducer wrapper with selector support.
 *
 * The selector lets child components subscribe to a slice of state.
 * If the slice's reference is unchanged (Object.is), the component
 * skips re-render — even though the parent's state object is new.
 */
export function useAgentStore(initial: AppState | (() => AppState)): [AppState, Dispatch] {
  const [state, rawDispatch] = useReducer(reduce, undefined as unknown as AppState, () =>
    typeof initial === 'function' ? initial() : initial,
  );
  const dispatch = useCallback(rawDispatch, []);
  return [state, dispatch];
}

/**
 * useSlice — subscribe to a derived slice of AppState.
 *
 * Returns the slice value. Combined with React.memo on the consumer,
 * this gives zone-based rendering: only components whose slice changed
 * will re-render.
 *
 * @example
 *   const messages = useSlice(state, s => s.messages);
 *   // ChatStream only re-renders when messages reference changes
 */
export function useSlice<T>(state: AppState, selector: (s: AppState) => T): T {
  const prevRef = useRef<T>(selector(state));
  const next = selector(state);
  if (!Object.is(next, prevRef.current)) {
    prevRef.current = next;
  }
  return prevRef.current;
}
