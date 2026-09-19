'use client';

import { useEffect, useRef, useState } from 'react';

export function CustomizationChat(props: {
    generating: boolean;
    onCustomize: (prompt: string) => Promise<void>;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [prompt, setPrompt] = useState('');
    const [sent, setSent] = useState<string | null>(null);
    async function submit() {
        if (!prompt.trim() || props.generating) return;
        const request = prompt.trim();
        setSent(request);
        await props.onCustomize(request);
        setPrompt('');
    }
    useEffect(() => {
        if (!open) return;
        const close = (event: MouseEvent) => {
            if (ref.current && !ref.current.contains(event.target as Node))
                setOpen(false);
        };
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
    }, [open]);
    return (
        <div className="chat-anchor" ref={ref}>
            <button
                type="button"
                className="chat-button"
                onClick={() => setOpen((value) => !value)}
                aria-expanded={open}
            >
                ✦ Customize
            </button>
            {open && (
                <section
                    className="chat-popover"
                    aria-label="Customize your dashboard"
                >
                    <p className="chat-popover__title">
                        Make this dashboard yours
                    </p>
                    <p className="muted">
                        Tell the flow.js agent what you would like to change.
                    </p>
                    {sent && (
                        <p className="chat-message">
                            <strong>You:</strong> {sent}
                            <br />
                            I’ll use that direction for the next dashboard
                            iteration.
                        </p>
                    )}
                    <textarea
                        value={prompt}
                        onChange={(event) => {
                            setPrompt(event.target.value);
                            setSent(null);
                        }}
                        placeholder="e.g. Make the revenue card more prominent"
                        rows={3}
                    />
                    <button
                        type="button"
                        className="chrome-button chrome-button--signal"
                        onClick={submit}
                        disabled={!prompt.trim() || props.generating}
                    >
                        {props.generating ? 'Iterating…' : 'Apply direction'}
                    </button>
                </section>
            )}
        </div>
    );
}
