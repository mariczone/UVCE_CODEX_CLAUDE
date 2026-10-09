export type IssueSeverity = 'error' | 'warning';

/** A validation / resolution finding. `path` is a JSON-pointer-like location for humans and tests. */
export interface Issue {
  severity: IssueSeverity;
  code: string;
  path: string;
  message: string;
}

export function issue(severity: IssueSeverity, code: string, path: string, message: string): Issue {
  return { severity, code, path, message };
}

export function hasErrors(issues: readonly Issue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

export function formatIssues(issues: readonly Issue[], limit = 20): string {
  const lines = issues.slice(0, limit).map((i) => `[${i.severity}] ${i.code} at ${i.path || '/'}: ${i.message}`);
  if (issues.length > limit) lines.push(`... and ${issues.length - limit} more`);
  return lines.join('\n');
}
