/**
 * Labelled retrieval queries: realistic customer phrasings mapped to the
 * article(s) that answer them. Deliberately paraphrased (few title words)
 * so lexical matching is actually tested.
 */
export interface LabelledQuery {
  query: string;
  relevant: string[];
}

/** Development set: used while building the retriever and tuning the synonym map. */
export const RETRIEVAL_QUERIES: LabelledQuery[] = [
  { query: "when will the money show up back on my card", relevant: ["refund-timing"] },
  { query: "it's been two weeks and I still don't see the refund", relevant: ["refund-timing"] },
  { query: "can I get my money back for a partial month", relevant: ["refund-policy"] },
  { query: "is there a limit on what support can refund straight away", relevant: ["refund-policy"] },
  { query: "you billed me twice this month", relevant: ["duplicate-charges"] },
  { query: "two identical charges on my statement", relevant: ["duplicate-charges"] },
  { query: "how much does the business tier cost per person", relevant: ["plans-and-pricing"] },
  { query: "what's the difference between pro and starter", relevant: ["plans-and-pricing"] },
  {
    query: "if I move to a bigger plan mid month do I pay the full price",
    relevant: ["proration", "change-plan"],
  },
  { query: "when does a downgrade kick in", relevant: ["change-plan"] },
  { query: "how do I stop my subscription", relevant: ["cancel-subscription"] },
  { query: "what happens to my files after I quit", relevant: ["cancel-subscription", "data-retention"] },
  { query: "bring back a workspace I closed last week", relevant: ["reactivate-account"] },
  { query: "where can I download a receipt for accounting", relevant: ["invoices"] },
  { query: "add our VAT number to the bill", relevant: ["invoices", "taxes"] },
  { query: "do you take apple pay", relevant: ["payment-methods"] },
  { query: "my card got declined at renewal", relevant: ["failed-payment"] },
  { query: "can I pay in euros instead of dollars", relevant: ["currencies"] },
  { query: "are you going to charge me sales tax", relevant: ["taxes"] },
  { query: "compensation for yesterday's downtime", relevant: ["sla-credits"] },
  { query: "is the app down right now", relevant: ["status-page"] },
  { query: "how fast will someone answer my ticket", relevant: ["contact-support"] },
  { query: "invite a colleague to our team", relevant: ["add-remove-users"] },
  { query: "the person who owns our account left the company", relevant: ["account-owner"] },
  { query: "download all our data as a spreadsheet", relevant: ["export-your-data"] },
  { query: "erase everything about my company", relevant: ["delete-account"] },
  { query: "is my information encrypted", relevant: ["security-overview"] },
  { query: "lost my phone with the authenticator app", relevant: ["two-factor-auth"] },
  { query: "log in with Okta", relevant: ["sso"] },
  { query: "I forgot my login", relevant: ["reset-password"] },
  { query: "how long can I try it for free", relevant: ["free-trial"] },
  { query: "discount for a charity", relevant: ["discounts"] },
  { query: "move my renewal to the first of the month", relevant: ["billing-dates"] },
  { query: "does it connect to slack", relevant: ["integrations"] },
  { query: "I filed a dispute with my bank", relevant: ["chargebacks"] },
];

/**
 * Held-out set: written after tuning stopped and never used to tune anything.
 * Its scores are the honest estimate of retrieval quality on new phrasings.
 */
export const HELD_OUT_QUERIES: LabelledQuery[] = [
  { query: "the refund was approved but my bank balance hasn't changed", relevant: ["refund-timing"] },
  { query: "same subscription fee taken from my account two times", relevant: ["duplicate-charges"] },
  { query: "which plan has single sign on and audit logs", relevant: ["plans-and-pricing", "sso"] },
  { query: "I want to switch to a cheaper tier next month", relevant: ["change-plan"] },
  { query: "renewal payment failed what now", relevant: ["failed-payment"] },
  { query: "get a copy of last year's invoices", relevant: ["invoices"] },
  { query: "credit for the outage on the business plan", relevant: ["sla-credits"] },
  { query: "a coworker needs access to our workspace", relevant: ["add-remove-users"] },
  { query: "permanently remove our account and data", relevant: ["delete-account"] },
  { query: "reset two-step verification for a teammate", relevant: ["two-factor-auth"] },
  { query: "do schools get a lower price", relevant: ["discounts"] },
  { query: "what happens if I contest the charge with my card issuer", relevant: ["chargebacks"] },
];
