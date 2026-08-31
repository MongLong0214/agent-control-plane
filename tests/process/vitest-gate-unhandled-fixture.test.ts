import { expect, it } from "vitest";

it.skipIf(process.env.ACP_VITEST_UNHANDLED_FIXTURE !== "1")(
  "emits the opt in unhandled rejection fixture",
  async () => {
    expect(true).toBe(true);

    setTimeout(() => {
      void Promise.reject(new Error("intentional gate integration unhandled rejection"));
    }, 0);
    await new Promise((resolve) => setTimeout(resolve, 25));
  },
);
