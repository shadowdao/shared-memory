import { z } from "zod";

export const MemoryScope = z.enum(["project", "user"]);
export type MemoryScope = z.infer<typeof MemoryScope>;

export const MemoryVisibility = z.enum(["private", "shared", "team"]);
export type MemoryVisibility = z.infer<typeof MemoryVisibility>;

export const ProjectKey = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9._\-/]+$/, "project key may only contain alphanumerics, ._-/");
export type ProjectKey = z.infer<typeof ProjectKey>;

export const MemoryContent = z.string().min(1).max(64_000);

export const Tags = z
  .array(z.string().min(1).max(64).regex(/^[a-zA-Z0-9._\-]+$/, "tag must be alphanumeric ._-"))
  .max(32)
  .default([]);

export const MemoryWriteInput = z.object({
  content: MemoryContent,
  project: ProjectKey.optional(),
  tags: Tags.optional(),
  scope: MemoryScope.default("project"),
});
export type MemoryWriteInput = z.infer<typeof MemoryWriteInput>;

export const MemoryListInput = z.object({
  project: ProjectKey.optional(),
  scope: MemoryScope.optional(),
  tags: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type MemoryListInput = z.infer<typeof MemoryListInput>;

export const MemoryIdInput = z.object({
  id: z.string().uuid(),
});
export type MemoryIdInput = z.infer<typeof MemoryIdInput>;

export const ProjectIdentifyInput = z.object({
  key: ProjectKey,
  display_name: z.string().min(1).max(200).optional(),
});
export type ProjectIdentifyInput = z.infer<typeof ProjectIdentifyInput>;
