import { expect, it } from "vitest";
import { handlePublish, type PublishEnv } from "../publish";

it("refuses to provision a different app over the Hanzi and Yi short addresses", async () => {
  for (const id of ["hanzi", "yi"]) {
    const result = await handlePublish({ id, name: id, category: "Learning", icon: "", iconBg: "", description: "A new app", store: "apps" }, {} as PublishEnv, async () => { throw new Error("Must reject before GitHub calls"); });
    expect(result.success).toBe(false);
    expect(result.steps[0].detail).toContain("reserved");
  }
});
