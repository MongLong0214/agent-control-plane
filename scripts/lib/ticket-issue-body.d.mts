/** Types for `ticket-issue-body.mjs`, which a `.ts` test imports; see `collapse-trailer-paragraphs.d.mts`. */
export interface Ticket {
  readonly id: string;
  readonly milestone: string;
  readonly title: string;
  readonly deps: readonly string[];
  readonly requirements: readonly string[];
  readonly scenarios: readonly string[];
  readonly acceptance: string;
  /** A dated correction to `acceptance`, rendered as a labelled note right after it. */
  readonly amendment?: string;
}

export declare const ticketIssueBody: (ticket: Ticket, tickets: readonly Ticket[]) => string;
