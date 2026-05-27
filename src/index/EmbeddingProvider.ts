import type { EmbeddingVector, EmbeddingProvider } from './types.js';

/**
 * 简单的本地嵌入提供者（使用随机向量模拟）
 * 实际应用中应使用真实的嵌入模型
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  private dimensions: number;
  private cache: Map<string, EmbeddingVector> = new Map();

  constructor(dimensions: number = 384) {
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<EmbeddingVector> {
    // 检查缓存
    const cached = this.cache.get(text);
    if (cached) return cached;

    // 生成确定性向量（基于文本内容）
    const vector = this.generateVector(text);
    this.cache.set(text, vector);

    return vector;
  }

  async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
    return Promise.all(texts.map(text => this.embed(text)));
  }

  private generateVector(text: string): EmbeddingVector {
    const values: number[] = [];
    
    // 使用简单的哈希生成确定性向量
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }

    // 生成向量
    for (let i = 0; i < this.dimensions; i++) {
      const seed = hash + i;
      const value = Math.sin(seed) * 0.5 + 0.5; // 归一化到 [0, 1]
      values.push(value);
    }

    // L2归一化
    const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
    const normalizedValues = values.map(v => v / norm);

    return {
      values: normalizedValues,
      dimensions: this.dimensions
    };
  }
}

/**
 * OpenAI兼容的嵌入提供者
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private dimensions: number;

  constructor(options: {
    apiKey: string;
    baseUrl?: string;
    model?: string;
    dimensions?: number;
  }) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl || 'https://api.openai.com/v1';
    this.model = options.model || 'text-embedding-3-small';
    this.dimensions = options.dimensions || 1536;
  }

  async embed(text: string): Promise<EmbeddingVector> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
        dimensions: this.dimensions
      })
    });

    if (!response.ok) {
      throw new Error(`Embedding API error: ${response.status}`);
    }

    const data = await response.json() as any;
    return {
      values: data.data[0].embedding,
      dimensions: this.dimensions
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        dimensions: this.dimensions
      })
    });

    if (!response.ok) {
      throw new Error(`Embedding API error: ${response.status}`);
    }

    const data = await response.json() as any;
    return data.data.map((item: any) => ({
      values: item.embedding,
      dimensions: this.dimensions
    }));
  }
}