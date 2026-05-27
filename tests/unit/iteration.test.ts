import { describe, it, expect, beforeEach } from 'vitest';
import { IterationManager } from '../../src/iteration/IterationManager.js';

describe('Iteration', () => {
  describe('IterationManager', () => {
    let manager: IterationManager;

    beforeEach(() => {
      manager = new IterationManager({ maxRetries: 3, backoffMs: 0 });
    });

    it('should execute task successfully', async () => {
      const executor = {
        execute: async () => ({
          content: 'success',
          success: true
        })
      };

      const validator = {
        validate: async () => ({
          passed: true,
          errors: []
        })
      };

      const result = await manager.execute(
        {
          id: 'test-1',
          description: 'Test task',
          initialContext: { messages: [] }
        },
        executor,
        validator
      );

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(1);
    });

    it('should retry on failure', async () => {
      let attempts = 0;
      const executor = {
        execute: async () => {
          attempts++;
          if (attempts < 3) {
            throw new Error('Failed');
          }
          return { content: 'success', success: true };
        }
      };

      const validator = {
        validate: async () => ({
          passed: true,
          errors: []
        })
      };

      const result = await manager.execute(
        {
          id: 'test-2',
          description: 'Test task with retry',
          initialContext: { messages: [] }
        },
        executor,
        validator
      );

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(3);
    });

    it('should track error history', async () => {
      const executor = {
        execute: async () => {
          throw new Error('Test error');
        }
      };

      const validator = {
        validate: async () => ({
          passed: false,
          errors: ['Validation failed']
        })
      };

      const result = await manager.execute(
        {
          id: 'test-3',
          description: 'Test task with errors',
          initialContext: { messages: [] }
        },
        executor,
        validator
      );

      expect(result.success).toBe(false);
      expect(result.errorHistory.length).toBeGreaterThan(0);
    });

    it('should fail after max retries', async () => {
      const executor = {
        execute: async () => {
          throw new Error('Always fail');
        }
      };

      const validator = {
        validate: async () => ({
          passed: false,
          errors: ['Validation failed']
        })
      };

      const result = await manager.execute(
        {
          id: 'test-4',
          description: 'Test task max retries',
          initialContext: { messages: [] }
        },
        executor,
        validator
      );

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(4); // maxRetries + 1
    });

    it('should get error history', async () => {
      const executor = {
        execute: async () => {
          throw new Error('Test error');
        }
      };

      const validator = {
        validate: async () => ({
          passed: false,
          errors: ['Validation failed']
        })
      };

      await manager.execute(
        {
          id: 'test-5',
          description: 'Test task',
          initialContext: { messages: [] }
        },
        executor,
        validator
      );

      const history = manager.getErrorHistory('test-5');
      expect(history.length).toBeGreaterThan(0);
    });

    it('should clear history', async () => {
      const executor = {
        execute: async () => {
          throw new Error('Test error');
        }
      };

      const validator = {
        validate: async () => ({
          passed: false,
          errors: ['Validation failed']
        })
      };

      await manager.execute(
        {
          id: 'test-6',
          description: 'Test task',
          initialContext: { messages: [] }
        },
        executor,
        validator
      );

      manager.clearHistory('test-6');
      const history = manager.getErrorHistory('test-6');
      expect(history.length).toBe(0);
    });
  });
});
