#!/usr/bin/env node

/**
 * Minimum TUI - Ink React TUI 版本
 */

import React from 'react';
import { render } from 'ink';
import { App } from '../dist/tui/index.js';

render(React.createElement(App));
