#!/usr/bin/env node
import React from 'react';
import { render, Box, Text } from 'ink';
import { App } from './app.js';
import { createEngineRunner } from './engine.js';

const { runner, info } = await createEngineRunner(process.cwd());
render(<App runner={runner} engineInfo={info} />);
