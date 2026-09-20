'use client';

import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { useEffect, useRef } from 'react';
import type { ClientCapability } from '@flowjs/core/client/api';
import { tracker } from '@flowjs/core/client/telemetry';
import { SIZE_SPAN } from '@flowjs/core/flow/primitives';
import type {
    ComponentChange,
    UIComponent,
    UISchema,
} from '@flowjs/core/flow/schema';
import { useRenderer } from './context';
import { Primitive } from './primitives';
import { Card, CardHeader, CardContent } from '../ui/card';

const MotionCard = motion.create(Card);
const MotionCardHeader = motion.create(CardHeader);
const MotionCardContent = motion.create(CardContent);

const LAYOUT_TRANSITION = {
    type: 'spring',
    stiffness: 105,
    damping: 19,
    mass: 1.05,
} as const;

const CHANGE_LABEL: Record<ComponentChange, string> = {
    moved: 'Moved',
    resized: 'Resized',
    swapped: 'New control',
    shown: 'Shown',
    hidden: 'Hidden',
};

function ComponentFrame(props: {
    component: UIComponent;
    capability: ClientCapability;
    changes: ComponentChange[] | undefined;
}) {
    const { component, capability, changes } = props;
    const ref = useRef<HTMLDivElement>(null);
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
        <MotionCard
            role="region"
            ref={ref}
            layout
            layoutId={component.id}
            transition={LAYOUT_TRANSITION}
            className={`app-card app-card--${capability.kind} app-card--${component.primitive} ${changes ? 'is-changed' : ''}`}
            style={{ gridColumn: `span ${SIZE_SPAN[component.size]}` }}
            data-component={component.id}
            data-changing={changes ? changes.join(' ') : undefined}
            aria-label={capability.label}
            onPointerEnter={() =>
                tracker.track(component.id, 'component_hover')
            }
            onFocusCapture={() =>
                tracker.track(component.id, 'component_focus')
            }
            onPointerDown={(event) => {
                const target = event.target as HTMLElement;
                if (target.closest(':disabled, [aria-disabled="true"]'))
                    tracker.track(component.id, 'disabled_interaction', {
                        element: target.tagName.toLowerCase(),
                    });
            }}
            onWheel={(event) =>
                tracker.track(component.id, 'component_scroll', {
                    direction: event.deltaY > 0 ? 'forward' : 'backward',
                })
            }
        >
            <MotionCardHeader
                layout="position"
                className="flex flex-row flex-wrap items-center gap-2"
            >
                <h2
                    className={
                        isControl
                            ? 'm-0 mr-auto text-sm font-medium text-muted-foreground'
                            : 'm-0 mr-auto text-sm font-semibold'
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
            </MotionCardHeader>
            <AnimatePresence mode="popLayout" initial={false}>
                <MotionCardContent
                    key={component.primitive}
                    className="app-card__body"
                    initial={{ opacity: 0, scale: 0.96 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.96 }}
                    transition={{ duration: 0.28 }}
                >
                    <Primitive component={component} capability={capability} />
                </MotionCardContent>
            </AnimatePresence>
        </MotionCard>
    );
}

export function Dashboard(props: {
    schema: UISchema;
    changes: Record<string, ComponentChange[]>;
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
                            changes={props.changes[component.id]}
                        />
                    );
                })}
            </div>
        </LayoutGroup>
    );
}
