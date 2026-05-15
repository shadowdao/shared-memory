import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Legacy URL — Phase 1's debug page. Replaced by /dashboard + /settings.
export default function MeRedirect() {
  redirect("/dashboard");
}
