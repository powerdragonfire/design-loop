import { describe, it, expect, vi } from "vitest";
import { createSdkProject, projectScreen, projectScreens, StitchProjectionError } from "../../src/stitch/sdk.js";

/**
 * SDK 0.3.5 projects an edit/generate response with
 * `outputComponents.find((c) => c?.design?.screens != null)?.design?.screens?.[0]`.
 * `[] != null` is true, so a progress component carrying an empty `screens` array wins over the
 * later component holding the real screen, and a complete payload throws. These tests pin the
 * flatMap projection the SDK's own `variants()` uses, which does not have that hole.
 */
describe("projectScreen", () => {
  const screen = { id: "s1", htmlCode: { downloadUrl: "https://x/html" } };
  const component = (screens: unknown[]) => ({ design: { screens } });

  it("skips a leading component whose screens array is empty", () => {
    const raw = { outputComponents: [component([]), component([screen])] };
    expect(projectScreen(raw, "edit_screens")).toEqual(screen);
  });

  it("takes the first screen across every component, not the first component with a screens key", () => {
    const raw = { outputComponents: [{ text: "working" }, component([]), component([screen, { id: "s2" }])] };
    expect(projectScreen(raw, "edit_screens")).toEqual(screen);
  });

  it("names the tool, the component count and their keys when no component carries a screen", () => {
    const raw = { outputComponents: [{ progressUpdates: {} }, { text: "still going" }] };
    expect(() => projectScreen(raw, "edit_screens")).toThrow(StitchProjectionError);
    expect(() => projectScreen(raw, "edit_screens")).toThrow(
      "edit_screens returned no screen: 2 output component(s) with keys [progressUpdates], [text]; 0 screens across them",
    );
  });

  it("counts screens that are present but unusable, so an empty array is distinguishable from none", () => {
    const raw = { outputComponents: [component([null])] };
    expect(() => projectScreen(raw, "generate_screen_from_text")).toThrow(/1 screens across them/);
  });

  // parseToolResponse falls through to `return textContent.text` when the body is not JSON, so `raw`
  // can be a bare string. That must not surface as a TypeError.
  it("reports a non-object response as a projection failure, not a TypeError", () => {
    expect(() => projectScreen("Service Unavailable", "edit_screens")).toThrow(StitchProjectionError);
    expect(() => projectScreen("Service Unavailable", "edit_screens")).toThrow(
      "edit_screens returned no screen: the response was a string, not an object with outputComponents",
    );
  });

  it("reports a missing outputComponents field as a projection failure", () => {
    expect(() => projectScreen({ projectId: "p1" }, "edit_screens")).toThrow(
      /the response was an object with keys \[projectId\], but no outputComponents array/,
    );
  });
});

describe("projectScreens", () => {
  const component = (screens: unknown[]) => ({ design: { screens } });

  it("returns every screen across every component, in order", () => {
    const raw = { outputComponents: [component([{ id: "a" }]), { text: "working" }, component([{ id: "b" }, { id: "c" }])] };
    expect(projectScreens(raw, "generate_variants").map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("drops non-object entries rather than returning holes", () => {
    const raw = { outputComponents: [component([null, { id: "a" }])] };
    expect(projectScreens(raw, "generate_variants").map((s) => s.id)).toEqual(["a"]);
  });

  it("throws the same projection error as the singular form when nothing carries a screen", () => {
    const raw = { outputComponents: [{ text: "still going" }] };
    expect(() => projectScreens(raw, "generate_variants")).toThrow(StitchProjectionError);
    expect(() => projectScreens(raw, "generate_variants")).toThrow(/1 output component\(s\)/);
  });
});

describe("createSdkProject", () => {
  const screen = (over: Record<string, unknown> = {}) => ({ id: "s1", ...over });
  const wrap = (s: unknown) => ({ outputComponents: [{ design: { screens: [s] } }] });
  const callOf = (impl: (name: string, args: any) => unknown) =>
    vi.fn(async (name: string, args: Record<string, unknown>) => impl(name, args));

  it("generates with a bare projectId and passes the device and model through", async () => {
    const callTool = callOf(() => wrap(screen()));
    const project = createSdkProject("4044680601076201931", callTool);
    const s = await project.generate("a simple mobile login screen", "MOBILE", "GEMINI_3_PRO");
    expect(s.id).toBe("s1");
    expect(callTool).toHaveBeenCalledWith("generate_screen_from_text", {
      projectId: "4044680601076201931",
      prompt: "a simple mobile login screen",
      deviceType: "MOBILE",
      modelId: "GEMINI_3_PRO",
    });
  });

  it("edits by bare screen id, with no projects/ or screens/ prefix", async () => {
    const callTool = callOf((name) => wrap(screen({ id: name === "edit_screens" ? "s2" : "s1" })));
    const project = createSdkProject("p1", callTool);
    const edited = await (await project.generate("go", "MOBILE")).edit("make the button larger", "MOBILE");
    expect(edited.id).toBe("s2");
    expect(callTool).toHaveBeenLastCalledWith("edit_screens", {
      projectId: "p1",
      selectedScreenIds: ["s1"],
      prompt: "make the button larger",
      deviceType: "MOBILE",
      modelId: undefined,
    });
  });

  it("survives the shape that breaks the SDK: a progress component ahead of the real screen", async () => {
    const callTool = callOf(() => ({
      outputComponents: [{ design: { screens: [] }, progressUpdates: {} }, { design: { screens: [screen()] } }],
    }));
    const s = await createSdkProject("p1", callTool).generate("go", "MOBILE");
    expect(s.id).toBe("s1");
  });

  it("derives the id from a resource name when the screen carries no id", async () => {
    const callTool = callOf(() => wrap({ name: "projects/p1/screens/b654ed8c" }));
    const s = await createSdkProject("p1", callTool).generate("go", "MOBILE");
    expect(s.id).toBe("b654ed8c");
  });

  describe("download links", () => {
    it("prefers the urls the generate response already carried, without a second call", async () => {
      const callTool = callOf(() =>
        wrap(screen({ htmlCode: { downloadUrl: "https://x/html" }, screenshot: { downloadUrl: "https://x/png" } })),
      );
      const s = await createSdkProject("p1", callTool).generate("go", "MOBILE");
      expect(await s.getHtml()).toBe("https://x/html");
      expect(await s.getImage()).toBe("https://x/png");
      expect(callTool).toHaveBeenCalledTimes(1);
    });

    it("falls back to get_screen when the response carried no url", async () => {
      const callTool = callOf((name) =>
        name === "get_screen" ? { htmlCode: { downloadUrl: "https://later/html" } } : wrap(screen()),
      );
      const s = await createSdkProject("p1", callTool).generate("go", "MOBILE");
      expect(await s.getHtml()).toBe("https://later/html");
      expect(callTool).toHaveBeenLastCalledWith("get_screen", {
        projectId: "p1",
        screenId: "s1",
        name: "projects/p1/screens/s1",
      });
    });

    // The adapter turns "" into a named error; a throw here would lose that message.
    it("returns an empty string, not a throw, when even get_screen has no url", async () => {
      const callTool = callOf((name) => (name === "get_screen" ? {} : wrap(screen())));
      const s = await createSdkProject("p1", callTool).generate("go", "MOBILE");
      expect(await s.getHtml()).toBe("");
      expect(await s.getImage()).toBe("");
    });
  });
});
