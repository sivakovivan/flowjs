'use client';

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react';
import { api, type ClientCapability } from '@/client/api';
import { replayId, tracker } from '@/client/telemetry';
import type { StateValues } from '@/flow/registry';

/*
 * Shared runtime state for generated components: application state values,
 * row selections, a deduplicated data cache and action execution. Primitives
 * never talk to the server directly.
 */

export interface Notice {
    id: number;
    tone: 'ok' | 'error';
    text: string;
}

interface RendererContextValue {
    versionId: string;
    capabilities: Map<string, ClientCapability>;
    state: StateValues;
    setStateValue: (
        componentId: string,
        stateId: string,
        value: string
    ) => void;
    selection: Record<string, string | null>;
    select: (collectionId: string, rowKey: string | null) => void;
    dataVersion: number;
    fetchData: (capabilityId: string, componentId: string) => Promise<unknown>;
    runAction: (
        capabilityId: string,
        componentId: string,
        input: Record<string, string>
    ) => Promise<unknown>;
    notify: (tone: Notice['tone'], text: string) => void;
}

const RendererContext = createContext<RendererContextValue | null>(null);

export function useRenderer(): RendererContextValue {
    const value = useContext(RendererContext);
    if (!value)
        throw new Error('useRenderer must be used inside <RendererProvider>.');
    return value;
}

function download(filename: string, content: string) {
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
}

export function RendererProvider(props: {
    versionId: string;
    capabilities: ClientCapability[];
    initialState: StateValues;
    notify: (tone: Notice['tone'], text: string) => void;
    children: ReactNode;
}) {
    const { versionId, notify } = props;
    const [state, setState] = useState<StateValues>(props.initialState);
    const [selection, setSelection] = useState<Record<string, string | null>>(
        {}
    );
    const [dataVersion, setDataVersion] = useState(0);
    const cache = useRef(new Map<string, Promise<unknown>>());
    const capabilities = useMemo(
        () => new Map(props.capabilities.map((c) => [c.id, c])),
        [props.capabilities]
    );

    useEffect(() => {
        tracker.setVersion(versionId);
    }, [versionId]);

    const dependencyState = useCallback(
        (capabilityId: string) => {
            const capability = capabilities.get(capabilityId);
            return Object.fromEntries(
                (capability?.dependsOn ?? []).map((id) => [id, state[id] ?? ''])
            );
        },
        [capabilities, state]
    );

    const fetchData = useCallback(
        (capabilityId: string, componentId: string) => {
            const deps = dependencyState(capabilityId);
            const key = `${capabilityId}:${dataVersion}:${JSON.stringify(deps)}`;
            let pending = cache.current.get(key);
            if (!pending) {
                pending = api
                    .data(capabilityId, {
                        state: deps,
                        sessionId: tracker.sessionId,
                        versionId,
                        componentId,
                        replayId: replayId(),
                    })
                    .then((response) => response.value);
                pending.catch(() => cache.current.delete(key));
                cache.current.set(key, pending);
            }
            return pending;
        },
        [dataVersion, dependencyState, versionId]
    );

    const runAction = useCallback(
        async (
            capabilityId: string,
            componentId: string,
            input: Record<string, string>
        ) => {
            tracker.track(componentId, 'interaction_start', { input });
            const started = performance.now();
            try {
                const { value } = await api.action(capabilityId, {
                    input,
                    state: dependencyState(capabilityId),
                    sessionId: tracker.sessionId,
                    versionId,
                    componentId,
                    replayId: replayId(),
                });
                tracker.track(componentId, 'interaction_complete', {
                    latencyMs: Math.round(performance.now() - started),
                });
                const result = value as {
                    message?: string;
                    filename?: string;
                    content?: string;
                };
                if (result.content && result.filename)
                    download(result.filename, result.content);
                notify('ok', result.message ?? 'Done.');
                // Actions change backend state: drop cached data so views refresh.
                cache.current.clear();
                setDataVersion((n) => n + 1);
                return value;
            } catch (error) {
                tracker.track(componentId, 'interaction_error', {
                    latencyMs: Math.round(performance.now() - started),
                });
                notify(
                    'error',
                    error instanceof Error
                        ? error.message
                        : 'The action failed.'
                );
                return null;
            }
        },
        [dependencyState, notify, versionId]
    );

    const setStateValue = useCallback(
        (componentId: string, stateId: string, value: string) => {
            tracker.track(componentId, 'value_change', {
                state: stateId,
                value,
            });
            setState((previous) => ({ ...previous, [stateId]: value }));
        },
        []
    );

    const select = useCallback(
        (collectionId: string, rowKey: string | null) => {
            setSelection((previous) => ({
                ...previous,
                [collectionId]: rowKey,
            }));
        },
        []
    );

    const value = useMemo<RendererContextValue>(
        () => ({
            versionId,
            capabilities,
            state,
            setStateValue,
            selection,
            select,
            dataVersion,
            fetchData,
            runAction,
            notify,
        }),
        [
            versionId,
            capabilities,
            state,
            setStateValue,
            selection,
            select,
            dataVersion,
            fetchData,
            runAction,
            notify,
        ]
    );

    return (
        <RendererContext.Provider value={value}>
            {props.children}
        </RendererContext.Provider>
    );
}

/** Load a data capability for the current state; shared across components bound to it. */
export function useCapabilityData<T>(
    capabilityId: string,
    componentId: string
) {
    const { fetchData } = useRenderer();
    const [result, setResult] = useState<{
        data: T | null;
        error: string | null;
        loading: boolean;
    }>({
        data: null,
        error: null,
        loading: true,
    });

    useEffect(() => {
        let cancelled = false;
        setResult((previous) => ({ ...previous, loading: true }));
        fetchData(capabilityId, componentId).then(
            (data) =>
                !cancelled &&
                setResult({ data: data as T, error: null, loading: false }),
            (error: Error) =>
                !cancelled &&
                setResult({ data: null, error: error.message, loading: false })
        );
        return () => {
            cancelled = true;
        };
    }, [capabilityId, componentId, fetchData]);

    return result;
}
