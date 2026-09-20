CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS timescaledb_toolkit;

CREATE TABLE flow_analytics.receipts (
    source_id UUID NOT NULL,
    id UUID NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source_id, id)
);

CREATE TABLE flow_analytics.events (
    occurred_at TIMESTAMPTZ NOT NULL,
    source_id UUID NOT NULL,
    id UUID NOT NULL,
    application_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    user_id TEXT,
    component_id TEXT NOT NULL,
    capability_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    track TEXT NOT NULL CHECK (track IN ('average', 'personal')),
    since_load_ms DOUBLE PRECISION NOT NULL CHECK (since_load_ms >= 0),
    active_ms INTEGER NOT NULL DEFAULT 0 CHECK (active_ms BETWEEN 0 AND 15000),
    path TEXT[] NOT NULL DEFAULT '{}',
    viewport TEXT NOT NULL CHECK (viewport IN ('compact', 'wide', 'unknown')),
    PRIMARY KEY (source_id, id, occurred_at)
);
SELECT create_hypertable('flow_analytics.events', by_range('occurred_at', INTERVAL '1 day'));
CREATE INDEX events_scope ON flow_analytics.events (source_id, application_id, version_id, occurred_at DESC);
CREATE INDEX events_session ON flow_analytics.events (source_id, application_id, version_id, session_id, occurred_at);

CREATE TABLE flow_analytics.calls (
    occurred_at TIMESTAMPTZ NOT NULL,
    source_id UUID NOT NULL,
    id UUID NOT NULL,
    application_id TEXT NOT NULL,
    version_id TEXT,
    session_id TEXT,
    component_id TEXT,
    capability_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('data', 'action')),
    latency_ms DOUBLE PRECISION NOT NULL CHECK (latency_ms >= 0),
    ok BOOLEAN NOT NULL,
    trace_id TEXT,
    PRIMARY KEY (source_id, id, occurred_at)
);
SELECT create_hypertable('flow_analytics.calls', by_range('occurred_at', INTERVAL '1 day'));
CREATE INDEX calls_scope ON flow_analytics.calls (source_id, application_id, occurred_at DESC);

CREATE MATERIALIZED VIEW flow_analytics.events_minute
WITH (timescaledb.continuous) AS
SELECT time_bucket(INTERVAL '1 minute', occurred_at) AS bucket,
    source_id, application_id, version_id, track, component_id, capability_id, event_type,
    count(*) AS event_count, sum(active_ms) AS active_ms
FROM flow_analytics.events
GROUP BY bucket, source_id, application_id, version_id, track, component_id, capability_id, event_type
WITH NO DATA;
ALTER MATERIALIZED VIEW flow_analytics.events_minute SET (timescaledb.materialized_only = false);
SELECT add_continuous_aggregate_policy('flow_analytics.events_minute',
    start_offset => NULL, end_offset => INTERVAL '5 minutes', schedule_interval => INTERVAL '1 minute');

CREATE MATERIALIZED VIEW flow_analytics.latency_minute
WITH (timescaledb.continuous) AS
SELECT time_bucket(INTERVAL '1 minute', occurred_at) AS bucket,
    source_id, application_id, capability_id, kind,
    count(*) AS calls, count(*) FILTER (WHERE NOT ok) AS errors,
    percentile_agg(latency_ms) AS latency
FROM flow_analytics.calls
GROUP BY bucket, source_id, application_id, capability_id, kind
WITH NO DATA;
ALTER MATERIALIZED VIEW flow_analytics.latency_minute SET (timescaledb.materialized_only = false);
SELECT add_continuous_aggregate_policy('flow_analytics.latency_minute',
    start_offset => NULL, end_offset => INTERVAL '5 minutes', schedule_interval => INTERVAL '1 minute');

CREATE INDEX events_minute_scope ON flow_analytics.events_minute (source_id, application_id, version_id, bucket DESC);
CREATE INDEX latency_minute_scope ON flow_analytics.latency_minute (source_id, application_id, bucket DESC);

ALTER TABLE flow_analytics.events SET (
    timescaledb.enable_columnstore = true,
    timescaledb.segmentby = 'source_id',
    timescaledb.orderby = 'occurred_at DESC'
);
ALTER TABLE flow_analytics.calls SET (
    timescaledb.enable_columnstore = true,
    timescaledb.segmentby = 'source_id',
    timescaledb.orderby = 'occurred_at DESC'
);
CALL add_columnstore_policy('flow_analytics.events', after => INTERVAL '7 days', if_not_exists => true);
CALL add_columnstore_policy('flow_analytics.calls', after => INTERVAL '7 days', if_not_exists => true);