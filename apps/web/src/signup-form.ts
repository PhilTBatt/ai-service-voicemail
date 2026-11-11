// The signup form's problems in words (pages/SignupPage.tsx). Pure, tested in signup-form.test.ts.

/** A field's problems, by the form's field name (the schema's), each list in order, no repeats. */
export type SignupProblems = Partial<Record<string, string[]>>;

/**
 * The schema's complaints as the person should read them, beside the field each is about. A
 * choice from a list says "choose one" rather than listing every allowed value, as the schema's
 * own message for a bad option does.
 */
export function signupProblems(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
  missingVoicemail: boolean,
): SignupProblems {
  const problems: Record<string, string[]> = {};
  const add = (field: string, message: string) => {
    const list = (problems[field] ??= []);
    if (!list.includes(message)) list.push(message);
  };
  for (const issue of issues) {
    const field = String(issue.path[0]);
    if (field === "accepted") add(field, "Documents: tick all three to continue");
    else if (field === "mobileNetwork") add(field, "Choose your network");
    else if (field === "trade") add(field, "Choose your trade");
    else add(field, issue.message.charAt(0).toUpperCase() + issue.message.slice(1));
  }
  if (missingVoicemail) add("usesNetworkVoicemail", "Choose yes or no");
  return problems;
}
