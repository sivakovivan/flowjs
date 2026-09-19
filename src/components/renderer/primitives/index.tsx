'use client';

import type { ClientCapability } from '@flowjs/core/client/api';
import type { UIComponent } from '@flowjs/core/flow/schema';
import {
    ActionButton,
    ActionButtonGroup,
    Dropdown,
    OptionButtons,
    SearchField,
} from './controls';
import { List, MetricCard, Table, TimeseriesChart } from './data';

/** Dispatch a schema component to its primitive, bound to its capability. */
export function Primitive({
    component,
    capability,
}: {
    component: UIComponent;
    capability: ClientCapability;
}) {
    if (capability.kind === 'data') {
        switch (component.primitive) {
            case 'metric-card':
                return (
                    <MetricCard component={component} capability={capability} />
                );
            case 'line-chart':
                return (
                    <TimeseriesChart
                        component={component}
                        capability={capability}
                        kind="line"
                    />
                );
            case 'bar-chart':
                return (
                    <TimeseriesChart
                        component={component}
                        capability={capability}
                        kind="bar"
                    />
                );
            case 'table':
                return <Table component={component} capability={capability} />;
            case 'list':
                return <List component={component} capability={capability} />;
        }
    }
    if (capability.kind === 'state') {
        switch (component.primitive) {
            case 'dropdown':
                return (
                    <Dropdown component={component} capability={capability} />
                );
            case 'segmented-control':
                return (
                    <OptionButtons
                        component={component}
                        capability={capability}
                        segmented
                    />
                );
            case 'button-group':
                return (
                    <OptionButtons
                        component={component}
                        capability={capability}
                        segmented={false}
                    />
                );
            case 'search-field':
                return (
                    <SearchField
                        component={component}
                        capability={capability}
                    />
                );
        }
    }
    if (capability.kind === 'action') {
        switch (component.primitive) {
            case 'button':
                return (
                    <ActionButton
                        component={component}
                        capability={capability}
                    />
                );
            case 'button-group':
                return (
                    <ActionButtonGroup
                        component={component}
                        capability={capability}
                    />
                );
        }
    }
    // The server validates compatibility; this only guards against a stale client.
    return (
        <p className="app-status app-status--error">
            Unsupported primitive “{component.primitive}”.
        </p>
    );
}
