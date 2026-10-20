import type { ReactNode } from "react";

/**
 * Field — simple labelled form group used throughout the Settings panel.
 *
 * Extracted from App.tsx so non-`App` components (notably
 * `NerSection`) can compose the same visual rhythm without
 * redefining the wrapper. The previous inline definition inside
 * SettingsPanel kept the markup private to that file; this move
 * keeps that visual contract while letting sibling cards (NER,
 * BGE) share it.
 */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
      {label}
      {children}
    </label>
  );
}
