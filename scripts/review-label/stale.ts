/**
 * When the `Ready for Human Review` label no longer holds for a pull request,
 * as pure functions for `sweep.ts`.
 */

export const READY_LABEL = 'Ready for Human Review';

export interface LabeledPullRequest {
  number: number;
  /** GraphQL `MergeableState`; `UNKNOWN` while GitHub is still computing it. */
  mergeable: string;
  isDraft: boolean;
  /** Each reviewer's latest approve, change request, or dismissal; plain comments never replace one. */
  verdicts: { state: string; author: string | null }[];
}

/** Why the label is stale, one entry per cause; empty while it still holds. */
export function staleReasons(pr: LabeledPullRequest): string[] {
  const reasons: string[] = [];
  if (pr.mergeable === 'CONFLICTING') reasons.push('merge conflict');
  if (pr.isDraft) reasons.push('draft');
  const requesters = pr.verdicts.filter(({ state }) => state === 'CHANGES_REQUESTED').map(({ author }) => author ?? 'ghost');
  if (requesters.length > 0) reasons.push(`changes requested by ${requesters.join(', ')}`);
  return reasons;
}
