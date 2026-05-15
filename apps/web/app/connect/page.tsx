import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Legacy URL — moved to /settings/tokens in Phase 3b. Preserve old
// bookmarks and the existing instructions printed by older clients.
export default function ConnectRedirect() {
  redirect("/settings/tokens");
}
