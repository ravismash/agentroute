const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can could do does did for from had has have how i if in into is it its " +
    "me my of on or our so that the their them then there these they this to too us was we were what when where " +
    "which who why will with would you your yours am any all also just get got"
  ).split(" "),
);

/**
 * Domain synonyms for lexical recall: customer phrasing → help-center vocabulary.
 * Applied at query time only, so the index stays faithful to the source text.
 */
const SYNONYMS: Record<string, string[]> = {
  money: ["refund"],
  reimburse: ["refund"],
  reimbursement: ["refund"],
  twice: ["duplicate"],
  double: ["duplicate"],
  bill: ["invoice", "billing"],
  receipt: ["invoice"],
  cancel: ["cancel", "cancellation"],
  quit: ["cancel"],
  downtime: ["outage", "uptime", "sla"],
  outage: ["uptime", "sla"],
  down: ["outage", "status"],
  compensation: ["credit", "sla"],
  price: ["pricing", "plan"],
  cost: ["pricing", "price"],
  cheaper: ["downgrade"],
  upgrade: ["upgrade", "plan"],
  declined: ["failed", "payment"],
  bounced: ["failed", "payment"],
  card: ["card", "payment"],
  vat: ["tax"],
  gst: ["tax"],
  login: ["sign", "password", "sso"],
  password: ["password", "reset"],
  delete: ["delete", "deletion"],
  remove: ["delete", "removing"],
  dispute: ["chargeback", "dispute"],
  owner: ["ownership", "owner"],
  seat: ["user", "seat"],
  seats: ["user", "seat"],
  trial: ["trial", "free"],
  nonprofit: ["nonprofit", "discount"],
  euros: ["eur", "currency"],
  euro: ["eur", "currency"],
  pounds: ["gbp", "currency"],
  rupees: ["inr", "currency"],
  dollars: ["usd", "currency"],
  ticket: ["support", "response"],
  answer: ["response"],
  reply: ["response"],
  erase: ["delete", "deletion"],
  wipe: ["delete", "deletion"],
  charity: ["nonprofit", "discount"],
  student: ["education", "discount"],
};

/**
 * Light suffix stripping: enough to match refund/refunds/refunded,
 * charge/charges/charged and downgrade/downgrading (final "e" is dropped).
 */
export function stem(token: string): string {
  if (token.length <= 4) return token;
  for (const suffix of ["ations", "ation", "ings", "ing", "ies", "ed", "es", "s"]) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) {
      return suffix === "ies" ? `${token.slice(0, -3)}y` : token.slice(0, -suffix.length);
    }
  }
  return token.endsWith("e") ? token.slice(0, -1) : token;
}

function words(text: string): string[] {
  // Fold accents (é → e) so "devolución" and "devolucion" match.
  const folded = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
  return (folded.match(/[a-z0-9]+/g) ?? []).filter((t) => !STOPWORDS.has(t));
}

export function tokenize(text: string): string[] {
  return words(text).map(stem);
}

/** Query tokens plus synonym expansions (deduplicated). */
export function expandQuery(text: string): string[] {
  const out = new Set<string>();
  for (const token of words(text)) {
    out.add(stem(token));
    for (const synonym of SYNONYMS[token] ?? []) out.add(stem(synonym));
  }
  return [...out];
}
