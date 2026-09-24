import { describe, expect, it } from "vitest";
import {
  containsLongTokenLikeSecret,
  looksSensitiveValue,
} from "./sensitive.js";

describe("looksSensitiveValue card detection (linear scanner)", () => {
  it("flags 13, 16 and 19 digit runs", () => {
    expect(looksSensitiveValue("4111111111111")).toBe(true);
    expect(looksSensitiveValue("4111111111111111")).toBe(true);
    expect(looksSensitiveValue("4111111111111111111")).toBe(true);
  });

  it("flags runs with spaces and hyphens", () => {
    expect(looksSensitiveValue("4111 1111 1111 1111")).toBe(true);
    expect(looksSensitiveValue("4111-1111-1111-1111")).toBe(true);
    expect(looksSensitiveValue("4111-1111 1111-1111")).toBe(true);
  });

  it("flags runs embedded in surrounding text", () => {
    expect(looksSensitiveValue("card 4111111111111111 ok")).toBe(true);
    expect(looksSensitiveValue("(4111111111111111)")).toBe(true);
  });

  it("rejects too-short and too-long digit totals", () => {
    expect(looksSensitiveValue("411111111111")).toBe(false);
    expect(looksSensitiveValue("41111111111111111111")).toBe(false);
    expect(looksSensitiveValue("411111111111111111111")).toBe(false);
  });

  it("rejects runs broken by letters", () => {
    expect(looksSensitiveValue("4111111111111111x")).toBe(false);
    expect(looksSensitiveValue("x4111111111111111")).toBe(false);
  });

  it("keeps other sensitive patterns unaffected", () => {
    expect(
      looksSensitiveValue(
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      ),
    ).toBe(true);
    expect(looksSensitiveValue("Bearer abcdefghijklmnop")).toBe(true);
    expect(looksSensitiveValue("token=abcdefghijklmnop")).toBe(true);
    expect(looksSensitiveValue("plain hello world", "message")).toBe(false);
  });

  it("completes a very long hostile input quickly", () => {
    const hostile = `${"1 ".repeat(80_000)}!`;
    const started = Date.now();
    const out = looksSensitiveValue(hostile);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(out).toBe(false);
  }, 15000);

  it("scans a card-like run with a long tail quickly", () => {
    const hostile = `${"1 ".repeat(17)}11${"z".repeat(150_000)}`;
    const started = Date.now();
    expect(looksSensitiveValue(hostile)).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 15000);
});

describe("containsLongTokenLikeSecret (linear scanner)", () => {
  it("flags every documented secret prefix shape", () => {
    const positives = [
      "sk=abcdefghijklmnop",
      "PK: ABCDEFGHIJKLMNOP",
      "token=abcdefghijklmnop",
      "secret:abcdefghijklmnop",
      "api_key=abcdefghijklmnop",
      "apikey:abcdefghijklmnop",
      "token_name=abcdefghijklmnop",
      "secret-value:abcdefghijklmnop",
      "rk=abcdefghijklmnop",
      "some text token=abcdefghijklmnop more text",
      // Embedded prefixes stay sensitive: the old expression was unanchored,
      // so "task="/\"mask=" matched through their trailing "sk".
      "task=abcdefghijklmnop",
      "mask=abcdefghijklmnop",
      "secret_token=abcdefghijklmnop",
    ];
    for (const input of positives) {
      expect(containsLongTokenLikeSecret(input), input).toBe(true);
      expect(looksSensitiveValue(input), `gate ${input}`).toBe(true);
    }
  });

  it("accepts incidental whitespace before the separator (at least as strong)", () => {
    // The old regex required ":" or "=" immediately after the identifier, so
    // "api-key = <token>" did not match. The linear detector intentionally
    // accepts whitespace there instead of dropping a plausible secret.
    expect(containsLongTokenLikeSecret("api-key = abcdefghijklmnop")).toBe(
      true,
    );
    expect(looksSensitiveValue("api-key = abcdefghijklmnop")).toBe(true);
  });

  it("matches prefixes case-insensitively", () => {
    const positives = [
      "SK=abcdefghijklmnop",
      "Sk=abcdefghijklmnop",
      "sK=abcdefghijklmnop",
      "SECRET=abcdefghijklmnop",
      "Secret:abcdefghijklmnop",
      "TOKEN=abcdefghijklmnop",
      "Token=abcdefghijklmnop",
      "API_KEY=abcdefghijklmnop",
      "Api-Key: abcdefghijklmnop",
      "APIKEY=abcdefghijklmnop",
      "aPiKeY=abcdefghijklmnop",
      "pK=abcdefghijklmnop",
      "Rk:abcdefghijklmnop",
    ];
    for (const input of positives) {
      expect(containsLongTokenLikeSecret(input), input).toBe(true);
    }
  });

  it("enforces the exact 16-char threshold and stays strong past it", () => {
    expect(containsLongTokenLikeSecret("token=abcdefghijklmno")).toBe(false);
    expect(containsLongTokenLikeSecret("token=abcdefghijklmnop")).toBe(true);
    expect(containsLongTokenLikeSecret("token=abcdefghijklmnopq")).toBe(true);
    expect(containsLongTokenLikeSecret(`token=${"a".repeat(5000)}`)).toBe(true);
    expect(containsLongTokenLikeSecret("api_key=123456789012345")).toBe(false);
    expect(containsLongTokenLikeSecret("api_key=1234567890123456")).toBe(true);
  });

  it("accepts every credential alphabet character in long tails", () => {
    expect(containsLongTokenLikeSecret("token=abcd.efgh.ijkl.mnop")).toBe(true);
    expect(containsLongTokenLikeSecret("token=abcd_efgh_ijkl_mnop")).toBe(true);
    expect(containsLongTokenLikeSecret("token=abcd~efgh~ijkl~mnop")).toBe(true);
    expect(containsLongTokenLikeSecret("token=abcd+efgh+ijkl+mnop")).toBe(true);
    expect(containsLongTokenLikeSecret("token=abcd/efgh/ijkl/mnop")).toBe(true);
    expect(containsLongTokenLikeSecret("token=abcd-efgh-ijkl-mnop")).toBe(true);
    expect(containsLongTokenLikeSecret("secret:Ab1._~+/-Ab1._~+/-Xy")).toBe(
      true,
    );
  });

  it("accepts whitespace after the separator", () => {
    expect(containsLongTokenLikeSecret("token= abcdefghijklmnop")).toBe(true);
    expect(containsLongTokenLikeSecret("token=  abcdefghijklmnop")).toBe(true);
    expect(containsLongTokenLikeSecret("token=\tabcdefghijklmnop")).toBe(true);
    expect(containsLongTokenLikeSecret("token:\nabcdefghijklmnop")).toBe(true);
    expect(containsLongTokenLikeSecret("token=\r\nabcdefghijklmnop")).toBe(
      true,
    );
    expect(containsLongTokenLikeSecret("token=\fabcdefghijklmnop")).toBe(true);
    expect(containsLongTokenLikeSecret("token=\vabcdefghijklmnop")).toBe(true);
    expect(containsLongTokenLikeSecret("secret:  \t abcdefghijklmnop")).toBe(
      true,
    );
  });

  it("finds a later valid candidate when earlier ones fail", () => {
    expect(
      containsLongTokenLikeSecret("token=short secret=abcdefghijklmnop"),
    ).toBe(true);
    expect(containsLongTokenLikeSecret("token=fooTOKEN=abcdefghijklmnop")).toBe(
      true,
    );
    expect(
      containsLongTokenLikeSecret("api=abcdefghijklmnop pk=abcdefghijklmnop"),
    ).toBe(true);
  });

  it("rejects non-matches and malformed separators", () => {
    const negatives = [
      "token=short",
      "secret=",
      "sk=",
      "token:short",
      "random=abcdefghijklmnop",
      "tok=abcdefghijklmnop",
      "api=abcdefghijklmnop",
      "plain harmless prose",
      "",
      "token abcdefghijklmnop",
      "token::abcdefghijklmnop",
      "token=foo=abcdefghijklmnop",
      "api key=abcdefghijklmnop",
      "api__key=abcdefghijklmnop",
      "token=abcdefghijklmno",
    ];
    for (const input of negatives) {
      expect(containsLongTokenLikeSecret(input), input).toBe(false);
    }
    // Nothing in the gate may re-flag these through another detector either,
    // except where an unrelated detector owns the shape.
    expect(looksSensitiveValue("plain harmless prose", "message")).toBe(false);
    expect(looksSensitiveValue("token=short", "message")).toBe(false);
  });

  it("keeps JWT and Bearer behavior unchanged", () => {
    expect(
      containsLongTokenLikeSecret(
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      ),
    ).toBe(false);
    expect(containsLongTokenLikeSecret("Bearer abcdefghijklmnop")).toBe(false);
    expect(
      looksSensitiveValue(
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      ),
    ).toBe(true);
    expect(looksSensitiveValue("Bearer abcdefghijklmnop")).toBe(true);
    expect(looksSensitiveValue("BEARER abcdefghijklmnop")).toBe(true);
  });

  it("terminates fast on hostile prefix-heavy inputs", () => {
    const cases: Array<[string, string, boolean]> = [
      ["prefixes without separators", "token".repeat(60000), false],
      ["prefixes with spaces", "token ".repeat(50000), false],
      ["prefixes with bad separators", "token!".repeat(60000), false],
      ["prefixes then short tail", `${"token".repeat(20000)} =short`, false],
      [
        "valid secret at the very end",
        `${"lorem ipsum dolor ".repeat(15000)}secret=${"a".repeat(64)}`,
        true,
      ],
      [
        "huge harmless string",
        "the quick brown fox jumps. ".repeat(12000),
        false,
      ],
    ];
    for (const [name, input, expected] of cases) {
      const started = Date.now();
      const out = containsLongTokenLikeSecret(input);
      expect(Date.now() - started, name).toBeLessThan(5000);
      expect(out, name).toBe(expected);
    }
  }, 30000);
});
