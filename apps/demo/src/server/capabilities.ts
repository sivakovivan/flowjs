import {
    CallContext,
    ActionRequest,
    runCapability as executeCapability,
} from '@flowjs/core/server/capabilities';
import { getRuntime } from './flow';

export { CallContext, ActionRequest };

export function runCapability(
    kind: 'data' | 'action',
    capabilityId: string,
    context: Parameters<typeof executeCapability>[3]
) {
    return executeCapability(getRuntime(), kind, capabilityId, context);
}
