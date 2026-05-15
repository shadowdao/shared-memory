import { Input } from "@/app/_components/ui/input";

/**
 * Global search — submits a GET to /memories with `?q=`. Server-rendered
 * results page handles the actual memory.search call.
 */
export function SearchBox() {
  return (
    <form action="/memories" method="GET" role="search">
      <Input
        type="search"
        name="q"
        placeholder="Search memories…"
        aria-label="Search memories"
        autoComplete="off"
      />
    </form>
  );
}
