"use client";

import type { StudioState } from "@/client/api";

/** Stage 1: show what the developer wrote, which contains no layout, then generate v1. */
export function GeneratePrompt(props: { studio: StudioState; generating: boolean; error: string | null; onGenerate: () => void }) {
  const { studio } = props;
  const willUseRecording = studio.ai.forcedRecorded || !studio.ai.liveConfigured;
  return (
    <div className="generate">
      <div className="generate__intro">
        <h1>No dashboard layout was written.</h1>
        <p>
          The developer registered {studio.capabilities.length} capabilities for {studio.application.name}: data, actions and
          state, each with a description and a contract. flow.js asks{" "}
          {studio.ai.vendor === "backboard" ? "a model routed through BackBoard" : "OpenAI"} to turn them into a first
          interface, validates the result, and saves it as v1.
        </p>
        <button type="button" className="chrome-button chrome-button--signal chrome-button--large" onClick={props.onGenerate} disabled={props.generating}>
          {props.generating ? "Generating v1…" : "Generate dashboard"}
        </button>
        {willUseRecording && (
          <p className="muted">
            {studio.ai.forcedRecorded
              ? "Recorded mode is on: a recorded, validated response will be used and labelled."
              : "No AI key is set: a recorded, validated response will be used and labelled."}
          </p>
        )}
        {props.error && (
          <p className="error" role="alert">
            {props.error}
          </p>
        )}
      </div>
      {studio.registration && (
        <figure className="generate__code">
          <figcaption>src/demo/sales-app.ts</figcaption>
          <pre>
            <code>{studio.registration.slice(studio.registration.indexOf("export const"))}</code>
          </pre>
        </figure>
      )}
    </div>
  );
}
