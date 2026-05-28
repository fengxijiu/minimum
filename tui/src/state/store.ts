import { useReducer, useCallback } from 'react';
import type { AppState } from '../types.js';
import type { AgentEvent } from './events.js';
import { reduce } from './reducer.js';

export type Dispatch = (event: AgentEvent) => void;

/**
 * useAgentStore — thin wrapper around useReducer.
 * Returns [state, dispatch] where dispatch accepts typed AgentEvents.
 */
export function useAgentStore(initial: AppState): [AppState, Dispatch] {
  const [state, rawDispatch] = useReducer(reduce, initial);
  const dispatch = useCallback(rawDispatch, []);
  return [state, dispatch];
}
