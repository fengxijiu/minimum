const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function toSkillSlug(input) {
    const slug = input
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-{2,}/g, "-");
    return slug || "learned-skill";
}
export function isValidSkillSlug(input) {
    return SLUG_RE.test(input);
}
export function titleFromSlug(slug) {
    return slug
        .split("-")
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
}
