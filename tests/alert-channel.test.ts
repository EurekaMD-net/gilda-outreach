import { describe, it, expect, vi, afterEach } from "vitest";
import { formatAlert, createAlertChannel } from "../src/alert/channel.js";

describe("formatAlert", () => {
  it("renders an interested-lead with name + body and a human-takeover instruction", () => {
    const { title, body } = formatAlert({
      kind: "interested-lead",
      prospectId: "p1",
      name: "Salón X",
      jid: "j@s.whatsapp.net",
      body: "¿cuánto cuesta?",
    });
    expect(title).toContain("interesado");
    expect(body).toContain("Salón X");
    expect(body).toContain("¿cuánto cuesta?");
    expect(body).toMatch(/NO responde leads en frío/i);
  });

  it("shows '(sin nombre)' when the prospect has no name", () => {
    const { body } = formatAlert({
      kind: "interested-lead",
      prospectId: "p",
      name: null,
      jid: "j",
      body: "hola",
    });
    expect(body).toContain("(sin nombre)");
  });

  it("renders a session-halted alert with the reason + an anti-ban note", () => {
    const { title, body } = formatAlert({
      kind: "session-halted",
      reason: "WA logout/401 — probable ban",
    });
    expect(title).toContain("DETENIDA");
    expect(body).toContain("WA logout/401 — probable ban");
    expect(body).toMatch(/no se reconecta sola/i);
  });

  it("clips a very long body so the alert stays bounded", () => {
    const { body } = formatAlert({
      kind: "interested-lead",
      prospectId: "p",
      name: null,
      jid: "j",
      body: "x".repeat(1000),
    });
    expect(body.length).toBeLessThan(700);
    expect(body).toContain("…");
  });
});

describe("createAlertChannel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("journald-only when Telegram env is unset: logs, never fetches", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok"));

    const ch = createAlertChannel({} as NodeJS.ProcessEnv);
    await ch.send({ kind: "session-halted", reason: "boom" });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled(); // session-halted goes to console.error
  });

  it("pushes to Telegram when both env vars are present", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));

    const ch = createAlertChannel({
      OUTREACH_ALERT_TELEGRAM_BOT_TOKEN: "tok",
      OUTREACH_ALERT_TELEGRAM_CHAT_ID: "123",
    } as unknown as NodeJS.ProcessEnv);
    await ch.send({
      kind: "interested-lead",
      prospectId: "p",
      name: "Nombre",
      jid: "j",
      body: "hi",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("/bottok/sendMessage");
    const payload = JSON.parse((init as RequestInit).body as string);
    expect(payload.chat_id).toBe("123");
    expect(payload.text).toContain("Nombre");
  });

  it("never throws when the Telegram push rejects", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    const ch = createAlertChannel({
      OUTREACH_ALERT_TELEGRAM_BOT_TOKEN: "tok",
      OUTREACH_ALERT_TELEGRAM_CHAT_ID: "123",
    } as unknown as NodeJS.ProcessEnv);

    await expect(
      ch.send({ kind: "session-halted", reason: "x" }),
    ).resolves.toBeUndefined();
  });

  it("never throws when Telegram returns a non-OK status", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 429 }),
    );

    const ch = createAlertChannel({
      OUTREACH_ALERT_TELEGRAM_BOT_TOKEN: "tok",
      OUTREACH_ALERT_TELEGRAM_CHAT_ID: "123",
    } as unknown as NodeJS.ProcessEnv);

    await expect(
      ch.send({
        kind: "interested-lead",
        prospectId: "p",
        name: "N",
        jid: "j",
        body: "hi",
      }),
    ).resolves.toBeUndefined();
  });
});
