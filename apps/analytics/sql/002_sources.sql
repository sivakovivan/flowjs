CREATE TABLE flow_analytics.sources (
    source_id UUID NOT NULL,
    application_id TEXT NOT NULL,
    sample_kind TEXT NOT NULL CHECK (sample_kind IN ('live', 'simulated')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source_id, application_id)
);

INSERT INTO flow_analytics.sources (source_id, application_id, sample_kind)
SELECT source_id, application_id, 'live' FROM flow_analytics.events
UNION
SELECT source_id, application_id, 'live' FROM flow_analytics.calls;