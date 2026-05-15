"use client";

import { useState } from "react";

interface Props {
  value: string;
  label: string;
}

export default function CopyButton({ value, label }: Props) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback for old browsers / non-secure contexts: select the next
      // <pre> and let the user hit ⌘C themselves.
    }
  }

  return (
    <button type="button" onClick={copy} style={{ marginBottom: "0.5rem" }}>
      {copied ? "✓ Copied" : label}
    </button>
  );
}
