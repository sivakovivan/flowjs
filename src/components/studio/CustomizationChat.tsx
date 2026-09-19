'use client';

import { useState } from 'react';

export function CustomizationChat(props: {
    generating: boolean;
    onCustomize: () => Promise<void>;
}) {
    const [open, setOpen] = useState(false);
    const [prompt, setPrompt] = useState('');
    const [sent, setSent] = useState(false);
    async function submit() {
        if (!prompt.trim() || props.generating) return;
        setSent(true);
        await props.onCustomize();
        setPrompt('');
    }
    return (
        <div className="chat-anchor">
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
                            I’ll use that direction for the next dashboard
                            iteration.
                        </p>
                    )}
                    <textarea
                        value={prompt}
                        onChange={(event) => {
                            setPrompt(event.target.value);
                            setSent(false);
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
