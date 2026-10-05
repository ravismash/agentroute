import { z } from "zod";

/** Opaque identifier used for tenants, customers, cases, actions, etc. */
export const Id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_\-:.]+$/, "id may only contain letters, digits, _ - : .");

/** ISO 4217 currency code, e.g. USD, EUR, INR. */
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, "must be an ISO 4217 currency code");

/**
 * Money is always integer minor units (cents/paise) plus a currency code.
 * Floats are rejected so rounding can never change a refund amount.
 */
export const AmountMinor = z
  .number()
  .int("amount must be an integer number of minor units")
  .positive()
  .max(100_000_000);

export const IsoTimestamp = z.iso.datetime({ offset: true });
