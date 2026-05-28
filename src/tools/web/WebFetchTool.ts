import { truncateToolResult } from "../truncateResult.js";

/** Blocked patterns: localhost / private ranges / file:// / metadata endpoints. */
const BLOCKED = [
  /^file:/i,
  /^ftp:/i,
  /localhost/i,
  /127\.0\.0\.\d+/,
  /^::1$/,
  /^10\.\d+\.\d+\.\d+/,
  /^192\.168\.\d+\.\d+/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+/,
  /169\.254\.169\.254/, // AWS/GCP metadata
];

/** Strip HTML tags, collapse whitespace, keep readable text. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export class WebFetchTool {
  name = "web_fetch";
  description =
    "Fetch content from a public URL (HTTP/HTTPS GET). Returns plain text or JSON. " +
    "不可用于访问内网地址、localhost 或 metadata 端点。";

  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "要获取的 URL (https://...)" },
          timeout: {
            type: "number",
            description: "超时毫秒数（默认 15000）",
          },
          raw: {
            type: "boolean",
            description: "true = 返回原始响应体而不解析 HTML",
          },
        },
        required: ["url"],
      },
    };
  }

  async execute(
    args: Record<string, any>,
    _context?: unknown,
  ): Promise<string> {
    const { url, timeout = 15_000, raw = false } = args as {
      url: string;
      timeout?: number;
      raw?: boolean;
    };

    // Security: block private / disallowed addresses
    for (const pattern of BLOCKED) {
      if (pattern.test(url)) {
        return `拒绝访问: URL "${url}" 指向受限地址`;
      }
    }

    // Only allow http/https
    if (!/^https?:\/\//i.test(url)) {
      return `不支持的协议: 仅允许 http:// 或 https://`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "minimum-agent/1.0 (coding assistant)",
          Accept: "text/html,application/json,text/plain,*/*",
        },
        redirect: "follow",
      });

      const contentType = res.headers.get("content-type") ?? "";
      const bodyText = await res.text();

      let output: string;
      if (!res.ok) {
        output = `HTTP ${res.status} ${res.statusText}\n${bodyText.slice(0, 500)}`;
      } else if (!raw && contentType.includes("text/html")) {
        output = htmlToText(bodyText);
      } else if (contentType.includes("application/json")) {
        try {
          output = JSON.stringify(JSON.parse(bodyText), null, 2);
        } catch {
          output = bodyText;
        }
      } else {
        output = bodyText;
      }

      return truncateToolResult(
        `URL: ${url}\nContent-Type: ${contentType}\n\n${output}`,
        undefined,
        "web_fetch",
      );
    } catch (err: any) {
      if (err.name === "AbortError") {
        return `请求超时 (${timeout}ms): ${url}`;
      }
      return `网络请求失败: ${err.message}`;
    } finally {
      clearTimeout(timer);
    }
  }
}
