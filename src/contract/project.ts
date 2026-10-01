import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * What `/design-setup` learns about the app a design folder belongs to, for the skills and `check` to read.
 *
 * Deliberately NOT part of `config.json`: that schema is strict and every field in it changes how a run
 * behaves. Nothing here does. It is the context a person would otherwise retype at every brief — which app,
 * which Figma pages hold the screens and the component library, where the app's own components live.
 */
export const ProjectSchema = z.object({
  app: z.string().min(1),
  /** The app's code repository, for "port from app code" briefs. */
  appRepo: z.string().optional(),
  /** The human design-system document, relative to the design folder. The loop never reads it; `check` asks
   * whether `brief.md` carries its rules. */
  designDoc: z.string().optional(),
  figma: z
    .object({
      fileKey: z.string().min(1),
      /** Where new frames are built; normally the same as config.json's `figma.pageId`. */
      targetPageId: z.string().optional(),
      /** The page holding the file's components, which a brief points the build at before drawing anything new. */
      componentsPageId: z.string().optional(),
    })
    .optional(),
  /** Where a brief may draw components from, in order of preference. */
  componentSources: z.array(z.enum(["figma-library", "gluestack", "makeitanimated", "custom"])).optional(),
  /** The app's components folder, relative to `appRepo`. */
  codeComponentsDir: z.string().optional(),
});

export type Project = z.infer<typeof ProjectSchema>;

/** null when the folder has no `project.json`; throws, naming the field, when it has a broken one. */
export async function readProject(designDir: string): Promise<Project | null> {
  const file = join(designDir, "project.json");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`project.json is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = ProjectSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`invalid project.json: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}
