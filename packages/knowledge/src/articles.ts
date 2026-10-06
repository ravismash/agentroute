/**
 * Help-center articles for the fictional "Acme" subscription product used in
 * the demo. Sections ("## ...") become retrieval chunks.
 */
export interface Article {
  slug: string;
  title: string;
  category: "billing" | "refunds" | "plans" | "account" | "security" | "service" | "support";
  body: string;
}

export const HELP_CENTER_BASE_URL = "https://help.acme.test/articles/";

export const ARTICLES: Article[] = [
  {
    slug: "refund-policy",
    title: "Refund policy",
    category: "refunds",
    body: `## Who can get a refund
You can request a refund for duplicate charges, billing errors, service outages and unused time after cancelling an annual plan. Monthly plans are not refunded for partial months.

## Small refunds
Support can approve refunds up to $25 immediately. Larger refunds are reviewed by our billing team, usually within one business day.

## Refunds we can't make
We can't refund charges older than 12 months or move a refund to a different customer's account.`,
  },
  {
    slug: "refund-timing",
    title: "How long does a refund take?",
    category: "refunds",
    body: `## Card refunds
Once a refund is issued, it usually appears on your card statement within 5–10 business days, depending on your bank.

## Pending refunds
If your refund is under review, you'll get an email when it is approved. The 5–10 business day window starts after approval.

## Still not there?
If 10 business days have passed, contact support with the refund date and we'll send you the bank reference number (ARN) to give to your bank.`,
  },
  {
    slug: "duplicate-charges",
    title: "I was charged twice",
    category: "billing",
    body: `## Why duplicate charges happen
A duplicate charge can happen when a payment is retried after a timeout or when a plan change and a renewal happen on the same day.

## Pending authorisations
Sometimes the second charge is only a pending authorisation and disappears on its own within 3 business days.

## Getting your money back
If both charges have settled, contact support. Duplicate charges are always refunded in full.`,
  },
  {
    slug: "plans-and-pricing",
    title: "Plans and pricing",
    category: "plans",
    body: `## Plans
Acme has three plans: Starter ($12 per user per month), Pro ($29 per user per month) and Business ($59 per user per month). Annual billing saves 20%.

## What's included
Starter includes core features and email support. Pro adds automations and priority support. Business adds SSO, audit logs and a 99.9% uptime SLA.

## Custom plans
For more than 200 users, contact sales for an Enterprise plan.`,
  },
  {
    slug: "change-plan",
    title: "Upgrading or downgrading your plan",
    category: "plans",
    body: `## Upgrading
Upgrades take effect immediately. You're charged a prorated amount for the rest of the current billing period.

## Downgrading
Downgrades take effect at the start of the next billing cycle, so you keep your current features until then.

## Who can change the plan
Only account owners and billing admins can change plans. Support can also make the change for you.`,
  },
  {
    slug: "proration",
    title: "How proration works",
    category: "billing",
    body: `## Mid-cycle changes
When you upgrade or add users mid-cycle, you pay only for the remaining days of the period, not the full price.

## Example
Upgrading from Pro to Business halfway through a monthly cycle costs half the price difference for that month.

## Credits
Removing users mid-cycle creates a credit that is applied to your next invoice; it is not refunded to your card.`,
  },
  {
    slug: "cancel-subscription",
    title: "Cancelling your subscription",
    category: "account",
    body: `## How to cancel
Account owners can cancel from Settings → Billing → Cancel subscription. You keep access until the end of the paid period.

## Annual plans
If you cancel an annual plan, you can request a refund for unused full months.

## Your data after cancelling
Your data is kept for 30 days after the subscription ends, so you can reactivate without losing anything.`,
  },
  {
    slug: "reactivate-account",
    title: "Reactivating a cancelled account",
    category: "account",
    body: `## Within 30 days
Reactivate from Settings → Billing within 30 days of cancellation and all your data is restored.

## After 30 days
After 30 days, data is permanently deleted and you'll start with a new, empty workspace.`,
  },
  {
    slug: "invoices",
    title: "Finding and downloading invoices",
    category: "billing",
    body: `## Where to find invoices
Billing admins can download every invoice as a PDF from Settings → Billing → Invoices.

## Changing invoice details
You can add a company name, address and VAT or GST number. Changes apply to future invoices; contact support to reissue a past invoice.

## Invoice emails
Invoices are emailed to the billing contact on each renewal.`,
  },
  {
    slug: "payment-methods",
    title: "Accepted payment methods",
    category: "billing",
    body: `## Cards and wallets
We accept Visa, Mastercard, American Express, Apple Pay and Google Pay.

## Bank transfer
Annual Business and Enterprise plans can pay by bank transfer or ACH.

## Updating your card
Update your card in Settings → Billing → Payment method. Support agents can never take card numbers by chat or email.`,
  },
  {
    slug: "failed-payment",
    title: "What happens if a payment fails",
    category: "billing",
    body: `## Retries
If a renewal payment fails, we retry it 3 times over 7 days and email the billing contact each time.

## Past-due accounts
After the final retry your subscription becomes past due. You keep read-only access for 14 days before the account is paused.

## Fixing it
Update your payment method and the outstanding invoice is charged automatically.`,
  },
  {
    slug: "currencies",
    title: "Currencies and exchange rates",
    category: "billing",
    body: `## Billing currency
You are billed in USD, EUR, GBP or INR, depending on the country you chose at sign-up.

## Changing currency
The billing currency can't be changed on an active subscription. Refunds are always made in the original billing currency.

## Exchange fees
Your bank may add foreign exchange fees if your card is in a different currency.`,
  },
  {
    slug: "taxes",
    title: "Sales tax, VAT and GST",
    category: "billing",
    body: `## When tax is charged
We charge sales tax, VAT or GST where required by law, based on your billing address.

## Tax exemption
Businesses can enter a valid VAT or GST number to apply the reverse charge. Tax-exempt organisations can send their exemption certificate to support.`,
  },
  {
    slug: "sla-credits",
    title: "Uptime SLA and service credits",
    category: "service",
    body: `## Uptime commitment
The Business plan includes a 99.9% monthly uptime SLA.

## Service credits
If uptime falls below 99.9% in a month, Business customers get a service credit of 10% of that month's fee, or 25% below 99%.

## Other plans
Starter and Pro customers affected by a major outage can contact support; we review compensation case by case.`,
  },
  {
    slug: "status-page",
    title: "Checking service status",
    category: "service",
    body: `## Status page
Live service status and incident history are at status.acme.test. You can subscribe to email or SMS updates.

## Reporting a problem
If something is broken but the status page shows no incident, contact support with screenshots and the time it happened.`,
  },
  {
    slug: "contact-support",
    title: "Contacting support",
    category: "support",
    body: `## Channels
Chat and email support are available 24/7. Phone support is available on the Business plan.

## Response times
Starter: within 24 hours. Pro: within 4 hours. Business: within 1 hour for urgent issues.

## Escalations
Ask the agent to escalate if your issue isn't resolved; a specialist will follow up.`,
  },
  {
    slug: "add-remove-users",
    title: "Adding and removing users",
    category: "account",
    body: `## Adding users
Admins can invite users from Settings → Members. New users are billed prorated for the rest of the period.

## Removing users
Removing a user frees the seat immediately. The unused time becomes a credit on your next invoice.`,
  },
  {
    slug: "account-owner",
    title: "Transferring account ownership",
    category: "account",
    body: `## Transfer
The current owner can transfer ownership to another admin from Settings → Members.

## Owner unavailable
If the owner has left the company, an admin can request a transfer; we verify it with a domain check and a signed request from the company.`,
  },
  {
    slug: "export-your-data",
    title: "Exporting your workspace data",
    category: "security",
    body: `## Self-service export
Admins can export their own workspace as CSV or JSON from Settings → Data → Export. Exports are emailed as a download link that expires after 24 hours.

## What support can't do
For privacy reasons, support can't send data exports by chat and can never share data about other customers.`,
  },
  {
    slug: "delete-account",
    title: "Deleting your account permanently",
    category: "security",
    body: `## Requesting deletion
Only the account owner can request permanent deletion, from Settings → Account → Delete. We confirm by email before deleting.

## Timeline
Data is deleted within 30 days and removed from backups within 90 days. Deletion can't be undone.`,
  },
  {
    slug: "security-overview",
    title: "How we protect your data",
    category: "security",
    body: `## Encryption
Data is encrypted in transit with TLS 1.2+ and at rest with AES-256.

## Access
Employee access to customer data is limited, logged and reviewed. We are SOC 2 Type II audited annually.

## Payment data
Card details are handled by our payment provider; Acme never stores full card numbers.`,
  },
  {
    slug: "two-factor-auth",
    title: "Two-factor authentication",
    category: "security",
    body: `## Turning on 2FA
Enable two-factor authentication from Profile → Security using an authenticator app or a security key.

## Lost device
Use one of your backup codes. If you've lost those too, your admin can reset 2FA for your account.`,
  },
  {
    slug: "sso",
    title: "Single sign-on (SSO)",
    category: "security",
    body: `## Availability
SAML single sign-on with Okta, Azure AD and Google Workspace is available on the Business plan.

## Enforcing SSO
Admins can require SSO for all members, which disables password login.`,
  },
  {
    slug: "reset-password",
    title: "Resetting your password",
    category: "account",
    body: `## Forgot password
Use "Forgot password" on the sign-in page; the reset link is valid for 1 hour.

## No email arriving
Check spam, then ask your admin to confirm your email address. Support can't reset passwords over chat.`,
  },
  {
    slug: "free-trial",
    title: "Free trial",
    category: "plans",
    body: `## Trial length
New workspaces get a 14-day free trial of the Pro plan. No card is needed to start.

## After the trial
At the end of the trial, choose a plan to keep your data. Unpaid trials are paused, not deleted, for 30 days.`,
  },
  {
    slug: "discounts",
    title: "Discounts for nonprofits and education",
    category: "plans",
    body: `## Who qualifies
Registered nonprofits and accredited schools get 50% off Pro and Business plans.

## How to apply
Send proof of status to support. The discount applies from the next renewal and isn't backdated.`,
  },
  {
    slug: "billing-dates",
    title: "Billing dates and renewals",
    category: "billing",
    body: `## Renewal date
Your subscription renews on the same day each month or year as you first subscribed.

## Changing the billing date
The billing date can't be changed directly, but support can align it once by applying a prorated credit.`,
  },
  {
    slug: "integrations",
    title: "Available integrations",
    category: "service",
    body: `## Built-in integrations
Acme integrates with Slack, Microsoft Teams, Google Drive, Jira and GitHub.

## API and webhooks
Pro and Business plans include the REST API and webhooks for building your own integrations.`,
  },
  {
    slug: "data-retention",
    title: "Data retention",
    category: "security",
    body: `## Active workspaces
Data is kept for as long as your subscription is active.

## Logs
Audit logs are kept for 1 year on Business and 90 days on other plans.

## After cancellation
Workspace data is kept for 30 days after cancellation, then permanently deleted.`,
  },
  {
    slug: "chargebacks",
    title: "Disputes and chargebacks",
    category: "billing",
    body: `## Before disputing with your bank
Please contact support first: most billing problems are fixed within a day, and refunds are faster than bank disputes.

## If a chargeback is filed
When a chargeback is opened, the disputed amount can't also be refunded by us. The account may be paused until the dispute is resolved.`,
  },
];
