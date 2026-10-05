import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, luhnValid, redactDeep, redactText } from "./index.js";

describe("redactText", () => {
  it.each([
    ["Visa test card", "card 4242 4242 4242 4242 please", "[REDACTED:card]"],
    ["dashed card", "4000-0566-5566-5556", "[REDACTED:card]"],
    ["Stripe secret", "key sk_live_abcdEFGH12345678", "[REDACTED:secret]"],
    ["OpenAI-style secret", "sk-proj-abcdefghijklmnopqrstu", "[REDACTED:secret]"],
    ["AWS key", "AKIAABCDEFGHIJKLMNOP", "[REDACTED:secret]"],
    ["SSN", "ssn 123-45-6789", "[REDACTED:ssn]"],
    ["Aadhaar", "aadhaar 2345 6789 0123", "[REDACTED:aadhaar]"],
    ["email", "mail jane.doe@example.com", "[REDACTED:email]"],
  ])("redacts %s", (_label, input, marker) => {
    expect(redactText(input)).toContain(marker);
  });

  it("keeps digit runs that fail the Luhn check", () => {
    expect(redactText("order 1234567890123")).toBe("order 1234567890123");
  });

  it("leaves ordinary support text untouched", () => {
    const text = "Customer cus_123 was double charged $15 on case case_9";
    expect(redactText(text)).toBe(text);
  });

  it("honours the allow list", () => {
    expect(redactText("jane@example.com", { allow: ["email"] })).toBe("jane@example.com");
  });
});

describe("redactDeep", () => {
  it("redacts nested strings without mutating the input", () => {
    const input = { msg: "card 4242424242424242", nested: [{ note: "sk_test_abcdefgh1234" }], n: 5 };
    const out = redactDeep(input);
    expect(out.msg).toBe("card [REDACTED:card]");
    expect(out.nested[0]?.note).toBe("[REDACTED:secret]");
    expect(out.n).toBe(5);
    expect(input.msg).toBe("card 4242424242424242");
  });

  it("leaves class instances intact for logger serializers", () => {
    class Request {
      constructor(public readonly url: string) {}
    }
    const req = new Request("/v1/proposals");
    const err = new Error("boom");
    const out = redactDeep({ req, err });
    expect(out.req).toBe(req);
    expect(out.err).toBe(err);
  });
});

describe("luhnValid", () => {
  it("validates known test numbers", () => {
    expect(luhnValid("4242424242424242")).toBe(true);
    expect(luhnValid("4242424242424241")).toBe(false);
  });
});

describe("createLogger", () => {
  function capture() {
    const lines: Record<string, unknown>[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
        cb();
      },
    });
    return { lines, destination };
  }

  it("redacts PII in messages and fields and censors secret paths", () => {
    const { lines, destination } = capture();
    const log = createLogger({ service: "test", destination });
    log.info(
      { customer_message: "my card is 4242 4242 4242 4242", user: { api_key: "abc" } },
      "got sk_test_abcdefgh1234",
    );
    const line = lines[0];
    expect(line?.service).toBe("test");
    expect(line?.level).toBe("info");
    expect(line?.customer_message).toBe("my card is [REDACTED:card]");
    expect(line?.user).toEqual({ api_key: "[REDACTED]" });
    expect(line?.msg).toBe("got [REDACTED:secret]");
  });
});
