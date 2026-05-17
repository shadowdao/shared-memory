import Link from "next/link";
import { Container } from "@/app/_components/ui/container";
import { UserMenu } from "./_user-menu";
import { SearchBox } from "./_search-box";
import type { Session } from "next-auth";

export function Nav({ user }: { user: Session["user"] }) {
  return (
    <header className="fixed top-0 inset-x-0 z-20 h-14 bg-surface-1/80 backdrop-blur border-b border-border">
      <Container className="h-full flex items-center gap-4">
        <Link
          href="/memories"
          className="flex items-center gap-2 text-fg font-semibold tracking-tight no-underline"
        >
          <span className="inline-block size-2 rounded-full bg-accent-400" />
          shared-memory
        </Link>

        <nav className="hidden md:flex items-center gap-1 ml-2">
          <NavLink href="/memories">Memories</NavLink>
          <NavLink href="/snippets">Snippets</NavLink>
          <NavLink href="/projects">Projects</NavLink>
          <NavLink href="/settings">Settings</NavLink>
        </nav>

        <div className="flex-1 max-w-md ml-auto">
          <SearchBox />
        </div>

        <UserMenu user={user} />
      </Container>
    </header>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="px-2.5 py-1.5 rounded-md text-sm text-fg-muted hover:text-fg hover:bg-surface-2 no-underline"
    >
      {children}
    </Link>
  );
}
