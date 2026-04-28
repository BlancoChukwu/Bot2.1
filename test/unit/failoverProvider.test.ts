import { describe, expect, it } from "vitest";
import { createFailoverTransportUrls } from "../../src/utils/failoverProvider";

describe("createFailoverTransportUrls", () => {
  it("keeps the primary RPC first and removes duplicate fallbacks", () => {
    const urls = createFailoverTransportUrls({
      primaryRpcUrl: "https://primary.example",
      fallbackRpcUrls: [
        "https://backup.example",
        "https://primary.example",
        " ",
        "https://backup.example",
      ],
    });

    expect(urls).toEqual(["https://primary.example", "https://backup.example"]);
  });

  it("fails fast when no primary RPC URL is configured", () => {
    expect(() =>
      createFailoverTransportUrls({
        primaryRpcUrl: "",
        fallbackRpcUrls: ["https://backup.example"],
      }),
    ).toThrow(/primaryRpcUrl/);
  });
});
