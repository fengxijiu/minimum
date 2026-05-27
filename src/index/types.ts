export interface EmbeddingVector {
  values: number[];
  dimensions: number;
}

export interface IndexedDocument {
  id: string;
  path: string;
  content: string;
  chunk: string;
  embedding?: EmbeddingVector;
  metadata: {
    language?: string;
    startLine?: number;
    endLine?: number;
    symbols?: string[];
    lastModified: number;
  };
}

export interface SearchResult {
  document: IndexedDocument;
  score: number;
  snippet: string;
}

export interface IndexConfig {
  chunkSize: number;
  chunkOverlap: number;
  embeddingDimensions: number;
  maxDocuments: number;
}

export interface EmbeddingProvider {
  embed(text: string): Promise<EmbeddingVector>;
  embedBatch(texts: string[]): Promise<EmbeddingVector[]>;
}