// Times as the people using AnswerMate read them (CLAUDE.md: stored in UTC, shown in
// Europe/London), for text outside the dashboard: CSV exports and the API's own messages.

/** A moment as UK clock time to the second, "2026-07-01 11:00:00": BST in summer, GMT in winter. */
export function ukDateTime(date: Date): string {
  return Temporal.Instant.fromEpochMilliseconds(date.getTime())
    .toZonedDateTimeISO("Europe/London")
    .toPlainDateTime()
    .toString({ smallestUnit: "second" })
    .replace("T", " ");
}
