-- 0002: payments to refund against, operator API tokens, execution targets.
-- Additive only (expand phase): safe to apply while the previous release runs.

CREATE TABLE payments (
  tenant_id           external_id   NOT NULL,
  id                  external_id   NOT NULL,
  customer_id         external_id   NOT NULL,
  provider            text          NOT NULL,
  provider_payment_id text          NOT NULL,
  amount_minor        amount_minor  NOT NULL,
  refunded_minor      bigint        NOT NULL DEFAULT 0,
  currency            currency_code NOT NULL,
  created_at          timestamptz   NOT NULL DEFAULT now(),
  updated_at          timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT pk_payments PRIMARY KEY (tenant_id, id),
  CONSTRAINT fk_payments_customer FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  CONSTRAINT uq_payments_provider_ref UNIQUE (provider, provider_payment_id),
  CONSTRAINT ck_payments_provider CHECK (provider IN ('stripe')),
  -- Over-refund guard: refunds are reserved here before the provider call.
  CONSTRAINT ck_payments_refunded CHECK (refunded_minor >= 0 AND refunded_minor <= amount_minor)
);
CREATE INDEX ix_payments_customer ON payments (tenant_id, customer_id, currency, created_at DESC);
CREATE TRIGGER tr_payments_updated_at BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
COMMENT ON TABLE payments IS 'Customer payments (simulated billing). refunded_minor includes in-flight refund reservations.';

ALTER TABLE executions ADD COLUMN provider_target text;
COMMENT ON COLUMN executions.provider_target IS 'Provider object acted on, e.g. the Stripe payment_intent being refunded; used for reconciliation.';

CREATE TABLE operator_tokens (
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  operator_id  uuid        NOT NULL,
  prefix       text        NOT NULL,
  key_hash     bytea       NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  CONSTRAINT pk_operator_tokens PRIMARY KEY (id),
  CONSTRAINT fk_operator_tokens_operator FOREIGN KEY (operator_id) REFERENCES operators (id),
  CONSTRAINT uq_operator_tokens_prefix UNIQUE (prefix),
  CONSTRAINT ck_operator_tokens_prefix CHECK (prefix ~ '^ar_op_[A-Za-z0-9]{8}$'),
  CONSTRAINT ck_operator_tokens_hash CHECK (octet_length(key_hash) = 32),
  CONSTRAINT ck_operator_tokens_expiry CHECK (expires_at IS NULL OR expires_at > created_at)
);
CREATE INDEX ix_operator_tokens_operator ON operator_tokens (operator_id);
COMMENT ON TABLE operator_tokens IS 'Operator API tokens (hash only). Tenant scope comes from operators.tenant_id.';
