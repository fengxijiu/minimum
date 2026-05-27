import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProjectMemory } from '../../src/memory/ProjectMemory.js';
import { SessionMemory } from '../../src/memory/SessionMemory.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('Memory Persistence', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-persist-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('ProjectMemory', () => {
    it('should persist project memory', async () => {
      const memory = new ProjectMemory(tempDir);
      await memory.initialize();

      // 设置记忆
      await memory.set('style', 'Use TypeScript strict mode');
      await memory.set('convention', 'Use 4 spaces for indentation');

      // 验证持久化
      const content = await memory.get('style');
      expect(content?.value).toBe('Use TypeScript strict mode');

      // 重新加载
      const memory2 = new ProjectMemory(tempDir);
      await memory2.initialize();

      const content2 = await memory2.get('style');
      expect(content2?.value).toBe('Use TypeScript strict mode');
    });

    it('should search project memory', async () => {
      const memory = new ProjectMemory(tempDir);
      await memory.initialize();

      await memory.set('typescript', 'Use strict mode');
      await memory.set('python', 'Use type hints');
      await memory.set('style', 'Use 4 spaces');

      const results = await memory.search('typescript');
      expect(results.length).toBe(1);
      expect(results[0].key).toBe('typescript');
    });
  });

  describe('SessionMemory', () => {
    it('should persist session messages', async () => {
      const memory = new SessionMemory(tempDir);
      await memory.initialize();

      // 创建会话
      await memory.createSession();

      // 添加消息
      await memory.addMessage({ role: 'user', content: 'Hello' });
      await memory.addMessage({ role: 'assistant', content: 'Hi!' });

      // 获取消息
      const messages = await memory.getMessages();
      expect(messages.length).toBe(2);

      // 列出会话
      const sessions = await memory.listSessions();
      expect(sessions.length).toBe(1);
    });
  });
});