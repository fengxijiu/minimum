#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './app.js';
import { createEngineRunner } from './engine.js';

const runner = await createEngineRunner(process.cwd());
render(<App runner={runner} />);
