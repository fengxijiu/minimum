import { describe, it, expect, beforeEach } from 'vitest';
import { CompletenessChecker } from '../../src/completeness/CompletenessChecker.js';
import { FunctionChecker } from '../../src/completeness/FunctionChecker.js';
import { ImportChecker } from '../../src/completeness/ImportChecker.js';

describe('Completeness', () => {
  describe('FunctionChecker', () => {
    let checker: FunctionChecker;

    beforeEach(() => {
      checker = new FunctionChecker();
    });

    it('should detect TODO in function', async () => {
      const result = await checker.check(`
        function test() {
          // TODO: implement
        }
      `);

      expect(result).toBeDefined();
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].type).toBe('placeholder-code');
    });

    it('should detect empty function', async () => {
      const result = await checker.check(`
        function test() {
        }
      `);

      expect(result).toBeDefined();
      expect(result.some(r => r.type === 'empty-function')).toBe(true);
    });

    it('should pass valid function', async () => {
      const result = await checker.check(`
        function test() {
          return true;
        }
      `);

      expect(result).toBeDefined();
      expect(result.length).toBe(0);
    });

    it('should detect placeholder code', async () => {
      const result = await checker.check(`
        function test() {
          throw new Error('not implemented');
        }
      `);

      expect(result).toBeDefined();
      expect(result.some(r => r.type === 'placeholder-code')).toBe(true);
    });
  });

  describe('ImportChecker', () => {
    let checker: ImportChecker;

    beforeEach(() => {
      checker = new ImportChecker();
    });

    it('should detect missing import for custom class', async () => {
      const result = await checker.check(
        'const x = new MyClass();',
        {
          projectRoot: '/test',
          readFiles: [],
          modifiedFiles: [],
          language: 'typescript'
        }
      );

      expect(result).toBeDefined();
      expect(result.some(r => r.message.includes('MyClass'))).toBe(true);
    });

    it('should not flag built-in objects', async () => {
      const result = await checker.check(
        'const x = new Map();',
        {
          projectRoot: '/test',
          readFiles: [],
          modifiedFiles: [],
          language: 'typescript'
        }
      );

      expect(result).toBeDefined();
      // Map 是内置对象，不需要导入
      expect(result.some(r => r.message.includes('Map'))).toBe(false);
    });

    it('should detect unused imports', async () => {
      const result = await checker.check(
        'import { unused } from "module"; const x = 1;',
        {
          projectRoot: '/test',
          readFiles: [],
          modifiedFiles: [],
          language: 'typescript'
        }
      );

      expect(result).toBeDefined();
      expect(result.some(r => r.message.includes('Unused'))).toBe(true);
    });
  });

  describe('CompletenessChecker', () => {
    let checker: CompletenessChecker;

    beforeEach(() => {
      checker = new CompletenessChecker();
    });

    it('should check complete code', async () => {
      const result = await checker.check({
        task: '实现一个加法函数',
        generatedCode: `
          function add(a: number, b: number): number {
            return a + b;
          }
        `,
        context: {
          projectRoot: '/test',
          readFiles: [],
          modifiedFiles: [],
          language: 'typescript'
        }
      });

      expect(result).toBeDefined();
      expect(result.complete).toBe(true);
      expect(result.score).toBeGreaterThan(0);
    });

    it('should detect incomplete code', async () => {
      const result = await checker.check({
        task: '实现一个加法函数',
        generatedCode: `
          function add(a, b) {
            // TODO: implement
          }
        `,
        context: {
          projectRoot: '/test',
          readFiles: [],
          modifiedFiles: [],
          language: 'typescript'
        }
      });

      expect(result).toBeDefined();
      expect(result.issues.length).toBeGreaterThan(0);
    });

    it('should generate suggestions', async () => {
      const result = await checker.check({
        task: '实现一个函数',
        generatedCode: `
          function test() {
            // TODO: implement
          }
        `,
        context: {
          projectRoot: '/test',
          readFiles: [],
          modifiedFiles: [],
          language: 'typescript'
        }
      });

      expect(result).toBeDefined();
      expect(result.suggestions.length).toBeGreaterThan(0);
    });
  });
});
