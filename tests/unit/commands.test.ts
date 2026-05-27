import { describe, it, expect, beforeEach } from 'vitest';
import { CommandRegistry, createDefaultRegistry } from '../../src/commands/index.js';
import { NewCommand } from '../../src/commands/NewCommand.js';
import { StatusCommand } from '../../src/commands/StatusCommand.js';

describe('Commands', () => {
  describe('CommandRegistry', () => {
    let registry: CommandRegistry;

    beforeEach(() => {
      registry = new CommandRegistry();
    });

    it('should register command', () => {
      const command = new NewCommand();
      registry.register(command);

      expect(registry.get('new')).toBeDefined();
    });

    it('should list commands', () => {
      registry.register(new NewCommand());
      registry.register(new StatusCommand());

      const commands = registry.list();
      expect(commands.length).toBe(2);
    });

    it('should execute command', async () => {
      registry.register(new NewCommand());

      const result = await registry.execute('/new test-session', {
        workingDirectory: '/test',
        messages: [],
        config: {}
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('test-session');
    });

    it('should handle unknown command', async () => {
      const result = await registry.execute('/unknown', {
        workingDirectory: '/test',
        messages: [],
        config: {}
      });

      expect(result.success).toBe(false);
      expect(result.output).toContain('Unknown command');
    });

    it('should detect commands', () => {
      expect(registry.isCommand('/help')).toBe(true);
      expect(registry.isCommand('hello')).toBe(false);
    });

    it('should handle non-command input', async () => {
      const result = await registry.execute('hello', {
        workingDirectory: '/test',
        messages: [],
        config: {}
      });

      expect(result.success).toBe(false);
      expect(result.output).toBe('Not a command');
    });

    it('should execute status command', async () => {
      registry.register(new StatusCommand());

      const result = await registry.execute('/status', {
        workingDirectory: '/test',
        messages: [],
        config: {}
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Status');
    });
  });

  describe('Default Registry', () => {
    it('should create registry with all commands', () => {
      const registry = createDefaultRegistry();
      const commands = registry.list();

      expect(commands.length).toBeGreaterThan(0);
      expect(registry.get('new')).toBeDefined();
      expect(registry.get('save')).toBeDefined();
      expect(registry.get('load')).toBeDefined();
      expect(registry.get('status')).toBeDefined();
    });
  });
});
