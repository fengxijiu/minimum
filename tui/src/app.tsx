import React, { useState } from 'react';
import { Box, useApp, useInput } from 'ink';
import { TitleBar }    from './components/TitleBar.js';
import { PlanStrip }   from './components/PlanStrip.js';
import { ContextRail } from './components/ContextRail.js';
import { ChatStream }  from './components/ChatStream.js';
import { Prompt }      from './components/Prompt.js';
import { StatusBar }   from './components/StatusBar.js';
import { initialState } from './mock.js';
import type { Message } from './types.js';

export function App() {
  const { exit } = useApp();
  const [state, setState] = useState(initialState);

  useInput((_input, key) => {
    if (key.escape) exit();
    if (key.tab) {
      setState(s => ({ ...s, mode: s.mode === 'agent' ? 'chat' : 'agent' }));
    }
  });

  const handleSubmit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const now = Date.now();
    const userMsg: Message = { id: 'u' + now, type: 'user', text: trimmed };
    const botMsg:  Message = {
      id: 'a' + now,
      type: 'assistant',
      text: '(mock) wire your MiMo stream in src/app.tsx → handleSubmit',
    };
    setState(s => ({
      ...s,
      input: '',
      messages: [...s.messages, userMsg, botMsg],
    }));
  };

  return (
    <Box flexDirection="column">
      <TitleBar path={state.path} branch={state.branch} mode={state.mode} />
      <PlanStrip title={state.plan.title} steps={state.plan.steps} />
      <Box flexDirection="row">
        <ContextRail
          files={state.files}
          edits={state.edits}
          mode={state.mode}
        />
        <Box flexDirection="column" flexGrow={1}>
          <ChatStream
            stepLabel={state.currentStepLabel}
            messages={state.messages}
          />
          <Prompt
            value={state.input}
            onChange={(v) => setState(s => ({ ...s, input: v }))}
            onSubmit={handleSubmit}
            placeholder="ask, steer, /plan, @file…"
          />
        </Box>
      </Box>
      <StatusBar
        mode={state.mode}
        ctxUsed={state.ctx.used}
        ctxMax={state.ctx.max}
      />
    </Box>
  );
}
