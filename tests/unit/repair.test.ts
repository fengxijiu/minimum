import { describe, it, expect, beforeEach } from 'vitest';
import { ToolCallRepair } from '../../src/repair/ToolCallRepair.js';
import { JsonRepair } from '../../src/repair/JsonRepair.js';
import { TypeRepair } from '../../src/repair/TypeRepair.js';
import { StormBreaker } from '../../src/repair/StormBreaker.js';

describe('Repair', () => {
  describe('JsonRepair', () => {
    let repair: JsonRepair;

    beforeEach(() => {
      repair = new JsonRepair();
    });

    it('should repair truncated JSON', () => {
      const result = repair.repair('{"key": "value"');
      expect(result.changed).toBe(true);
      expect(result.fallback).toBe(false);
    });

    it('should handle valid JSON', () => {
      const result = repair.repair('{"key": "value"}');
      expect(result.changed).toBe(false);
      expect(result.fallback).toBe(false);
    });

    it('should handle empty input', () => {
      const result = repair.repair('');
      expect(result.changed).toBe(true);
      expect(result.repaired).toBe('{}');
    });

    it('should handle whitespace-only input', () => {
      const result = repair.repair('   ');
      expect(result.changed).toBe(true);
      expect(result.repaired).toBe('{}');
    });
  });

  describe('TypeRepair', () => {
    let repair: TypeRepair;

    beforeEach(() => {
      repair = new TypeRepair();
    });

    it('should repair string to number', () => {
      const result = repair.repair(
        { count: '42' },
        {
          name: 'test',
          properties: {
            count: { type: 'number' }
          }
        }
      );
      expect(result.count).toBe(42);
    });

    it('should repair number to string', () => {
      const result = repair.repair(
        { name: 123 },
        {
          name: 'test',
          properties: {
            name: { type: 'string' }
          }
        }
      );
      expect(result.name).toBe('123');
    });

    it('should repair string to boolean', () => {
      const result = repair.repair(
        { enabled: 'true' },
        {
          name: 'test',
          properties: {
            enabled: { type: 'boolean' }
          }
        }
      );
      expect(result.enabled).toBe(true);
    });
  });

  describe('StormBreaker', () => {
    let storm: StormBreaker;

    beforeEach(() => {
      storm = new StormBreaker({ windowSize: 3, threshold: 2 });
    });

    it('should detect storm', () => {
      const call = {
        type: 'function' as const,
        function: {
          name: 'test_tool',
          arguments: '{}'
        }
      };

      // 第一次调用
      let result = storm.inspect(call);
      expect(result.suppress).toBe(false);

      // 第二次调用（相同参数）
      result = storm.inspect(call);
      expect(result.suppress).toBe(true);
    });

    it('should reset storm counter', () => {
      const call = {
        type: 'function' as const,
        function: {
          name: 'test_tool',
          arguments: '{}'
        }
      };

      storm.inspect(call);
      storm.reset();
      
      const result = storm.inspect(call);
      expect(result.suppress).toBe(false);
    });

    it('should not suppress different arguments', () => {
      const call1 = {
        type: 'function' as const,
        function: {
          name: 'test_tool',
          arguments: '{"a": 1}'
        }
      };

      const call2 = {
        type: 'function' as const,
        function: {
          name: 'test_tool',
          arguments: '{"a": 2}'
        }
      };

      storm.inspect(call1);
      const result = storm.inspect(call2);
      expect(result.suppress).toBe(false);
    });

    it('should return history', () => {
      const call = {
        type: 'function' as const,
        function: {
          name: 'test_tool',
          arguments: '{}'
        }
      };

      storm.inspect(call);
      const history = storm.getHistory();
      expect(history.length).toBe(1);
    });
  });

  describe('ToolCallRepair', () => {
    let repair: ToolCallRepair;

    beforeEach(() => {
      repair = new ToolCallRepair();
    });

    it('should repair tool call with invalid JSON', async () => {
      const result = await repair.repair({
        toolCall: {
          type: 'function',
          function: {
            name: 'test_tool',
            arguments: '{"key": "value"'
          }
        },
        context: {
          toolSchemas: {},
          projectRoot: '/test',
          workingDirectory: '/test',
          readFiles: new Set()
        }
      });

      expect(result).toBeDefined();
      expect(result.repaired).toBe(true);
    });

    it('should not repair valid tool call', async () => {
      const result = await repair.repair({
        toolCall: {
          type: 'function',
          function: {
            name: 'test_tool',
            arguments: '{"key": "value"}'
          }
        },
        context: {
          toolSchemas: {},
          projectRoot: '/test',
          workingDirectory: '/test',
          readFiles: new Set()
        }
      });

      expect(result).toBeDefined();
      expect(result.repaired).toBe(false);
    });

    it('should repair JSON directly', () => {
      const result = repair.repairJson('{"key": "value"');
      expect(result.changed).toBe(true);
    });
  });
});
