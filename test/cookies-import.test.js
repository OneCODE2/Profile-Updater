const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseSessionImport,
} = require("../server/cookies-import");

describe("parseSessionImport", () => {
  it("accepts Playwright storageState JSON", () => {
    const input = {
      cookies: [
        {
          name: "NI",
          value: "abc",
          domain: ".naukri.com",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ],
      origins: [],
    };
    const state = parseSessionImport(JSON.stringify(input));
    assert.equal(state.cookies.length, 1);
    assert.equal(state.cookies[0].name, "NI");
    assert.equal(state.cookies[0].domain, ".naukri.com");
  });

  it("converts Cookie-Editor array export", () => {
    const input = [
      {
        domain: ".naukri.com",
        expirationDate: 1893456000,
        httpOnly: true,
        name: "NI",
        path: "/",
        sameSite: "no_restriction",
        secure: true,
        value: "tok",
      },
      {
        domain: "ads.example.com",
        name: "x",
        path: "/",
        value: "y",
        secure: false,
        httpOnly: false,
      },
    ];
    const state = parseSessionImport(JSON.stringify(input));
    assert.equal(state.cookies.length, 1);
    assert.equal(state.cookies[0].sameSite, "None");
    assert.ok(state.cookies[0].expires > 0);
  });

  it("rejects empty / non-naukri cookies", () => {
    assert.throws(
      () => parseSessionImport(JSON.stringify({ cookies: [], origins: [] })),
      /naukri/i,
    );
    assert.throws(
      () =>
        parseSessionImport(
          JSON.stringify([{ name: "a", value: "b", domain: "google.com", path: "/" }]),
        ),
      /naukri/i,
    );
  });
});
