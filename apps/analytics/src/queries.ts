export const INGEST = `
WITH incoming AS (
    SELECT (value->>'id')::uuid AS id, (value->>'sourceId')::uuid AS source_id,
        value->>'applicationId' AS application_id, value->>'kind' AS kind, value->'payload' AS payload
    FROM jsonb_array_elements($1::jsonb)
), accepted AS (
    INSERT INTO flow_analytics.receipts (source_id, id)
    SELECT source_id, id FROM incoming ON CONFLICT DO NOTHING RETURNING source_id, id
), events AS (
    INSERT INTO flow_analytics.events (
        occurred_at, source_id, id, application_id, version_id, session_id, user_id,
        component_id, capability_id, event_type, track, since_load_ms, active_ms, path, viewport)
    SELECT to_timestamp((payload->>'occurredAt')::double precision / 1000),
        incoming.source_id, incoming.id, application_id, payload->>'versionId',
        payload->>'sessionId', payload->>'userId', payload->>'componentId', payload->>'capabilityId',
        payload->>'eventType', payload->>'track', (payload->>'sinceLoadMs')::double precision,
        (payload->>'activeMs')::integer, ARRAY(SELECT jsonb_array_elements_text(payload->'path')),
        payload->>'viewport'
    FROM incoming JOIN accepted USING (source_id, id) WHERE kind = 'event' RETURNING id
), calls AS (
    INSERT INTO flow_analytics.calls (
        occurred_at, source_id, id, application_id, version_id, session_id, component_id,
        capability_id, kind, latency_ms, ok, trace_id)
    SELECT to_timestamp((payload->>'occurredAt')::double precision / 1000),
        incoming.source_id, incoming.id, application_id, payload->>'versionId',
        payload->>'sessionId', payload->>'componentId', payload->>'capabilityId', payload->>'kind',
        (payload->>'latencyMs')::double precision, (payload->>'ok')::boolean, payload->>'traceId'
    FROM incoming JOIN accepted USING (source_id, id) WHERE kind = 'call' RETURNING id
)
SELECT (SELECT count(*) FROM events)::integer + (SELECT count(*) FROM calls)::integer AS accepted
`;

export const EVENT_COUNTS = `
SELECT component_id, event_type, sum(event_count)::double precision AS count,
    sum(active_ms)::double precision AS active_ms
FROM flow_analytics.events_minute
WHERE source_id = $1 AND application_id = $2 AND version_id = $3 AND track = 'average'
    AND bucket >= to_timestamp($4::double precision / 1000)
    AND bucket < to_timestamp($5::double precision / 1000)
GROUP BY component_id, event_type
`;

export const SESSION_STATS = `
WITH scoped AS MATERIALIZED (
    SELECT * FROM flow_analytics.events
    WHERE source_id = $1 AND application_id = $2 AND version_id = $3 AND track = 'average'
        AND occurred_at >= to_timestamp($4::double precision / 1000)
        AND occurred_at < to_timestamp($5::double precision / 1000)
), component_sessions AS (
    SELECT component_id, session_id,
        bool_or(event_type IN ('component_click', 'value_change')) AS used,
        bool_or(event_type = 'component_view') AS exposed,
        min(since_load_ms) FILTER (WHERE event_type IN ('component_click', 'value_change', 'interaction_start')) AS discovery,
        min(since_load_ms) FILTER (WHERE event_type = 'component_view') AS first_view
    FROM scoped GROUP BY component_id, session_id
), stats AS (
    SELECT component_id, count(*) FILTER (WHERE used) AS sessions_used,
        count(*) FILTER (WHERE exposed) AS exposed_sessions,
        count(*) FILTER (WHERE exposed AND used) AS used_exposed,
        round(avg(discovery)) AS discovery, round(avg(first_view)) AS first_view
    FROM component_sessions GROUP BY component_id
), interactions AS (
    SELECT *,
        lag(occurred_at) OVER (PARTITION BY session_id, component_id ORDER BY occurred_at, id) AS previous_time,
        lag(component_id) OVER (PARTITION BY session_id ORDER BY occurred_at, id) AS previous_component
    FROM scoped WHERE event_type IN ('component_click', 'value_change')
), repeated AS (
    SELECT * FROM interactions WHERE occurred_at - previous_time <= INTERVAL '30 seconds'
), repeats AS (
    SELECT component_id, count(*) AS count FROM repeated GROUP BY component_id
), transitions AS (
    SELECT previous_component AS "from", component_id AS "to", count(*) AS count
    FROM interactions WHERE previous_component IS NOT NULL AND previous_component != component_id
    GROUP BY previous_component, component_id ORDER BY count DESC, previous_component, component_id LIMIT 100
), retry_latency AS (
    SELECT calls.component_id, percentile_disc(0.5) WITHIN GROUP (ORDER BY calls.latency_ms) AS latency
    FROM flow_analytics.calls AS calls
    WHERE source_id = $1 AND application_id = $2 AND version_id = $3
        AND occurred_at >= to_timestamp($4::double precision / 1000)
        AND occurred_at < to_timestamp($5::double precision / 1000)
        AND EXISTS (SELECT 1 FROM repeated WHERE repeated.session_id = calls.session_id
            AND repeated.component_id = calls.component_id)
    GROUP BY calls.component_id
), navigation AS (
    SELECT path, count(*) FILTER (WHERE event_type = 'menu_open') AS opens,
        count(*) FILTER (WHERE event_type IN ('menu_select', 'tab_select')) AS selections,
        count(*) FILTER (WHERE event_type = 'menu_close') AS dismissals,
        sum(active_ms) AS "activeMs", count(DISTINCT user_id) AS users, count(DISTINCT session_id) AS sessions
    FROM flow_analytics.events WHERE source_id = $1 AND application_id = $2
        AND occurred_at >= to_timestamp($4::double precision / 1000)
        AND occurred_at < to_timestamp($5::double precision / 1000)
        AND component_id = '__navigation__'
    GROUP BY path ORDER BY count(*) DESC LIMIT 100
)
SELECT (SELECT count(DISTINCT session_id) FROM scoped)::integer AS sessions,
    (SELECT count(DISTINCT user_id) FROM scoped)::integer AS users,
    coalesce((SELECT jsonb_agg(stats) FROM stats), '[]'::jsonb) AS components,
    coalesce((SELECT jsonb_agg(repeats) FROM repeats), '[]'::jsonb) AS repeats,
    coalesce((SELECT jsonb_agg(transitions) FROM transitions), '[]'::jsonb) AS transitions,
    coalesce((SELECT jsonb_agg(retry_latency) FROM retry_latency), '[]'::jsonb) AS retry_latency,
    coalesce((SELECT jsonb_agg(navigation) FROM navigation), '[]'::jsonb) AS navigation
`;

export const POPULATION = `
WITH scoped AS MATERIALIZED (
    SELECT user_id, session_id, capability_id, event_type, active_ms
    FROM flow_analytics.events WHERE source_id = $1 AND application_id = $2
        AND occurred_at >= to_timestamp($3::double precision / 1000)
        AND occurred_at < to_timestamp($4::double precision / 1000)
        AND capability_id = ANY($5::text[])
), usage AS (
    SELECT capability_id AS "capabilityId",
        count(DISTINCT user_id) FILTER (WHERE event_type IN ('component_click', 'value_change')) AS users,
        count(DISTINCT session_id) FILTER (WHERE event_type IN ('component_click', 'value_change')) AS sessions,
        count(*) FILTER (WHERE event_type IN ('component_click', 'value_change')) AS interactions,
        sum(active_ms) AS "activeMs"
    FROM scoped
    GROUP BY capability_id ORDER BY interactions DESC, capability_id
)
SELECT (count(DISTINCT user_id) FILTER (WHERE event_type IN ('component_click', 'value_change')))::integer AS users,
    (count(DISTINCT session_id) FILTER (WHERE event_type IN ('component_click', 'value_change')))::integer AS sessions,
    count(*) FILTER (WHERE event_type IN ('component_click', 'value_change'))::integer AS interactions,
    coalesce((SELECT jsonb_agg(usage) FROM usage), '[]'::jsonb) AS usage
FROM scoped
`;

export const LATENCY = `
SELECT capability_id, kind, sum(calls)::integer AS calls,
    sum(errors)::double precision / NULLIF(sum(calls), 0) AS error_rate,
    approx_percentile(0.5, rollup(latency)) AS p50,
    approx_percentile(0.95, rollup(latency)) AS p95
FROM flow_analytics.latency_minute
WHERE source_id = $1 AND application_id = $2
    AND bucket >= to_timestamp($3::double precision / 1000)
    AND bucket < to_timestamp($4::double precision / 1000)
GROUP BY capability_id, kind
`;
