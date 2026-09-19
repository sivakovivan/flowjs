import type { AIProvenance } from "@/client/api";

const VENDOR_LABEL: Record<string, string> = { backboard: "BackBoard", openai: "OpenAI" };

/** Makes it impossible to mistake a recorded AI response for a live one. */
export function SourceBadge({ source, model, fallbackReason, call }: Pick<AIProvenance, "source" | "model" | "fallbackReason"> & { call?: AIProvenance["call"] }) {
  if (source === "recorded") {
    return (
      <span className="source source--recorded" title={fallbackReason ?? undefined}>
        Recorded response
        {fallbackReason && <span className="source__reason">{fallbackReason}</span>}
      </span>
    );
  }
  const vendor = call ? (VENDOR_LABEL[call.vendor] ?? call.vendor) : "OpenAI";
  return (
    <span className="source source--live">
      Live {vendor} ({model})
      {call && (
        <span className="source__reason">
          Routed to the {call.tier} tier: {call.routeReason}.{" "}
          {call.attempts === 1 ? "Valid on the first reply" : `${call.attempts} calls, ${call.repairs} repaired`}
          {call.escalated && ", escalated"}; {call.inputTokens + call.outputTokens} tokens in {(call.latencyMs / 1000).toFixed(1)}s.
        </span>
      )}
    </span>
  );
}
