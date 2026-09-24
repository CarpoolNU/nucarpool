/**
 * The NUCarpool feedback form, a Jira form on the `SCRUM` project.
 *
 * Two places link to it: the Feedback button in `DropDownMenu`, and the prompt
 * shown when a carpool ends (`CarpoolEndedToast`). It is a constant rather
 * than a literal in each so that replacing the form cannot update one entry
 * point and strand the other.
 *
 * Submissions land in Jira, not in this app's database. That is what keeps
 * post-match feedback admin-only (SCRUM-545): nothing the app renders reads
 * them back, so a rated user has no surface on which to see one - direct or
 * indirect. See `docs/design/post-match-feedback.md`.
 */
export const FEEDBACK_FORM_URL =
  "https://carpoolnu.atlassian.net/jira/software/form/dfa5383a-5436-4a1c-b434-2c4f56428623?atlOrigin=eyJpIjoiMzkwYjU1YzQwNmIzNDI0Zjk4N2NiMGQwNzAzZGE3ZWYiLCJwIjoiaiJ9";
