import { describe, expect, it, vi } from "vitest";
import {
  buildSignalDisplayNameIndex,
  createSignalDisplayNameResolver,
} from "./display-names.js";
import * as directory from "./directory.js";

describe("signal display name resolution", () => {
  it("indexes contact names by normalized number and uuid", () => {
    const index = buildSignalDisplayNameIndex([
      {
        name: "Casey",
        number: "1 (555) 000-1111",
        uuid: "550E8400-E29B-41D4-A716-446655440000",
      },
    ]);

    expect(index.byNumber.get("+15550001111")).toBe("Casey");
    expect(index.byUuid.get("550e8400-e29b-41d4-a716-446655440000")).toBe("Casey");
  });

  it("prefers mention.name before consulting contacts", async () => {
    const listContactsSpy = vi
      .spyOn(directory, "listSignalContacts")
      .mockResolvedValue([{ name: "Ignored", number: "+15550001111" }]);
    const resolver = createSignalDisplayNameResolver({
      cfg: {} as never,
      accountId: "default",
    });

    await expect(
      resolver.resolveMentionDisplayName({
        name: "Visible Name",
        uuid: "550e8400-e29b-41d4-a716-446655440000",
        start: 0,
        length: 1,
      }),
    ).resolves.toBe("Visible Name");
    expect(listContactsSpy).not.toHaveBeenCalled();
  });

  it("resolves sender and mention names from cached contacts", async () => {
    const listContactsSpy = vi.spyOn(directory, "listSignalContacts").mockResolvedValue([
      {
        name: "Casey",
        number: "+15550001111",
        uuid: "550e8400-e29b-41d4-a716-446655440000",
      },
    ]);
    const resolver = createSignalDisplayNameResolver({
      cfg: {} as never,
      accountId: "default",
    });

    await expect(
      resolver.resolveSenderDisplayName({
        kind: "phone",
        raw: "+15550001111",
        e164: "+15550001111",
        uuid: "550e8400-e29b-41d4-a716-446655440000",
      }),
    ).resolves.toBe("Casey");
    await expect(
      resolver.resolveMentionDisplayName({
        uuid: "550e8400-e29b-41d4-a716-446655440000",
        start: 0,
        length: 1,
      }),
    ).resolves.toBe("Casey");
    expect(listContactsSpy).toHaveBeenCalledOnce();
  });

  it("refreshes cached contacts after the configured TTL and reflects renamed entries", async () => {
    let now = 1_000;
    const listContacts = vi
      .fn<typeof directory.listSignalContacts>()
      .mockResolvedValueOnce([
        {
          name: "Casey",
          number: "+15550001111",
        },
      ])
      .mockResolvedValueOnce([
        {
          name: "Jordan",
          number: "+15550001111",
        },
      ]);

    const resolver = createSignalDisplayNameResolver({
      cfg: {} as never,
      accountId: "default",
      refreshTtlMs: 50,
      now: () => now,
      listContacts,
    });

    await expect(
      resolver.resolveSenderDisplayName({
        kind: "phone",
        raw: "+15550001111",
        e164: "+15550001111",
      }),
    ).resolves.toBe("Casey");

    now += 100;

    await expect(
      resolver.resolveSenderDisplayName({
        kind: "phone",
        raw: "+15550001111",
        e164: "+15550001111",
      }),
    ).resolves.toBe("Jordan");
    expect(listContacts).toHaveBeenCalledTimes(2);
  });

  it("keeps serving the last good cache when a refresh fails", async () => {
    let now = 1_000;
    const listContacts = vi
      .fn<typeof directory.listSignalContacts>()
      .mockResolvedValueOnce([
        {
          name: "Casey",
          number: "+15550001111",
        },
      ])
      .mockRejectedValueOnce(new Error("directory offline"));

    const resolver = createSignalDisplayNameResolver({
      cfg: {} as never,
      accountId: "default",
      refreshTtlMs: 50,
      now: () => now,
      listContacts,
    });

    await expect(
      resolver.resolveSenderDisplayName({
        kind: "phone",
        raw: "+15550001111",
        e164: "+15550001111",
      }),
    ).resolves.toBe("Casey");

    now += 100;

    await expect(
      resolver.resolveSenderDisplayName({
        kind: "phone",
        raw: "+15550001111",
        e164: "+15550001111",
      }),
    ).resolves.toBe("Casey");
    expect(listContacts).toHaveBeenCalledTimes(2);
  });
});
