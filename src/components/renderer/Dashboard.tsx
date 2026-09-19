'use client';

import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { useEffect, useRef } from 'react';
import type { ClientCapability } from '@flowjs/core/client/api';
import { tracker } from '@flowjs/core/client/telemetry';
import type { ComponentMetrics } from '@flowjs/core/flow/metrics';
import { SIZE_SPAN } from '@flowjs/core/flow/primitives';
import type {
    ComponentChange,
    UIComponent,
    UISchema,
} from '@flowjs/core/flow/schema';
import { useRenderer } from './context';
import { Primitive } from './primitives';

const LAYOUT_TRANSITION = {
    type: 'spring',
    stiffness: 170,
    damping: 24,
    mass: 0.9,
} as const;

const CHANGE_LABEL: Record<ComponentChange, string> = {
    moved: 'Moved',
    resized: 'Resized',
    swapped: 'New control',
    shown: 'Shown',
    hidden: 'Hidden',
};

function formatSeconds(ms: number | null) {
    return ms === null ? '–' : `${(ms / 1000).toFixed(1)}s`;
}

function TelemetryChip({ metrics }: { metrics: ComponentMetrics }) {
    return (
        <span
            className="telemetry-chip"
            title={`Used in ${Math.round(metrics.usageRate * 100)}% of sessions, found after ${formatSeconds(metrics.avgDiscoveryMs)} on average, ${metrics.interactions} interactions`}
        >
            <span>{Math.round(metrics.usageRate * 100)}%</span>
            <span>{formatSeconds(metrics.avgDiscoveryMs)}</span>
            <span>{metrics.interactions}×</span>
        </span>
    );
}

function ComponentFrame(props: {
    component: UIComponent;
    capability: ClientCapability;
    metrics: ComponentMetrics | undefined;
    changes: ComponentChange[] | undefined;
    showTelemetry: boolean;
}) {
    const { component, capability, metrics, changes } = props;
    const ref = useRef<HTMLElement>(null);
    const { versionId } = useRenderer();

    // component_view fires once per version, when half the component is visible.
    useEffect(() => {
        const node = ref.current;
        if (!node) return;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    tracker.track(component.id, 'component_view');
                    observer.disconnect();
                }
            },
            { threshold: 0.5 }
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, [component.id, versionId]);

    const isControl = capability.kind !== 'data';
    return (
        <motion.section
            ref={ref}
            layout
            layoutId={component.id}
            transition={LAYOUT_TRANSITION}
            className={`app-card app-card--${capability.kind} app-card--${component.primitive} ${changes ? 'is-changed' : ''}`}
            style={{ gridColumn: `span ${SIZE_SPAN[component.size]}` }}
            data-component={component.id}
            aria-label={capability.label}
        >
            <motion.header layout="position" className="app-card__header">
                <h2
                    className={
                        isControl
                            ? 'app-card__title app-card__title--control'
                            : 'app-card__title'
                    }
                >
                    {capability.label}
                </h2>
                {changes && (
                    <span className="change-tag" role="status">
                        {changes
                            .map((change) => CHANGE_LABEL[change])
                            .join(', ')}
                    </span>
                )}
                {props.showTelemetry && metrics && metrics.interactions > 0 && (
                    <TelemetryChip metrics={metrics} />
                )}
            </motion.header>
            <AnimatePresence mode="popLayout" initial={false}>
                <motion.div
                    key={component.primitive}
                    className="app-card__body"
                    initial={{ opacity: 0, scale: 0.96 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.96 }}
                    transition={{ duration: 0.28 }}
                >
                    <Primitive component={component} capability={capability} />
                </motion.div>
            </AnimatePresence>
        </motion.section>
    );
}

export function Dashboard(props: {
    schema: UISchema;
    metrics: Map<string, ComponentMetrics>;
    changes: Record<string, ComponentChange[]>;
    showTelemetry: boolean;
}) {
    const { capabilities } = useRenderer();
    const components = [...props.schema.components]
        .filter((c) => c.visible)
        .sort((a, b) => a.order - b.order);

    return (
        <LayoutGroup>
            <div className="app-grid">
                {components.map((component) => {
                    const capability = capabilities.get(component.capability);
                    if (!capability) return null;
                    return (
                        <ComponentFrame
                            key={component.id}
                            component={component}
                            capability={capability}
                            metrics={props.metrics.get(component.id)}
                            changes={props.changes[component.id]}
                            showTelemetry={props.showTelemetry}
                        />
                    );
                })}
            </div>
        </LayoutGroup>
    );
}
