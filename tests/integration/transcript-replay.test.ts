import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TranscriptManager } from '../../src/transcript/TranscriptManager.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('Transcript Replay', () => {
  let manager: TranscriptManager;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'transcript-test-'));
    manager = new TranscriptManager(tempDir);
    await manager.initialize();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should record and replay transcript', async () => {
    // 开始记录
    await manager.startTranscript('test-session');

    // 添加条目
    await manager.addMessage({ role: 'user', content: 'Hello' });
    await manager.addMessage({ role: 'assistant', content: 'Hi!' });
    await manager.addToolCall('read_file', { path: '/test.ts' });
    await manager.addToolResult('read_file', 'file content');
    await manager.addMessage({ role: 'assistant', content: 'I read the file' });

    // 结束记录
    await manager.endTranscript();

    // 列出记录
    const transcripts = await manager.listTranscripts();
    expect(transcripts.length).toBe(1);
    expect(transcripts[0].entries.length).toBe(5);

    // 回放
    const entries: any[] = [];
    for await (const entry of manager.replay(transcripts[0].id)) {
      entries.push(entry);
    }
    expect(entries.length).toBe(5);
  });

  it('should filter replay', async () => {
    await manager.startTranscript('filter-test');
    await manager.addMessage({ role: 'user', content: 'Hello' });
    await manager.addToolCall('tool1', {});
    await manager.addMessage({ role: 'assistant', content: 'Done' });
    await manager.endTranscript();

    const transcripts = await manager.listTranscripts();

    // 只回放消息类型
    const entries: any[] = [];
    for await (const entry of manager.replay(transcripts[0].id, {
      filter: (e) => e.type === 'message'
    })) {
      entries.push(entry);
    }
    expect(entries.length).toBe(2);
  });

  it('should delete transcript', async () => {
    await manager.startTranscript('delete-test');
    await manager.addMessage({ role: 'user', content: 'Test' });
    await manager.endTranscript();

    const transcripts = await manager.listTranscripts();
    expect(transcripts.length).toBe(1);

    const deleted = await manager.deleteTranscript(transcripts[0].id);
    expect(deleted).toBe(true);

    const transcripts2 = await manager.listTranscripts();
    expect(transcripts2.length).toBe(0);
  });
});