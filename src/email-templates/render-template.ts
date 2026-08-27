// Pure {{key}} substitution — deliberately dependency-free (no templating
// library) per spec. Unmatched placeholders are left as-is (e.g. a template
// referencing {{years}} rendered for a BIRTHDAY occasion, which never
// supplies one) rather than throwing or silently blanking, so a malformed/
// mismatched template is visible in the rendered output instead of hiding
// the problem.
export function renderTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(
    /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
    (match: string, key: string) => {
      return Object.prototype.hasOwnProperty.call(variables, key)
        ? variables[key]
        : match;
    },
  );
}
