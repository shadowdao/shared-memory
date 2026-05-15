import { signOut } from "@/auth";
import { Button } from "@/app/_components/ui/button";
import type { Session } from "next-auth";

async function signOutAction() {
  "use server";
  await signOut({ redirectTo: "/" });
}

export function UserMenu({ user }: { user: Session["user"] }) {
  const label = user.email ?? user.name ?? user.id;
  // Compact, single-line label; truncate on small screens via Tailwind.
  return (
    <div className="flex items-center gap-2">
      <span
        className="hidden sm:inline-block text-xs text-fg-muted max-w-[160px] truncate"
        title={label}
      >
        {label}
      </span>
      <form action={signOutAction}>
        <Button type="submit" variant="secondary" size="sm">
          Sign out
        </Button>
      </form>
    </div>
  );
}
