export type IssueSeverity = 'error' | 'warning';

export type ValidationIssue = {
  severity: IssueSeverity;
  code: string;
  message: string;
  path?: string;
};

export type ValidationReport = {
  ok: boolean;
  issues: ValidationIssue[];
};

export function errorIssue(code: string, message: string, path?: string): ValidationIssue {
  return { severity: 'error', code, message, path };
}

export function warningIssue(code: string, message: string, path?: string): ValidationIssue {
  return { severity: 'warning', code, message, path };
}

export function makeReport(issues: ValidationIssue[]): ValidationReport {
  return {
    ok: issues.every((issue) => issue.severity !== 'error'),
    issues,
  };
}
