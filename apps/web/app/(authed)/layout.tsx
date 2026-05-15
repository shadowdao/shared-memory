import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { auth } from "@/auth";
import { Nav } from "./_nav";

export const dynamic = "force-dynamic";

export default async function AuthedLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.user) {
    redirect("/api/auth/signin?callbackUrl=/memories");
  }
  return (
    <>
      <Nav user={session.user} />
      <div className="pt-16 pb-16">{children}</div>
    </>
  );
}
