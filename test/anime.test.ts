import { describe, expect, it } from "vitest";
import {
  parseAnimeTrigger,
  renderAnimeLeaderboard,
  renderAnimePlayerNotFound,
  renderAnimePointAwarded,
  renderAnimeSelfForbidden,
} from "../src/anime";

describe("parseAnimeTrigger", () => {
  it("parses name and explicit amount", () => {
    expect(parseAnimeTrigger("animepiste Matti 1", false)).toEqual({
      targetQuery: "Matti",
      amount: 1,
    });
    expect(parseAnimeTrigger("animepiste @matti 5", false)).toEqual({
      targetQuery: "@matti",
      amount: 5,
    });
    expect(parseAnimeTrigger("Animepisteet Joku Pelaaja 3", false)).toEqual({
      targetQuery: "Joku Pelaaja",
      amount: 3,
    });
  });

  it("defaults amount to 1 when omitted", () => {
    expect(parseAnimeTrigger("animepiste Matti", false)).toEqual({
      targetQuery: "Matti",
      amount: 1,
    });
  });

  it("caps point amounts at 50", () => {
    expect(parseAnimeTrigger("animepiste Matti 999", false)).toEqual({
      targetQuery: "Matti",
      amount: 50,
    });
  });

  it("parses replies", () => {
    expect(parseAnimeTrigger("animepiste", true)).toEqual({ amount: 1 });
    expect(parseAnimeTrigger("animepiste 3", true)).toEqual({ amount: 3 });
    expect(parseAnimeTrigger("+1 animepiste", true)).toEqual({ amount: 1 });
    expect(parseAnimeTrigger("+3 animepisteet", true)).toEqual({ amount: 3 });
    expect(parseAnimeTrigger("/animepiste 2", true)).toEqual({ amount: 2 });
  });

  it("returns null for non-reply single 'animepiste' or empty / invalid commands", () => {
    expect(parseAnimeTrigger("animepiste", false)).toBeNull();
    expect(parseAnimeTrigger("/animepiste", false)).toBeNull();
    expect(parseAnimeTrigger("/animepiste", true)).toBeNull();
    expect(parseAnimeTrigger("+1 animepiste", false)).toBeNull();
    expect(parseAnimeTrigger("jotain muuta tekstiä", false)).toBeNull();
  });
});

describe("renderAnimeLeaderboard", () => {
  it("renders UwU empty message when there are no scores", () => {
    const text = renderAnimeLeaderboard([]);
    expect(text).toContain("H-honto ni?!");
    expect(text).toContain("B-baka!");
    expect(text).toContain("UwU");
  });

  it("renders sarcastic congratulations for the leader and escaped names", () => {
    const text = renderAnimeLeaderboard([
      { id: 1, name: "Naruto <Master>", total: 10 },
      { id: 2, name: "Sasuke", total: 4 },
      { id: 3, name: "Sakura", total: 1 },
    ]);

    expect(text).toContain("Naruto &lt;Master&gt;~senpai!");
    expect(text).toContain("shounen-powerup");
    expect(text).toContain("Giga-Weeb");
    expect(text).toContain("🥇");
    expect(text).toContain("🥈");
    expect(text).toContain("🥉");
    // Ensure no unescaped '<' or '>' remain except valid HTML tags
    expect(text).not.toContain("<Master>");
  });
});

describe("anime error and success renderers", () => {
  it("renders tsundere self-forbidden message", () => {
    const msg = renderAnimeSelfForbidden();
    expect(msg).toContain("B-Baka!");
    expect(msg).toContain("&gt;w&lt;");
  });

  it("renders player not found", () => {
    const msg = renderAnimePlayerNotFound("<hacker>");
    expect(msg).toContain("Gomen nasai!");
    expect(msg).toContain("&lt;hacker&gt;");
  });

  it("renders awarded message", () => {
    const msg = renderAnimePointAwarded({ receiverName: "Kakashi", amount: 1, total: 5 });
    expect(msg).toContain("Kakashi");
    expect(msg).toContain("<b>+1</b> animepiste");
    expect(msg).toContain("<b>5</b> animepistettä");
  });
});
