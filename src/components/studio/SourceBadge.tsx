/** Makes it impossible to mistake a recorded AI response for a live one. */
export function SourceBadge(props: {
    source: 'live' | 'recorded';
    model: string;
    fallbackReason: string | null;
}) {
    if (props.source === 'live') {
        return (
            <span className="source source--live">
                Live OpenAI ({props.model})
            </span>
        );
    }
    return (
        <span
            className="source source--recorded"
            title={props.fallbackReason ?? undefined}
        >
            Recorded response
            {props.fallbackReason && (
                <span className="source__reason">{props.fallbackReason}</span>
            )}
        </span>
    );
}
