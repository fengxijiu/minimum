下面是基于 `learn-skill-writer/SKILL.md` 的完整 `/learn` 添加方案，范围严格限定为：**从当前上下文生成 learned skill，并落盘为 `SKILL.md`**。

不做 memory，不做 persona patch，不接 `MemoryWriter`。

---

# 1. 目标定义

## `/learn` 的职责

```text
当前会话上下文
  ↓
加载 system skill: learn-skill-writer
  ↓
生成 LearnedSkillDraft
  ↓
保存 draft JSON
  ↓
用户确认 apply
  ↓
落盘 .minimum/skills/learned/<name>/SKILL.md
  ↓
可选：刷新 /skill registry
```

## 不做的事情

```text
不写 .minimum/memory/*
不写 .minimum/personas/*
不改 src/personas/*
不改 src/skills/BuiltinSkills.ts
不自动覆盖已有 learned skill
不直接把原始聊天记录塞进 skill
```

---

# 2. 推荐文件结构

```text
src/
  learn/
    index.ts
    types.ts
    LearnCommandService.ts
    LearnSkillPromptLoader.ts
    LearnDraftStore.ts
    LearnedSkillWriter.ts
    LearnedSkillValidator.ts
    LearnedSkillRenderer.ts
    LearnedSkillName.ts

  skills/
    system/
      learn-skill-writer/
        SKILL.md

tui/
  src/
    commands.ts
    app.tsx
```

运行时项目目录：

```text
.minimum/
  learn/
    drafts/
      learn_20260602_001.json

  skills/
    learned/
      pipeline-loop-check/
        SKILL.md
        metadata.json
```

---

# 3. 命令设计

## 最小命令集

```bash
/learn
/learn --name <skill-name>
/learn --dry-run
/learn preview <draft-id>
/learn apply <draft-id>
/learn apply <draft-id> --load
/learn reject <draft-id>
/learn status
```

## 推荐行为

| 命令                         | 行为                                 |
| -------------------------- | ---------------------------------- |
| `/learn`                   | 从当前 session 生成 learned skill draft |
| `/learn --name xxx`        | 指定 skill 名称                        |
| `/learn --dry-run`         | 只预览，不保存 draft，不落盘                  |
| `/learn preview <id>`      | 查看 draft 内容                        |
| `/learn apply <id>`        | 写入 `SKILL.md` 和 `metadata.json`    |
| `/learn apply <id> --load` | 写入后刷新 learned skills               |
| `/learn reject <id>`       | 标记 draft 为 rejected                |
| `/learn status`            | 列出 draft 和 learned skill 状态        |

---

# 4. CommandOutcome 扩展

你的 TUI 现在已经通过 `CommandOutcome` 分发命令行为，`/skill` 也是通过 command 解析后转成 pipeline 或 note outcome，这条模式可以直接复用。

在 `tui/src/commands.ts` 中加：

```ts
export type LearnCommandMode = "create" | "preview" | "apply" | "reject" | "status";

export type CommandOutcome =
  | ExistingOutcomes
  | {
      kind: "learn.create";
      preferredName?: string;
      dryRun: boolean;
      loadNow: boolean;
    }
  | {
      kind: "learn.preview";
      draftId: string;
    }
  | {
      kind: "learn.apply";
      draftId: string;
      loadNow: boolean;
      overwrite: boolean;
      renameTo?: string;
    }
  | {
      kind: "learn.reject";
      draftId: string;
    }
  | {
      kind: "learn.status";
    };
```

---

# 5. `/learn` 命令解析

在 `runCommand()` 的 switch 中添加：

```ts
case "learn": {
  const sub = args[0]?.toLowerCase();

  if (!sub || sub.startsWith("--")) {
    const name = readFlagValue(args, "--name");

    return {
      kind: "learn.create",
      preferredName: name,
      dryRun: args.includes("--dry-run"),
      loadNow: args.includes("--load"),
    };
  }

  if (sub === "preview") {
    const draftId = args[1];

    if (!draftId) {
      return {
        kind: "note",
        note: "Usage: /learn preview <draft-id>",
        tone: "warn",
      };
    }

    return {
      kind: "learn.preview",
      draftId,
    };
  }

  if (sub === "apply") {
    const draftId = args[1];

    if (!draftId) {
      return {
        kind: "note",
        note: "Usage: /learn apply <draft-id> [--load] [--overwrite] [--rename <name>]",
        tone: "warn",
      };
    }

    return {
      kind: "learn.apply",
      draftId,
      loadNow: args.includes("--load"),
      overwrite: args.includes("--overwrite"),
      renameTo: readFlagValue(args, "--rename"),
    };
  }

  if (sub === "reject") {
    const draftId = args[1];

    if (!draftId) {
      return {
        kind: "note",
        note: "Usage: /learn reject <draft-id>",
        tone: "warn",
      };
    }

    return {
      kind: "learn.reject",
      draftId,
    };
  }

  if (sub === "status") {
    return {
      kind: "learn.status",
    };
  }

  return {
    kind: "note",
    note: "Usage: /learn [--name <skill-name>] [--dry-run] | /learn apply <draft-id>",
    tone: "warn",
  };
}
```

工具函数：

```ts
function readFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;

  const value = args[index + 1];
  if (!value || value.startsWith("--")) return undefined;

  return value;
}
```

---

# 6. 核心类型定义

`src/learn/types.ts`

```ts
export interface LearnMessage {
  type: "user" | "assistant" | "system" | "tool" | string;
  text?: string;
}

export interface LearnSkillInput {
  projectRoot: string;
  preferredName?: string;
  messages: LearnMessage[];
  existingSkillNames: string[];
  maxContextChars: number;
}

export interface LearnedSkillDraft {
  id: string;
  name: string;
  description: string;
  tags: string[];
  body: string;
  targetDir: string;
  targetPath: string;
  createdAt: number;
  updatedAt: number;
  status: "draft" | "applied" | "rejected";
  source: {
    projectRoot: string;
    messageCount: number;
  };
  warnings: string[];
}

export interface LearnedSkillWriteResult {
  draftId: string;
  name: string;
  skillPath: string;
  metadataPath: string;
  loaded: boolean;
}

export interface LearnCreateOptions {
  preferredName?: string;
  dryRun?: boolean;
  loadNow?: boolean;
  messages: LearnMessage[];
}

export interface LearnApplyOptions {
  draftId: string;
  loadNow?: boolean;
  overwrite?: boolean;
  renameTo?: string;
}
```

---

# 7. System Skill 注册

建议把 `/learn` 自己使用的 prompt 固定放在源码内：

```text
src/skills/system/learn-skill-writer/SKILL.md
```

不要放到：

```text
.minimum/skills/learned/learn-skill-writer/SKILL.md
```

原因：`learn-skill-writer` 是 `/learn` 的系统约束，不应由 `/learn` 自己学习出来，否则容易递归污染。

---

# 8. Prompt Loader

`src/learn/LearnSkillPromptLoader.ts`

```ts
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface LearnSkillPrompt {
  name: string;
  description: string;
  body: string;
  raw: string;
}

export async function loadLearnSkillWriterPrompt(): Promise<LearnSkillPrompt> {
  const skillPath = path.resolve(
    process.cwd(),
    "src",
    "skills",
    "system",
    "learn-skill-writer",
    "SKILL.md",
  );

  const raw = await fs.readFile(skillPath, "utf-8");
  const parsed = parseSkillMarkdown(raw);

  if (parsed.name !== "learn-skill-writer") {
    throw new Error(`Invalid learn skill writer prompt: expected learn-skill-writer`);
  }

  return {
    ...parsed,
    raw,
  };
}

function parseSkillMarkdown(raw: string): {
  name: string;
  description: string;
  body: string;
} {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  if (!match) {
    throw new Error("Invalid SKILL.md: missing YAML frontmatter");
  }

  const frontmatter = match[1] ?? "";
  const body = match[2] ?? "";

  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const description =
    frontmatter
      .match(/^description:\s*(.+)$/m)?.[1]
      ?.trim()
      .replace(/^"|"$/g, "") ?? "";

  return {
    name,
    description,
    body: body.trim(),
  };
}
```

> 后续打包后 `process.cwd()/src/...` 可能不稳定，正式版可以改为从 package resource、config path 或内置字符串加载。

---

# 9. Draft Store

`src/learn/LearnDraftStore.ts`

```ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { LearnedSkillDraft } from "./types.js";

export class LearnDraftStore {
  constructor(private readonly projectRoot: string) {}

  private get draftsDir(): string {
    return path.join(this.projectRoot, ".minimum", "learn", "drafts");
  }

  async save(draft: LearnedSkillDraft): Promise<void> {
    await fs.mkdir(this.draftsDir, { recursive: true });

    const draftPath = path.join(this.draftsDir, `${draft.id}.json`);

    await fs.writeFile(
      draftPath,
      JSON.stringify(draft, null, 2),
      "utf-8",
    );
  }

  async read(draftId: string): Promise<LearnedSkillDraft | null> {
    const draftPath = path.join(this.draftsDir, `${draftId}.json`);

    const raw = await fs.readFile(draftPath, "utf-8").catch(() => null);
    if (!raw) return null;

    return JSON.parse(raw) as LearnedSkillDraft;
  }

  async update(draft: LearnedSkillDraft): Promise<void> {
    draft.updatedAt = Date.now();
    await this.save(draft);
  }

  async list(): Promise<LearnedSkillDraft[]> {
    const entries = await fs.readdir(this.draftsDir).catch(() => []);

    const drafts: LearnedSkillDraft[] = [];

    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;

      const raw = await fs
        .readFile(path.join(this.draftsDir, entry), "utf-8")
        .catch(() => null);

      if (!raw) continue;

      try {
        drafts.push(JSON.parse(raw) as LearnedSkillDraft);
      } catch {
        // ignore malformed drafts
      }
    }

    return drafts.sort((a, b) => b.createdAt - a.createdAt);
  }
}
```

---

# 10. Skill 名称规范化

`src/learn/LearnedSkillName.ts`

```ts
export function toSkillSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function assertValidSkillSlug(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(name)) {
    throw new Error(
      `Invalid skill name "${name}". Use lowercase letters, numbers, and hyphens only.`,
    );
  }

  if (name.endsWith("-")) {
    throw new Error(`Invalid skill name "${name}". Name cannot end with "-".`);
  }
}

export function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}
```

---

# 11. Skill Validator

`src/learn/LearnedSkillValidator.ts`

```ts
import type { LearnedSkillDraft } from "./types.js";
import { assertValidSkillSlug } from "./LearnedSkillName.js";

const SENSITIVE_PATTERNS = [
  /password\s*[:=]/i,
  /token\s*[:=]/i,
  /api[_\s-]?key\s*[:=]/i,
  /secret\s*[:=]/i,
  /private[_\s-]?key/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /authorization:\s*bearer/i,
  /database_url\s*=/i,
];

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function validateLearnedSkillDraft(
  draft: LearnedSkillDraft,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    assertValidSkillSlug(draft.name);
  } catch (err) {
    errors.push(String(err));
  }

  if (!draft.description.startsWith("Use when ")) {
    errors.push(`Skill description must start with "Use when".`);
  }

  if (!draft.body.includes("## When to Use")) {
    warnings.push(`Skill should include "## When to Use".`);
  }

  if (!draft.body.includes("## Output Contract")) {
    warnings.push(`Skill should include "## Output Contract".`);
  }

  if (!draft.body.includes("## Verification Checklist")) {
    warnings.push(`Skill should include "## Verification Checklist".`);
  }

  if (/in this conversation|earlier we discussed|the user asked/i.test(draft.body)) {
    warnings.push("Skill body appears to contain transcript-style phrasing.");
  }

  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(draft.body) || pattern.test(draft.description)) {
      errors.push("Potential sensitive content detected in learned skill draft.");
      break;
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}
```

---

# 12. Skill Markdown Renderer

`src/learn/LearnedSkillRenderer.ts`

```ts
import type { LearnedSkillDraft } from "./types.js";

export function renderLearnedSkillMarkdown(draft: LearnedSkillDraft): string {
  const tags = normalizeTags(draft.tags);

  return `---
name: ${draft.name}
description: ${JSON.stringify(draft.description)}
tags:
${tags.map((tag) => `  - ${tag}`).join("\n")}
---

${draft.body.trim()}
`;
}

function normalizeTags(tags: string[]): string[] {
  const normalized = tags
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);

  return [...new Set(["learned", ...normalized])];
}
```

---

# 13. Skill Writer

`src/learn/LearnedSkillWriter.ts`

```ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { LearnedSkillDraft, LearnedSkillWriteResult } from "./types.js";
import { renderLearnedSkillMarkdown } from "./LearnedSkillRenderer.js";
import { validateLearnedSkillDraft } from "./LearnedSkillValidator.js";
import { toSkillSlug } from "./LearnedSkillName.js";

export interface LearnedSkillWriterOptions {
  projectRoot: string;
}

export interface WriteLearnedSkillOptions {
  overwrite?: boolean;
  renameTo?: string;
  loadNow?: boolean;
}

export class LearnedSkillWriter {
  constructor(private readonly options: LearnedSkillWriterOptions) {}

  async write(
    draft: LearnedSkillDraft,
    options: WriteLearnedSkillOptions = {},
  ): Promise<LearnedSkillWriteResult> {
    const finalName = toSkillSlug(options.renameTo ?? draft.name);

    const finalDraft: LearnedSkillDraft = {
      ...draft,
      name: finalName,
      targetDir: path.join(
        this.options.projectRoot,
        ".minimum",
        "skills",
        "learned",
        finalName,
      ),
      targetPath: path.join(
        this.options.projectRoot,
        ".minimum",
        "skills",
        "learned",
        finalName,
        "SKILL.md",
      ),
    };

    const validation = validateLearnedSkillDraft(finalDraft);

    if (!validation.ok) {
      throw new Error(`Invalid learned skill:\n${validation.errors.join("\n")}`);
    }

    const skillDir = finalDraft.targetDir;
    const skillPath = finalDraft.targetPath;
    const metadataPath = path.join(skillDir, "metadata.json");

    const exists = await fileExists(skillPath);

    if (exists && !options.overwrite) {
      throw new Error(
        `Learned skill already exists: ${skillPath}\nUse --overwrite or --rename <new-name>.`,
      );
    }

    await fs.mkdir(skillDir, { recursive: true });

    await fs.writeFile(
      skillPath,
      renderLearnedSkillMarkdown(finalDraft),
      "utf-8",
    );

    await fs.writeFile(
      metadataPath,
      JSON.stringify(
        {
          id: finalDraft.id,
          name: finalDraft.name,
          description: finalDraft.description,
          tags: finalDraft.tags,
          createdAt: finalDraft.createdAt,
          updatedAt: Date.now(),
          source: finalDraft.source,
          warnings: [...finalDraft.warnings, ...validation.warnings],
          generatedBy: "/learn",
          schemaVersion: 1,
        },
        null,
        2,
      ),
      "utf-8",
    );

    return {
      draftId: finalDraft.id,
      name: finalDraft.name,
      skillPath,
      metadataPath,
      loaded: Boolean(options.loadNow),
    };
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(
    () => true,
    () => false,
  );
}
```

---

# 14. LearnCommandService

这是 `/learn` 的主服务。

`src/learn/LearnCommandService.ts`

````ts
import * as path from "node:path";
import type {
  LearnCreateOptions,
  LearnApplyOptions,
  LearnedSkillDraft,
  LearnedSkillWriteResult,
} from "./types.js";
import { loadLearnSkillWriterPrompt } from "./LearnSkillPromptLoader.js";
import { LearnDraftStore } from "./LearnDraftStore.js";
import { LearnedSkillWriter } from "./LearnedSkillWriter.js";
import { toSkillSlug, titleFromSlug } from "./LearnedSkillName.js";
import { validateLearnedSkillDraft } from "./LearnedSkillValidator.js";

export interface LearnCommandServiceOptions {
  projectRoot: string;
  generateWithModel?: (prompt: string) => Promise<string>;
  reloadSkills?: () => Promise<void>;
}

export class LearnCommandService {
  private readonly draftStore: LearnDraftStore;
  private readonly writer: LearnedSkillWriter;

  constructor(private readonly options: LearnCommandServiceOptions) {
    this.draftStore = new LearnDraftStore(options.projectRoot);
    this.writer = new LearnedSkillWriter({
      projectRoot: options.projectRoot,
    });
  }

  async createDraft(options: LearnCreateOptions): Promise<LearnedSkillDraft> {
    const promptSkill = await loadLearnSkillWriterPrompt();

    const context = buildContextText(options.messages, 24_000);
    const preferredName = options.preferredName
      ? toSkillSlug(options.preferredName)
      : undefined;

    const draft = this.options.generateWithModel
      ? await this.createDraftWithModel({
          systemSkill: promptSkill.raw,
          context,
          preferredName,
          messageCount: options.messages.length,
        })
      : this.createDraftDeterministic({
          context,
          preferredName,
          messageCount: options.messages.length,
        });

    const validation = validateLearnedSkillDraft(draft);
    draft.warnings.push(...validation.warnings);

    if (!validation.ok) {
      draft.warnings.push(...validation.errors);
    }

    if (!options.dryRun) {
      await this.draftStore.save(draft);
    }

    return draft;
  }

  async previewDraft(draftId: string): Promise<LearnedSkillDraft | null> {
    return this.draftStore.read(draftId);
  }

  async applyDraft(
    options: LearnApplyOptions,
  ): Promise<LearnedSkillWriteResult> {
    const draft = await this.draftStore.read(options.draftId);

    if (!draft) {
      throw new Error(`Learn draft not found: ${options.draftId}`);
    }

    const result = await this.writer.write(draft, {
      overwrite: options.overwrite,
      renameTo: options.renameTo,
      loadNow: options.loadNow,
    });

    draft.status = "applied";
    await this.draftStore.update(draft);

    if (options.loadNow) {
      await this.options.reloadSkills?.();
    }

    return result;
  }

  async rejectDraft(draftId: string): Promise<void> {
    const draft = await this.draftStore.read(draftId);

    if (!draft) {
      throw new Error(`Learn draft not found: ${draftId}`);
    }

    draft.status = "rejected";
    await this.draftStore.update(draft);
  }

  async status(): Promise<LearnedSkillDraft[]> {
    return this.draftStore.list();
  }

  private async createDraftWithModel(input: {
    systemSkill: string;
    context: string;
    preferredName?: string;
    messageCount: number;
  }): Promise<LearnedSkillDraft> {
    const prompt = [
      input.systemSkill,
      "",
      "Now generate exactly one LearnedSkillDraft JSON object.",
      "",
      "Preferred name:",
      input.preferredName ?? "(none)",
      "",
      "Session context:",
      "```text",
      input.context,
      "```",
      "",
      "Return JSON only. Do not wrap it in markdown.",
    ].join("\n");

    const raw = await this.options.generateWithModel!(prompt);
    const parsed = JSON.parse(extractJson(raw)) as LearnedSkillDraft;

    return normalizeDraft(parsed, {
      projectRoot: this.options.projectRoot,
      messageCount: input.messageCount,
    });
  }

  private createDraftDeterministic(input: {
    context: string;
    preferredName?: string;
    messageCount: number;
  }): LearnedSkillDraft {
    const now = Date.now();
    const id = `learn_${now}`;

    const name = input.preferredName ?? inferName(input.context);
    const title = titleFromSlug(name);

    const targetDir = path.join(
      this.options.projectRoot,
      ".minimum",
      "skills",
      "learned",
      name,
    );

    return {
      id,
      name,
      description: `Use when applying the reusable workflow captured by ${name}`,
      tags: ["learned"],
      body: [
        `# ${title}`,
        "",
        "## Purpose",
        "",
        "Capture a reusable workflow extracted from the current project context.",
        "",
        "## When to Use",
        "",
        "Use this skill when a future task matches the same workflow, constraints, or delivery expectations.",
        "",
        "## Inputs",
        "",
        "- Current user request",
        "- Relevant project context",
        "- Existing constraints",
        "",
        "## Core Workflow",
        "",
        "1. Identify the task objective.",
        "2. Extract reusable constraints from the available context.",
        "3. Apply the workflow without changing unrelated project structure.",
        "4. Produce a concrete output contract.",
        "5. Verify the result before final delivery.",
        "",
        "## Output Contract",
        "",
        "The assistant should produce:",
        "",
        "- a concise plan",
        "- implementation guidance",
        "- explicit constraints",
        "- verification criteria",
        "",
        "## Rules and Constraints",
        "",
        "- Preserve existing project structure unless explicitly asked otherwise.",
        "- Avoid one-off transcript details.",
        "- Do not include secrets or credentials.",
        "",
        "## Verification Checklist",
        "",
        "- [ ] The workflow is reusable.",
        "- [ ] The output follows the user's constraints.",
        "- [ ] The result is self-contained.",
        "- [ ] No sensitive content is included.",
        "",
        "## Failure Modes",
        "",
        "- Treating a one-off chat summary as a reusable skill.",
        "- Including noisy transcript content.",
        "- Making the skill too broad to trigger accurately.",
      ].join("\n"),
      targetDir,
      targetPath: path.join(targetDir, "SKILL.md"),
      createdAt: now,
      updatedAt: now,
      status: "draft",
      source: {
        projectRoot: this.options.projectRoot,
        messageCount: input.messageCount,
      },
      warnings: ["Draft generated by deterministic fallback."],
    };
  }
}

function buildContextText(
  messages: Array<{ type: string; text?: string }>,
  maxChars: number,
): string {
  return messages
    .filter((m) => m.type === "user" || m.type === "assistant")
    .map((m) => `${m.type}: ${m.text ?? ""}`)
    .join("\n\n")
    .slice(-maxChars);
}

function inferName(context: string): string {
  if (/w3\.5|回环检测|loop check/i.test(context)) {
    return "pipeline-loop-check";
  }

  if (/skill|SKILL\.md|learn/i.test(context)) {
    return "context-to-skill-distillation";
  }

  if (/tui|command|命令/i.test(context)) {
    return "tui-command-workflow";
  }

  return "learned-context-workflow";
}

function normalizeDraft(
  draft: LearnedSkillDraft,
  input: { projectRoot: string; messageCount: number },
): LearnedSkillDraft {
  const now = Date.now();
  const name = toSkillSlug(draft.name);

  const targetDir = path.join(
    input.projectRoot,
    ".minimum",
    "skills",
    "learned",
    name,
  );

  return {
    ...draft,
    id: draft.id || `learn_${now}`,
    name,
    tags: [...new Set(["learned", ...(draft.tags ?? [])])],
    targetDir,
    targetPath: path.join(targetDir, "SKILL.md"),
    createdAt: draft.createdAt || now,
    updatedAt: now,
    status: "draft",
    source: {
      projectRoot: input.projectRoot,
      messageCount: input.messageCount,
    },
    warnings: draft.warnings ?? [],
  };
}

function extractJson(raw: string): string {
  const trimmed = raw.trim();

  if (trimmed.startsWith("{")) return trimmed;

  const match = trimmed.match(/```json\n([\s\S]*?)\n```/);
  if (match) return match[1]!.trim();

  throw new Error("Model did not return JSON.");
}
````

---

# 15. TUI app.tsx 接入

你的 app 已经有 session save/load，并且恢复时可以恢复 `runner.loadHistory?.(session.chatHistory)`，说明这里可以从 `state.messages` 和 runner history 中取当前上下文。

在 `applyOutcome()` 中加：

```ts
case "learn.create": {
  const s = stateRef.current;

  const service = new LearnCommandService({
    projectRoot: s.path,
    generateWithModel: async (prompt) => {
      return runner.completeText
        ? await runner.completeText(prompt)
        : await runOneShotLearnTurn(runner, prompt);
    },
    reloadSkills: async () => {
      await runner.reloadSkills?.();
    },
  });

  void service
    .createDraft({
      preferredName: o.preferredName,
      dryRun: o.dryRun,
      loadNow: o.loadNow,
      messages: s.messages,
    })
    .then((draft) => {
      dispatch({
        type: "system.push",
        tone: draft.warnings.length ? "warn" : "ok",
        text: formatLearnDraftPreview(draft, o.dryRun),
      });
    })
    .catch((err) => {
      dispatch({
        type: "system.push",
        tone: "warn",
        text: `Failed to create learned skill draft: ${String(err)}`,
      });
    });

  return;
}

case "learn.preview": {
  const s = stateRef.current;

  const service = new LearnCommandService({
    projectRoot: s.path,
  });

  void service
    .previewDraft(o.draftId)
    .then((draft) => {
      if (!draft) {
        dispatch({
          type: "system.push",
          tone: "warn",
          text: `Learn draft not found: ${o.draftId}`,
        });
        return;
      }

      dispatch({
        type: "system.push",
        text: formatLearnDraftPreview(draft, false),
      });
    });

  return;
}

case "learn.apply": {
  const s = stateRef.current;

  const service = new LearnCommandService({
    projectRoot: s.path,
    reloadSkills: async () => {
      await runner.reloadSkills?.();
    },
  });

  void service
    .applyDraft({
      draftId: o.draftId,
      loadNow: o.loadNow,
      overwrite: o.overwrite,
      renameTo: o.renameTo,
    })
    .then((result) => {
      dispatch({
        type: "system.push",
        tone: "ok",
        text: [
          "Learned skill written.",
          "",
          `Name: ${result.name}`,
          `Skill: ${result.skillPath}`,
          `Metadata: ${result.metadataPath}`,
          `Loaded: ${result.loaded ? "yes" : "no"}`,
        ].join("\n"),
      });
    })
    .catch((err) => {
      dispatch({
        type: "system.push",
        tone: "warn",
        text: `Failed to apply learned skill: ${String(err)}`,
      });
    });

  return;
}

case "learn.reject": {
  const s = stateRef.current;

  const service = new LearnCommandService({
    projectRoot: s.path,
  });

  void service
    .rejectDraft(o.draftId)
    .then(() => {
      dispatch({
        type: "system.push",
        tone: "ok",
        text: `Rejected learn draft: ${o.draftId}`,
      });
    })
    .catch((err) => {
      dispatch({
        type: "system.push",
        tone: "warn",
        text: `Failed to reject learn draft: ${String(err)}`,
      });
    });

  return;
}

case "learn.status": {
  const s = stateRef.current;

  const service = new LearnCommandService({
    projectRoot: s.path,
  });

  void service
    .status()
    .then((drafts) => {
      dispatch({
        type: "system.push",
        text: formatLearnStatus(drafts),
      });
    })
    .catch((err) => {
      dispatch({
        type: "system.push",
        tone: "warn",
        text: `Failed to read learn status: ${String(err)}`,
      });
    });

  return;
}
```

格式化函数：

```ts
function formatLearnDraftPreview(
  draft: LearnedSkillDraft,
  dryRun: boolean,
): string {
  return [
    dryRun
      ? `Learned skill dry-run preview`
      : `Learned skill draft created: ${draft.id}`,
    "",
    `Name: ${draft.name}`,
    `Description: ${draft.description}`,
    `Target: ${draft.targetPath}`,
    `Status: ${draft.status}`,
    "",
    draft.warnings.length
      ? `Warnings:\n${draft.warnings.map((w) => `- ${w}`).join("\n")}\n`
      : "",
    "Preview:",
    "",
    draft.body.slice(0, 4000),
    "",
    dryRun
      ? "Dry run only. Nothing was saved."
      : `Apply with: /learn apply ${draft.id}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatLearnStatus(drafts: LearnedSkillDraft[]): string {
  if (drafts.length === 0) {
    return "No learn drafts found.";
  }

  return [
    `Learn drafts (${drafts.length}):`,
    "",
    ...drafts.map((draft) => {
      return [
        `${draft.id}`,
        `  name: ${draft.name}`,
        `  status: ${draft.status}`,
        `  target: ${draft.targetPath}`,
      ].join("\n");
    }),
  ].join("\n");
}
```

---

# 16. Learned Skill Loader 接入 `/skill`

你当前 `/skill` 还是静态 `SKILL_CATALOG` 风格。要让 `/learn apply --load` 后可用，需要加 learned skill loader。

`src/skills/LearnedSkillLoader.ts`

```ts
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface RuntimeSkillEntry {
  name: string;
  description: string;
  tags: string[];
  prompt: string;
  source: "builtin" | "learned" | "system";
  path?: string;
}

export async function loadLearnedSkills(
  projectRoot: string,
): Promise<RuntimeSkillEntry[]> {
  const root = path.join(projectRoot, ".minimum", "skills", "learned");

  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const skills: RuntimeSkillEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillPath = path.join(root, entry.name, "SKILL.md");
    const raw = await fs.readFile(skillPath, "utf-8").catch(() => null);

    if (!raw) continue;

    const parsed = parseSkill(raw);

    if (!parsed.name || !parsed.description) continue;

    skills.push({
      name: parsed.name,
      description: parsed.description,
      tags: parsed.tags,
      prompt: parsed.body,
      source: "learned",
      path: skillPath,
    });
  }

  return skills;
}

function parseSkill(raw: string): {
  name: string;
  description: string;
  tags: string[];
  body: string;
} {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  if (!match) {
    return {
      name: "",
      description: "",
      tags: [],
      body: raw,
    };
  }

  const frontmatter = match[1] ?? "";
  const body = match[2] ?? "";

  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? "";

  const description =
    frontmatter
      .match(/^description:\s*(.+)$/m)?.[1]
      ?.trim()
      .replace(/^"|"$/g, "") ?? "";

  const tagsBlock = frontmatter.match(/^tags:\n((?:\s+- .+\n?)*)/m)?.[1] ?? "";

  const tags = tagsBlock
    .split("\n")
    .map((line) => line.trim().replace(/^- /, ""))
    .filter(Boolean);

  return {
    name,
    description,
    tags,
    body: body.trim(),
  };
}
```

然后 `/skill list` 合并：

```ts
const learnedSkills = await loadLearnedSkills(state.path);

const skills = [
  ...SKILL_CATALOG.map((skill) => ({
    ...skill,
    source: "builtin" as const,
  })),
  ...learnedSkills,
];
```

---

# 17. 冲突策略

必须做，否则 `/learn apply` 会破坏已有 skill。

## 默认行为

```text
如果 .minimum/skills/learned/<name>/SKILL.md 已存在：
  不覆盖
  返回错误
  提示 --overwrite 或 --rename
```

## 支持命令

```bash
/learn apply learn_123 --rename pipeline-loop-check-v2
/learn apply learn_123 --overwrite
```

## 不建议第一版做 merge

```bash
/learn apply learn_123 --merge
```

`merge` 涉及语义合并，容易引入污染。第二版再做。

---

# 18. `/learn` 调用模型的推荐 Prompt

当需要 LLM 生成 draft 时，不要直接把聊天记录扔给模型。要组合成：

```text
<learn-skill-writer/SKILL.md 原文>

Now generate exactly one LearnedSkillDraft JSON object.

Constraints:
- JSON only.
- No markdown fence.
- No memory.
- No persona patch.
- No raw transcript.
- No secrets.
- Exactly one reusable skill.

Preferred name:
<preferredName or none>

Existing skill names:
<names>

Session context:
<context>
```

输出必须是：

```json
{
  "id": "learn_...",
  "name": "pipeline-loop-check",
  "description": "Use when validating pipeline output before final delivery and deciding whether incomplete work should return to planning",
  "tags": ["learned", "pipeline", "review"],
  "body": "# Pipeline Loop Check\n\n## Purpose\n...",
  "targetDir": "",
  "targetPath": "",
  "createdAt": 0,
  "updatedAt": 0,
  "status": "draft",
  "source": {
    "projectRoot": "",
    "messageCount": 0
  },
  "warnings": []
}
```

`targetDir / targetPath / createdAt / source` 可以由本地代码覆盖，不能完全信模型。

---

# 19. 推荐实现顺序

## Phase 1：命令闭环

实现：

```text
/learn --name xxx
/learn preview <id>
/learn apply <id>
/learn status
```

完成标准：

```text
能生成 draft
能预览
能落盘 SKILL.md
能写 metadata.json
不会覆盖已有 skill
```

## Phase 2：接入 system skill prompt

实现：

```text
src/skills/system/learn-skill-writer/SKILL.md
LearnSkillPromptLoader
LLM JSON draft generation
```

完成标准：

```text
/learn 生成的 skill 遵守 learn-skill-writer 约束
description 以 Use when 开头
body 有 Output Contract / Verification Checklist
```

## Phase 3：接入 `/skill`

实现：

```text
loadLearnedSkills()
/skill list 显示 learned skill
/skill run <name> 可运行 learned skill
/learn apply <id> --load 可刷新
```

完成标准：

```text
/learn apply learn_x --load
/skill list
/skill run generated-skill-name
```

## Phase 4：增强交互

实现：

```text
/learn edit <id>
/learn diff <id>
/learn apply --rename
/learn apply --overwrite
```

第一版可以不做 full-screen review panel。

---

# 20. 测试计划

## 单元测试

```text
tests/unit/learn-command.test.ts
tests/unit/learn-draft-store.test.ts
tests/unit/learned-skill-writer.test.ts
tests/unit/learned-skill-validator.test.ts
tests/unit/learned-skill-loader.test.ts
```

## 核心测试用例

```ts
it("parses /learn --name pipeline-loop-check", () => {});
it("creates a learned skill draft", () => {});
it("writes SKILL.md and metadata.json", () => {});
it("rejects invalid skill names", () => {});
it("rejects descriptions not starting with Use when", () => {});
it("does not overwrite existing skills by default", () => {});
it("allows overwrite with --overwrite", () => {});
it("allows rename with --rename", () => {});
it("filters sensitive content", () => {});
it("loads learned skills into /skill list", () => {});
```

---

# 21. 最小可交付验收

你可以按这个标准验收：

```bash
/learn --name pipeline-loop-check
```

输出：

```text
Learned skill draft created: learn_...
Name: pipeline-loop-check
Target: .minimum/skills/learned/pipeline-loop-check/SKILL.md

Apply with:
/learn apply learn_...
```

执行：

```bash
/learn apply learn_...
```

生成：

```text
.minimum/skills/learned/pipeline-loop-check/SKILL.md
.minimum/skills/learned/pipeline-loop-check/metadata.json
```

执行：

```bash
/skill list
```

能看到：

```text
pipeline-loop-check    Use when validating pipeline output before final delivery...
```

执行：

```bash
/skill run pipeline-loop-check
```

能把该 skill 的正文作为 pipeline prompt 注入。

---

# 22. 总体架构图

```text
/learn command
  ↓
commands.ts
  ↓
CommandOutcome: learn.create / learn.apply / learn.status
  ↓
app.tsx applyOutcome()
  ↓
LearnCommandService
  ├─ LearnSkillPromptLoader
  │    └─ src/skills/system/learn-skill-writer/SKILL.md
  ├─ LearnDraftStore
  │    └─ .minimum/learn/drafts/*.json
  ├─ LearnedSkillValidator
  ├─ LearnedSkillWriter
  │    └─ .minimum/skills/learned/<name>/SKILL.md
  └─ reloadSkills()
       └─ LearnedSkillLoader
            └─ /skill list / /skill run
```

这版是干净的：`/learn` 只做 **skill draft → skill 落盘 → skill 加载**，不会碰 memory/persona，也不会污染源码内置 skills。
