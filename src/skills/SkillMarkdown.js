export function parseSkillMarkdown(markdown) {
    const trimmed = markdown.trimStart();
    if (!trimmed.startsWith("---"))
        return { frontmatter: {}, body: markdown };
    const end = trimmed.indexOf("\n---", 3);
    if (end < 0)
        return { frontmatter: {}, body: markdown };
    const yaml = trimmed.slice(3, end).trim();
    const body = trimmed.slice(end + "\n---".length).trimStart();
    return { frontmatter: parseSimpleYaml(yaml), body };
}
export function getString(value, fallback = "") {
    return typeof value === "string" ? value : fallback;
}
export function getStringArray(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => typeof item === "string");
}
function parseSimpleYaml(yaml) {
    const root = {};
    const lines = yaml.split(/\r?\n/);
    const stack = [
        { indent: -1, value: root },
    ];
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (!raw.trim())
            continue;
        const indent = raw.match(/^\s*/)?.[0].length ?? 0;
        const line = raw.trim();
        while (stack.length > 1 && indent <= stack[stack.length - 1].indent)
            stack.pop();
        const current = stack[stack.length - 1].value;
        if (line.startsWith("- ")) {
            if (Array.isArray(current))
                current.push(parseScalar(line.slice(2)));
            continue;
        }
        const split = line.indexOf(":");
        if (split < 0 || Array.isArray(current))
            continue;
        const key = line.slice(0, split).trim();
        const rest = line.slice(split + 1).trim();
        if (rest) {
            current[key] = parseScalar(rest);
            continue;
        }
        const next = nextNonEmpty(lines, i + 1);
        const child = next?.trim().startsWith("- ") ? [] : {};
        current[key] = child;
        stack.push({ indent, value: child });
    }
    return root;
}
function nextNonEmpty(lines, start) {
    for (let i = start; i < lines.length; i++) {
        const line = lines[i];
        if (line && line.trim())
            return line;
    }
    return undefined;
}
function parseScalar(value) {
    const unquoted = value.replace(/^["']|["']$/g, "");
    if (unquoted === "true")
        return true;
    if (unquoted === "false")
        return false;
    const num = Number(unquoted);
    if (Number.isFinite(num) && /^-?\d+(?:\.\d+)?$/.test(unquoted))
        return num;
    return unquoted;
}
