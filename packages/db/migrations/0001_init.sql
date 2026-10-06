-- 0001_init: core schema for AgentRoute.
--
-- Conventions (docs/database.md):
--   * snake_case, plural table names; constraints named pk_/fk_/uq_/ck_, indexes ix_/uq_
--   * every business table carries tenant_id; cross-table references include
--     tenant_id in composite foreign keys so a row can never point at another
--     tenant's data
--   * enumerations are text + CHECK (easy to evolve), kept in sync with
--     @agentroute/contracts by drift tests
--   * money is bigint minor units + ISO 4217 code; timestamps are timestamptz
--   * every foreign key has a supporting index (enforced by a catalog test)
--   * audit data is append-only, enforced by triggers

-- ─── Domains ────────────────────────────────────────────────────────────────

CREATE DOMAIN external_id AS text
  CONSTRAINT ck_external_id CHECK (VALUE ~ '^[A-Za-z0-9_:.-]{1,128}$');

CREATE DOMAIN currency_code AS text
  CONSTRAINT ck_currency_code CHECK (VALUE ~ '^[A-Z]{3}$');

CREATE DOMAIN amount_minor AS bigint
  CONSTRAINT ck_amount_minor CHECK (VALUE > 0 AND VALUE <= 100000000);

CREATE DOMAIN sha256_hex AS text
  CONSTRAINT ck_sha256_hex CHECK (VALUE ~ '^[0-9a-f]{64}$');

-- ─── Shared trigger functions ───────────────────────────────────────────────

CREATE FUNCTION set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE FUNCTION forbid_modification() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% not allowed)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

-- ─── Tenancy and identity ───────────────────────────────────────────────────

CREATE TABLE tenants (
  id                     external_id  NOT NULL,
  name                   text         NOT NULL,
  status                 text         NOT NULL DEFAULT 'active',
  daily_llm_budget_minor bigint       NOT NULL DEFAULT 200,
  budget_currency        currency_code NOT NULL DEFAULT 'USD',
  kill_switch            boolean      NOT NULL DEFAULT false,
  created_at             timestamptz  NOT NULL DEFAULT now(),
  updated_at             timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT pk_tenants PRIMARY KEY (id),
  CONSTRAINT ck_tenants_name CHECK (length(name) BETWEEN 1 AND 200),
  CONSTRAINT ck_tenants_status CHECK (status IN ('active', 'suspended')),
  CONSTRAINT ck_tenants_budget CHECK (daily_llm_budget_minor >= 0)
);
COMMENT ON TABLE tenants IS 'Customers of AgentRoute. Every business row belongs to exactly one tenant.';
COMMENT ON COLUMN tenants.kill_switch IS 'When true, every proposal for this tenant is denied (KILL_SWITCH_ACTIVE).';

CREATE TABLE api_keys (
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id    external_id NOT NULL,
  prefix       text        NOT NULL,
  key_hash     bytea       NOT NULL,
  label        text        NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  CONSTRAINT pk_api_keys PRIMARY KEY (id),
  CONSTRAINT fk_api_keys_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id),
  CONSTRAINT uq_api_keys_prefix UNIQUE (prefix),
  CONSTRAINT ck_api_keys_prefix CHECK (prefix ~ '^ar_(live|test)_[A-Za-z0-9]{8}$'),
  CONSTRAINT ck_api_keys_hash CHECK (octet_length(key_hash) = 32),
  CONSTRAINT ck_api_keys_label CHECK (length(label) <= 100),
  CONSTRAINT ck_api_keys_expiry CHECK (expires_at IS NULL OR expires_at > created_at)
);
CREATE INDEX ix_api_keys_tenant ON api_keys (tenant_id);
COMMENT ON TABLE api_keys IS 'Tenant API keys. Only a SHA-256 hash is stored; the full key is shown once at creation.';
COMMENT ON COLUMN api_keys.prefix IS 'Non-secret lookup prefix, e.g. ar_live_ab12cd34.';

CREATE TABLE operators (
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id    external_id,
  email        text        NOT NULL,
  display_name text        NOT NULL,
  role         text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  disabled_at  timestamptz,
  CONSTRAINT pk_operators PRIMARY KEY (id),
  CONSTRAINT fk_operators_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id),
  CONSTRAINT uq_operators_email UNIQUE (email),
  CONSTRAINT ck_operators_email CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  CONSTRAINT ck_operators_role CHECK (role IN ('operator', 'admin')),
  CONSTRAINT ck_operators_scope CHECK (role = 'admin' OR tenant_id IS NOT NULL)
);
CREATE INDEX ix_operators_tenant ON operators (tenant_id);
COMMENT ON TABLE operators IS 'Humans who approve or reject actions. tenant_id NULL is only allowed for platform admins.';

-- ─── Simulated CRM / billing (system of record for context binding) ─────────

CREATE TABLE customers (
  tenant_id    external_id NOT NULL,
  id           external_id NOT NULL,
  display_name text        NOT NULL,
  email        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_customers PRIMARY KEY (tenant_id, id),
  CONSTRAINT fk_customers_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id),
  CONSTRAINT ck_customers_display_name CHECK (length(display_name) BETWEEN 1 AND 200)
);

CREATE TABLE subscriptions (
  tenant_id          external_id   NOT NULL,
  id                 external_id   NOT NULL,
  customer_id        external_id   NOT NULL,
  plan               text          NOT NULL,
  currency           currency_code NOT NULL,
  status             text          NOT NULL DEFAULT 'active',
  current_period_end timestamptz,
  created_at         timestamptz   NOT NULL DEFAULT now(),
  updated_at         timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT pk_subscriptions PRIMARY KEY (tenant_id, id),
  CONSTRAINT uq_subscriptions_customer UNIQUE (tenant_id, customer_id, id),
  CONSTRAINT fk_subscriptions_customer FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  CONSTRAINT ck_subscriptions_plan CHECK (plan ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT ck_subscriptions_status CHECK (status IN ('active', 'past_due', 'cancelled'))
);

CREATE TABLE cases (
  tenant_id       external_id NOT NULL,
  id              external_id NOT NULL,
  customer_id     external_id NOT NULL,
  subscription_id external_id,
  subject         text        NOT NULL,
  status          text        NOT NULL DEFAULT 'open',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_cases PRIMARY KEY (tenant_id, id),
  CONSTRAINT uq_cases_customer UNIQUE (tenant_id, customer_id, id),
  CONSTRAINT fk_cases_customer FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  -- The subscription must belong to the same customer as the case.
  CONSTRAINT fk_cases_subscription FOREIGN KEY (tenant_id, customer_id, subscription_id)
    REFERENCES subscriptions (tenant_id, customer_id, id),
  CONSTRAINT ck_cases_subject CHECK (length(subject) BETWEEN 1 AND 500),
  CONSTRAINT ck_cases_status CHECK (status IN ('open', 'pending', 'resolved', 'closed'))
);
CREATE INDEX ix_cases_subscription ON cases (tenant_id, customer_id, subscription_id);
COMMENT ON TABLE cases IS 'Support cases. The policy engine binds tool arguments to these server-side facts.';

-- ─── Policies ───────────────────────────────────────────────────────────────

CREATE TABLE policies (
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id    external_id,
  policy_key   text        NOT NULL,
  version      text        NOT NULL,
  source       text        NOT NULL,
  checksum     sha256_hex  NOT NULL,
  is_active    boolean     NOT NULL DEFAULT false,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  CONSTRAINT pk_policies PRIMARY KEY (id),
  CONSTRAINT fk_policies_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id),
  CONSTRAINT fk_policies_created_by FOREIGN KEY (created_by) REFERENCES operators (id),
  CONSTRAINT uq_policies_version UNIQUE NULLS NOT DISTINCT (tenant_id, policy_key, version),
  CONSTRAINT ck_policies_key CHECK (policy_key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  CONSTRAINT ck_policies_version CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  CONSTRAINT ck_policies_source_size CHECK (octet_length(source) <= 262144),
  CONSTRAINT ck_policies_activation CHECK (NOT is_active OR activated_at IS NOT NULL)
);
-- At most one active version per (tenant, policy); NULL tenant = global policy.
CREATE UNIQUE INDEX uq_policies_active ON policies (tenant_id, policy_key) NULLS NOT DISTINCT WHERE is_active;
CREATE INDEX ix_policies_created_by ON policies (created_by);
COMMENT ON TABLE policies IS 'Versioned policy sources. Content is immutable once stored; only activation changes.';
COMMENT ON COLUMN policies.tenant_id IS 'NULL means the global ("*") policy.';

CREATE FUNCTION protect_policy_content() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF (NEW.tenant_id, NEW.policy_key, NEW.version, NEW.source, NEW.checksum, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.policy_key, OLD.version, OLD.source, OLD.checksum, OLD.created_at) THEN
    RAISE EXCEPTION 'policy content is immutable; create a new version instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tr_policies_immutable BEFORE UPDATE ON policies
  FOR EACH ROW EXECUTE FUNCTION protect_policy_content();
CREATE TRIGGER tr_policies_no_delete BEFORE DELETE ON policies
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();

-- ─── Actions and their lifecycle ────────────────────────────────────────────

-- Legal state transitions; mirrors ACTION_TRANSITIONS in @agentroute/contracts (drift-tested).
CREATE TABLE action_state_transitions (
  from_state text NOT NULL,
  to_state   text NOT NULL,
  CONSTRAINT pk_action_state_transitions PRIMARY KEY (from_state, to_state)
);
INSERT INTO action_state_transitions (from_state, to_state) VALUES
  ('proposed', 'denied'),
  ('proposed', 'allowed'),
  ('proposed', 'approval_required'),
  ('allowed', 'executing'),
  ('approval_required', 'approved'),
  ('approval_required', 'rejected'),
  ('approval_required', 'expired'),
  ('approval_required', 'cancelled'),
  ('approved', 'executing'),
  ('executing', 'succeeded'),
  ('executing', 'failed'),
  ('failed', 'executing');

CREATE TABLE actions (
  id              uuid          NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       external_id   NOT NULL,
  case_id         external_id   NOT NULL,
  customer_id     external_id   NOT NULL,
  agent_id        external_id   NOT NULL,
  tool            text          NOT NULL,
  args            jsonb         NOT NULL,
  amount_minor    amount_minor,
  currency        currency_code,
  state           text          NOT NULL,
  idempotency_key text          NOT NULL,
  request_hash    sha256_hex    NOT NULL,
  version         integer       NOT NULL DEFAULT 1,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT pk_actions PRIMARY KEY (id),
  CONSTRAINT uq_actions_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_actions_idempotency UNIQUE (tenant_id, idempotency_key),
  -- customer_id is denormalised for usage queries; this FK guarantees it matches the case.
  CONSTRAINT fk_actions_case FOREIGN KEY (tenant_id, customer_id, case_id)
    REFERENCES cases (tenant_id, customer_id, id),
  CONSTRAINT ck_actions_tool CHECK (tool ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT ck_actions_args CHECK (jsonb_typeof(args) = 'object' AND pg_column_size(args) <= 65536),
  CONSTRAINT ck_actions_money CHECK ((amount_minor IS NULL) = (currency IS NULL)),
  CONSTRAINT ck_actions_state CHECK (state IN (
    'proposed', 'denied', 'allowed', 'approval_required', 'approved', 'rejected',
    'expired', 'cancelled', 'executing', 'succeeded', 'failed'
  )),
  CONSTRAINT ck_actions_idempotency_key CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  CONSTRAINT ck_actions_version CHECK (version > 0)
);
CREATE INDEX ix_actions_case ON actions (tenant_id, customer_id, case_id);
CREATE INDEX ix_actions_state ON actions (tenant_id, state, created_at);
-- Serves aggregate-limit queries (refund totals/counts per case or customer in a window).
CREATE INDEX ix_actions_usage ON actions (tenant_id, customer_id, tool, created_at)
  INCLUDE (case_id, amount_minor)
  WHERE state IN ('allowed', 'approval_required', 'approved', 'executing', 'succeeded', 'failed');
COMMENT ON TABLE actions IS 'Every tool proposal and its lifecycle. Business fields are immutable after insert.';
COMMENT ON COLUMN actions.request_hash IS 'SHA-256 of the canonical request; a reused idempotency key with a different hash is IDEMPOTENCY_CONFLICT.';
COMMENT ON COLUMN actions.version IS 'Optimistic-concurrency counter, incremented by trigger on every update.';

CREATE FUNCTION guard_action_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state NOT IN ('proposed', 'denied', 'allowed', 'approval_required') THEN
      RAISE EXCEPTION 'actions must be created in a decision state, not %', NEW.state
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- What was decided is what gets executed: business fields never change.
  IF (NEW.id, NEW.tenant_id, NEW.case_id, NEW.customer_id, NEW.agent_id, NEW.tool, NEW.args,
      NEW.amount_minor, NEW.currency, NEW.idempotency_key, NEW.request_hash, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.case_id, OLD.customer_id, OLD.agent_id, OLD.tool, OLD.args,
      OLD.amount_minor, OLD.currency, OLD.idempotency_key, OLD.request_hash, OLD.created_at) THEN
    RAISE EXCEPTION 'action % business fields are immutable', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state AND NOT EXISTS (
    SELECT 1 FROM action_state_transitions t
    WHERE t.from_state = OLD.state AND t.to_state = NEW.state
  ) THEN
    RAISE EXCEPTION 'illegal action state transition % -> %', OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER tr_actions_guard BEFORE INSERT OR UPDATE ON actions
  FOR EACH ROW EXECUTE FUNCTION guard_action_update();
CREATE TRIGGER tr_actions_no_delete BEFORE DELETE ON actions
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();

CREATE TABLE decisions (
  tenant_id       external_id NOT NULL,
  action_id       uuid        NOT NULL,
  effect          text        NOT NULL,
  reasons         jsonb       NOT NULL,
  matched_rules   text[]      NOT NULL DEFAULT '{}',
  policy_id       uuid,
  policy_key      text,
  policy_version  text,
  policy_checksum sha256_hex,
  evaluated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_decisions PRIMARY KEY (tenant_id, action_id),
  CONSTRAINT fk_decisions_action FOREIGN KEY (tenant_id, action_id) REFERENCES actions (tenant_id, id),
  CONSTRAINT fk_decisions_policy FOREIGN KEY (policy_id) REFERENCES policies (id),
  CONSTRAINT ck_decisions_effect CHECK (effect IN ('allow', 'deny', 'approval_required')),
  CONSTRAINT ck_decisions_reasons CHECK (jsonb_typeof(reasons) = 'array' AND jsonb_array_length(reasons) > 0),
  -- Only a deny may be issued without a policy (no policy resolved = default deny).
  CONSTRAINT ck_decisions_policy CHECK (
    (policy_id IS NOT NULL AND policy_key IS NOT NULL AND policy_version IS NOT NULL AND policy_checksum IS NOT NULL)
    OR effect = 'deny'
  )
);
CREATE INDEX ix_decisions_policy ON decisions (policy_id);
CREATE TRIGGER tr_decisions_append_only BEFORE UPDATE OR DELETE ON decisions
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();
COMMENT ON TABLE decisions IS 'The policy decision for each action, with a snapshot of the policy version. Append-only.';

CREATE TABLE approvals (
  tenant_id     external_id NOT NULL,
  action_id     uuid        NOT NULL,
  status        text        NOT NULL DEFAULT 'pending',
  requested_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  decided_by    uuid,
  decided_at    timestamptz,
  decision_note text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_approvals PRIMARY KEY (tenant_id, action_id),
  CONSTRAINT fk_approvals_action FOREIGN KEY (tenant_id, action_id) REFERENCES actions (tenant_id, id),
  CONSTRAINT fk_approvals_decided_by FOREIGN KEY (decided_by) REFERENCES operators (id),
  CONSTRAINT ck_approvals_status CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
  CONSTRAINT ck_approvals_expiry CHECK (expires_at > requested_at),
  CONSTRAINT ck_approvals_decided CHECK ((status = 'pending') = (decided_at IS NULL)),
  CONSTRAINT ck_approvals_decider CHECK (status NOT IN ('approved', 'rejected') OR decided_by IS NOT NULL),
  CONSTRAINT ck_approvals_note CHECK (decision_note IS NULL OR length(decision_note) <= 1000)
);
CREATE INDEX ix_approvals_queue ON approvals (tenant_id, requested_at) WHERE status = 'pending';
CREATE INDEX ix_approvals_expiry ON approvals (expires_at) WHERE status = 'pending';
CREATE INDEX ix_approvals_decided_by ON approvals (decided_by);
CREATE TRIGGER tr_approvals_updated_at BEFORE UPDATE ON approvals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
COMMENT ON TABLE approvals IS 'Human approval requests for actions decided approval_required.';

CREATE TABLE executions (
  id                       uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id                external_id NOT NULL,
  action_id                uuid        NOT NULL,
  attempt                  smallint    NOT NULL,
  status                   text        NOT NULL DEFAULT 'started',
  provider                 text        NOT NULL,
  provider_idempotency_key text        NOT NULL,
  provider_ref             text,
  error_code               text,
  error_message            text,
  started_at               timestamptz NOT NULL DEFAULT now(),
  finished_at              timestamptz,
  CONSTRAINT pk_executions PRIMARY KEY (id),
  CONSTRAINT fk_executions_action FOREIGN KEY (tenant_id, action_id) REFERENCES actions (tenant_id, id),
  CONSTRAINT uq_executions_attempt UNIQUE (action_id, attempt),
  CONSTRAINT ck_executions_attempt CHECK (attempt BETWEEN 1 AND 10),
  -- 'unknown' = the provider call timed out and its outcome is not known. The action
  -- must be reconciled against the provider before any retry: even with provider
  -- idempotency keys (Stripe), keys expire and not every provider supports them.
  CONSTRAINT ck_executions_status CHECK (status IN ('started', 'succeeded', 'failed', 'unknown')),
  CONSTRAINT ck_executions_provider CHECK (provider IN ('stripe', 'mock_crm')),
  CONSTRAINT ck_executions_finished CHECK ((status = 'started') = (finished_at IS NULL)),
  CONSTRAINT ck_executions_success_ref CHECK (status <> 'succeeded' OR provider_ref IS NOT NULL),
  CONSTRAINT ck_executions_error CHECK (error_message IS NULL OR length(error_message) <= 2000)
);
-- The core money guarantee: an action can succeed at most once.
CREATE UNIQUE INDEX uq_executions_one_success ON executions (action_id) WHERE status = 'succeeded';
CREATE INDEX ix_executions_action ON executions (tenant_id, action_id);
-- At most one attempt may be in flight or unresolved per action.
CREATE UNIQUE INDEX uq_executions_one_open ON executions (action_id) WHERE status IN ('started', 'unknown');
COMMENT ON TABLE executions IS 'Attempts to perform an action downstream. An unknown outcome blocks retries until reconciled.';
COMMENT ON COLUMN executions.provider_idempotency_key IS 'Our key for the attempt; sent to providers that support it, and used to match provider records during reconciliation.';

-- ─── Events ─────────────────────────────────────────────────────────────────

CREATE TABLE outbox (
  id               bigint      GENERATED ALWAYS AS IDENTITY,
  event_id         uuid        NOT NULL,
  tenant_id        external_id NOT NULL,
  action_id        uuid,
  event_type       text        NOT NULL,
  payload          jsonb       NOT NULL,
  trace_id         text,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  published_at     timestamptz,
  publish_attempts integer     NOT NULL DEFAULT 0,
  CONSTRAINT pk_outbox PRIMARY KEY (id),
  CONSTRAINT uq_outbox_event UNIQUE (event_id),
  CONSTRAINT fk_outbox_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id),
  CONSTRAINT ck_outbox_event_type CHECK (event_type IN (
    'action.proposed', 'decision.made', 'approval.requested', 'approval.decided',
    'action.executing', 'action.succeeded', 'action.failed', 'action.expired'
  )),
  CONSTRAINT ck_outbox_payload CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT ck_outbox_attempts CHECK (publish_attempts >= 0)
);
CREATE INDEX ix_outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
CREATE INDEX ix_outbox_tenant ON outbox (tenant_id);
COMMENT ON TABLE outbox IS 'Transactional outbox: written in the same transaction as the state change, relayed to Redis Streams.';

CREATE TABLE audit_log (
  event_id    uuid        NOT NULL,
  tenant_id   external_id NOT NULL,
  action_id   uuid,
  event_type  text        NOT NULL,
  payload     jsonb       NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_audit_log PRIMARY KEY (event_id),
  CONSTRAINT fk_audit_log_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id),
  CONSTRAINT ck_audit_log_payload CHECK (jsonb_typeof(payload) = 'object')
);
CREATE INDEX ix_audit_log_tenant_time ON audit_log (tenant_id, occurred_at);
CREATE INDEX ix_audit_log_action ON audit_log (action_id) WHERE action_id IS NOT NULL;
CREATE TRIGGER tr_audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();
CREATE TRIGGER tr_audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_modification();
COMMENT ON TABLE audit_log IS 'Durable, append-only audit trail populated by the audit consumer. Payloads are PII-redacted.';

CREATE TABLE processed_events (
  consumer     text        NOT NULL,
  event_id     uuid        NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_processed_events PRIMARY KEY (consumer, event_id),
  CONSTRAINT ck_processed_events_consumer CHECK (consumer ~ '^[a-z][a-z0-9_-]{0,63}$')
);
COMMENT ON TABLE processed_events IS 'Consumer dedupe ledger: inserting a duplicate (consumer, event_id) means already handled.';

CREATE TABLE dead_letters (
  id          bigint      GENERATED ALWAYS AS IDENTITY,
  consumer    text        NOT NULL,
  stream_id   text        NOT NULL,
  event_id    uuid,
  payload     jsonb       NOT NULL,
  error       text        NOT NULL,
  attempts    integer     NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  replayed_at timestamptz,
  CONSTRAINT pk_dead_letters PRIMARY KEY (id),
  CONSTRAINT ck_dead_letters_attempts CHECK (attempts > 0),
  CONSTRAINT ck_dead_letters_error CHECK (length(error) <= 4000)
);
CREATE INDEX ix_dead_letters_pending ON dead_letters (consumer, created_at) WHERE replayed_at IS NULL;
COMMENT ON TABLE dead_letters IS 'Messages that exhausted retries; replayed manually after a fix.';

-- ─── updated_at maintenance ─────────────────────────────────────────────────

CREATE TRIGGER tr_tenants_updated_at BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tr_operators_updated_at BEFORE UPDATE ON operators
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tr_customers_updated_at BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tr_subscriptions_updated_at BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tr_cases_updated_at BEFORE UPDATE ON cases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
