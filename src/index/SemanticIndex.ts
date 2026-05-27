import * as fs from 'fs/promises';
import * as path from 'path';
import type { IndexedDocument, SearchResult, IndexConfig, EmbeddingProvider } from './types.js';
import { Chunker } from './Chunker.js';
import { LocalEmbeddingProvider } from './EmbeddingProvider.js';

export class SemanticIndex {
  private documents: Map<string, IndexedDocument> = new Map();
  private chunker: Chunker;
  private embeddingProvider: EmbeddingProvider;
  private config: IndexConfig;
  private basePath: string;

  constructor(options?: {
    basePath?: string;
    embeddingProvider?: EmbeddingProvider;
    config?: Partial<IndexConfig>;
  }) {
    this.basePath = options?.basePath || path.join(process.env.HOME || '~', '.minimum', 'index');
    this.embeddingProvider = options?.embeddingProvider || new LocalEmbeddingProvider();
    this.config = {
      chunkSize: options?.config?.chunkSize || 1000,
      chunkOverlap: options?.config?.chunkOverlap || 200,
      embeddingDimensions: options?.config?.embeddingDimensions || 384,
      maxDocuments: options?.config?.maxDocuments || 10000
    };
    this.chunker = new Chunker(this.config.chunkSize, this.config.chunkOverlap);
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.basePath, { recursive: true });
    await this.loadIndex();
  }

  async addDocument(filePath: string, content: string, metadata?: Record<string, any>): Promise<void> {
    // 分块
    const chunks = this.chunker.chunkDocument(filePath, content, metadata);

    // 生成嵌入
    const texts = chunks.map(c => c.chunk);
    const embeddings = await this.embeddingProvider.embedBatch(texts);

    // 存储文档
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = embeddings[i];
      if (chunk && embedding) {
        chunk.embedding = embedding;
        this.documents.set(chunk.id, chunk);
      }
    }

    // 保存索引
    await this.saveIndex();
  }

  async addFile(filePath: string): Promise<void> {
    const content = await fs.readFile(filePath, 'utf-8');
    const ext = path.extname(filePath);
    const language = this.detectLanguage(ext);

    await this.addDocument(filePath, content, { language });
  }

  async addDirectory(dirPath: string, recursive: boolean = true): Promise<number> {
    let count = 0;
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isFile() && this.isIndexable(entry.name)) {
        await this.addFile(fullPath);
        count++;
      } else if (entry.isDirectory() && recursive && !entry.name.startsWith('.')) {
        count += await this.addDirectory(fullPath, recursive);
      }
    }

    return count;
  }

  async search(query: string, limit: number = 10): Promise<SearchResult[]> {
    // 生成查询嵌入
    const queryEmbedding = await this.embeddingProvider.embed(query);

    // 计算相似度
    const results: SearchResult[] = [];

    Array.from(this.documents.values()).forEach(doc => {
      if (!doc.embedding) return;

      const score = this.cosineSimilarity(queryEmbedding.values, doc.embedding.values);
      
      results.push({
        document: doc,
        score,
        snippet: this.extractSnippet(doc.chunk, query)
      });
    });

    // 排序并返回前N个结果
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  async removeDocument(filePath: string): Promise<boolean> {
    let removed = false;
    
    Array.from(this.documents.entries()).forEach(([id, doc]) => {
      if (doc.path === filePath) {
        this.documents.delete(id);
        removed = true;
      }
    });

    if (removed) {
      await this.saveIndex();
    }

    return removed;
  }

  getDocumentCount(): number {
    return this.documents.size;
  }

  getDocuments(): IndexedDocument[] {
    return Array.from(this.documents.values());
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      const aVal = a[i] ?? 0;
      const bVal = b[i] ?? 0;
      dotProduct += aVal * bVal;
      normA += aVal * aVal;
      normB += bVal * bVal;
    }

    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);

    if (normA === 0 || normB === 0) return 0;

    return dotProduct / (normA * normB);
  }

  private extractSnippet(chunk: string, query: string, contextLength: number = 200): string {
    const queryLower = query.toLowerCase();
    const chunkLower = chunk.toLowerCase();
    
    const queryIndex = chunkLower.indexOf(queryLower);
    
    if (queryIndex === -1) {
      return chunk.substring(0, contextLength) + '...';
    }

    const start = Math.max(0, queryIndex - contextLength / 2);
    const end = Math.min(chunk.length, queryIndex + query.length + contextLength / 2);

    let snippet = '';
    if (start > 0) snippet += '...';
    snippet += chunk.substring(start, end);
    if (end < chunk.length) snippet += '...';

    return snippet;
  }

  private isIndexable(filename: string): boolean {
    const indexableExtensions = [
      '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java',
      '.c', '.cpp', '.h', '.hpp', '.rb', '.php', '.swift', '.kt',
      '.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.xml',
      '.html', '.css', '.scss', '.sql', '.sh', '.bash'
    ];

    const ext = path.extname(filename).toLowerCase();
    return indexableExtensions.includes(ext);
  }

  private detectLanguage(ext: string): string {
    const languageMap: Record<string, string> = {
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.py': 'python',
      '.rs': 'rust',
      '.go': 'go',
      '.java': 'java',
      '.c': 'c',
      '.cpp': 'cpp',
      '.h': 'c',
      '.hpp': 'cpp',
      '.rb': 'ruby',
      '.php': 'php',
      '.swift': 'swift',
      '.kt': 'kotlin',
      '.md': 'markdown',
      '.json': 'json',
      '.yaml': 'yaml',
      '.yml': 'yaml',
      '.html': 'html',
      '.css': 'css',
      '.sql': 'sql',
      '.sh': 'bash'
    };

    return languageMap[ext] || 'text';
  }

  private async saveIndex(): Promise<void> {
    try {
      const indexPath = path.join(this.basePath, 'index.json');
      const data = {
        documents: Array.from(this.documents.entries()),
        config: this.config,
        updatedAt: Date.now()
      };
      await fs.writeFile(indexPath, JSON.stringify(data));
    } catch (error) {
      console.error('Failed to save index:', error);
    }
  }

  private async loadIndex(): Promise<void> {
    try {
      const indexPath = path.join(this.basePath, 'index.json');
      const content = await fs.readFile(indexPath, 'utf-8');
      const data = JSON.parse(content);

      this.documents = new Map(data.documents);
      if (data.config) {
        this.config = { ...this.config, ...data.config };
      }
    } catch {
      // 索引文件可能不存在
    }
  }

  async clearIndex(): Promise<void> {
    this.documents.clear();
    await this.saveIndex();
  }
}