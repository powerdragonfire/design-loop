import { describe, it, expect } from "vitest";
import { screenFromId } from "../../src/stitch/sdk.js";

const editResponse = {
  outputComponents: [
    { design: { screens: [] } },
    { design: { screens: [{ id: "sc-2", htmlCode: { downloadUrl: "https://x/h" }, screenshot: { downloadUrl: "https://x/p" } }] } },
  ],
};

describe("screenFromId", () => {
  it("edits without ever fetching the screen first", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const callTool = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return editResponse;
    };
    const screen = screenFromId("proj-1", "sc-1", callTool);
    const next = await screen.edit("make it bigger", "MOBILE", "GEMINI_3_PRO");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("edit_screens");
    expect(calls[0]!.args.selectedScreenIds).toEqual(["sc-1"]);
    expect(next.id).toBe("sc-2");
  });

  it("refuses to download, because get_screen is not usable", async () => {
    const screen = screenFromId("proj-1", "sc-1", async () => editResponse);
    await expect(screen.getHtml()).rejects.toThrow(/rebuilt from an id/);
    await expect(screen.getImage()).rejects.toThrow(/rebuilt from an id/);
  });
});
