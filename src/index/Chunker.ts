import type { IndexedDocument } from "./types.js";

export class Chunker {
	private chunkSize: number;
	private chunkOverlap: number;

	constructor(chunkSize = 1000, chunkOverlap = 200) {
		this.chunkSize = chunkSize;
		this.chunkOverlap = chunkOverlap;
	}

	chunkDocument(
		path: string,
		content: string,
		metadata: Record<string, any> = {},
	): IndexedDocument[] {
		const chunks = this.splitIntoChunks(content);

		return chunks.map((chunk, index) => ({
			id: `${path}:chunk:${index}`,
			path,
			content,
			chunk,
			metadata: {
				...metadata,
				startLine: this.getStartLine(content, chunk, index),
				endLine: this.getEndLine(content, chunk, index),
				lastModified: Date.now(),
			},
		}));
	}

	private splitIntoChunks(content: string): string[] {
		const chunks: string[] = [];
		const lines = content.split("\n");

		let currentChunk = "";
		let currentSize = 0;

		for (const line of lines) {
			const lineSize = line.length + 1; // +1 for newline

			if (currentSize + lineSize > this.chunkSize && currentChunk.length > 0) {
				chunks.push(currentChunk.trim());

				// 保留重叠部分
				const overlapLines = this.getOverlapLines(currentChunk);
				currentChunk = `${overlapLines + line}\n`;
				currentSize = overlapLines.length + lineSize;
			} else {
				currentChunk += `${line}\n`;
				currentSize += lineSize;
			}
		}

		if (currentChunk.trim()) {
			chunks.push(currentChunk.trim());
		}

		return chunks;
	}

	private getOverlapLines(chunk: string): string {
		const lines = chunk.split("\n");
		const overlapLines: string[] = [];
		let size = 0;

		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i];
			if (!line) continue;
			if (size + line.length > this.chunkOverlap) break;
			overlapLines.unshift(line);
			size += line.length + 1;
		}

		return `${overlapLines.join("\n")}\n`;
	}

	private getStartLine(
		content: string,
		chunk: string,
		chunkIndex: number,
	): number {
		if (chunkIndex === 0) return 1;

		const contentLines = content.split("\n");
		const chunkLines = chunk.split("\n");
		const firstChunkLine = chunkLines[0];

		for (let i = 0; i < contentLines.length; i++) {
			if (contentLines[i] === firstChunkLine) {
				return i + 1;
			}
		}

		return 1;
	}

	private getEndLine(
		content: string,
		chunk: string,
		chunkIndex: number,
	): number {
		const startLine = this.getStartLine(content, chunk, chunkIndex);
		const chunkLines = chunk.split("\n");
		return startLine + chunkLines.length - 1;
	}
}
