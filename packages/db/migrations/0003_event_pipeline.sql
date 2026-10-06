-- 0003: event pipeline support. Additive only (expand phase).

-- Wake the outbox relay immediately on new events instead of waiting for its
-- next poll. Statement-level, so a multi-row insert sends one notification.
-- Polling remains the fallback: NOTIFY is best-effort and not durable.
CREATE FUNCTION notify_outbox() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM pg_notify('agentroute_outbox', '');
  RETURN NULL;
END;
$$;

CREATE TRIGGER tr_outbox_notify AFTER INSERT ON outbox
  FOR EACH STATEMENT EXECUTE FUNCTION notify_outbox();

-- Correlate audit records with the request that caused them.
ALTER TABLE audit_log ADD COLUMN trace_id text;
CREATE INDEX ix_audit_log_trace ON audit_log (trace_id) WHERE trace_id IS NOT NULL;

-- Per-tenant daily counters maintained by the stats consumer.
CREATE TABLE daily_action_stats (
  tenant_id  external_id NOT NULL,
  day        date        NOT NULL,
  tool       text        NOT NULL,
  metric     text        NOT NULL,
  value      bigint      NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_daily_action_stats PRIMARY KEY (tenant_id, day, tool, metric),
  CONSTRAINT fk_daily_action_stats_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id),
  CONSTRAINT ck_daily_action_stats_tool CHECK (tool ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT ck_daily_action_stats_metric CHECK (metric ~ '^[a-z][a-z0-9_]{0,63}$')
);
COMMENT ON TABLE daily_action_stats IS
  'Daily counters per tenant/tool (decisions by effect, executions, refunded amounts). Updated idempotently by the stats consumer.';
