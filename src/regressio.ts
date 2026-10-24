import type { ResultRow } from "./db";
import type { Standing } from "./scoring";

export interface Ai {
  run(model: string, inputs: Record<string, unknown>): Promise<any>;
}

export interface RegressionStats {
  totalPlayed: number;
  rawAverage: number; // on 5.0 scale
  outlierCount: number;
  regressedAverage: number; // on 5.0 scale
  dropPercent: number;
  outlierPuzzles: string[];
}

export interface RegressioReport {
  playerName: string;
  stats: RegressionStats;
  explanation: string;
  outlierLabel?: string;
  conclusion?: string;
  subtitle?: string;
}

export interface BlowoutCheck {
  isBlowout: boolean;
  winnerId: number;
  winnerScore: number;
  secondId: number | null;
  secondScore: number;
  marginPercent: number;
}

export interface BlowoutReport {
  winnerName: string;
  winnerScore: number;
  secondScore: number;
  marginPercent: number;
  regressedScore: number;
  explanation: string;
}

/**
 * Calculates the regression to the mean by removing the top 20% outliers (or top scores)
 * as unsustainable flukes.
 */
export function calculateRegression(results: ResultRow[]): RegressionStats {
  const n = results.length;
  if (n === 0) {
    return {
      totalPlayed: 0,
      rawAverage: 0,
      outlierCount: 0,
      regressedAverage: 0,
      dropPercent: 0,
      outlierPuzzles: [],
    };
  }

  // Calculate ratio (score / max_score) for each result
  const items = results.map((r) => ({
    ...r,
    ratio: r.score / r.max_score,
  }));

  const rawSum = items.reduce((acc, it) => acc + it.ratio, 0);
  const rawMeanRatio = rawSum / n;
  const rawAverage = Math.round(rawMeanRatio * 5 * 10) / 10;

  if (n === 1) {
    // Single game: if 1.0, regress to 50%
    const it = items[0]!;
    const regressedRatio = it.ratio > 0.5 ? 0.4 : it.ratio * 0.5;
    const regressedAverage = Math.round(regressedRatio * 5 * 10) / 10;
    const dropPercent = rawAverage > 0 ? Math.round(((rawAverage - regressedAverage) / rawAverage) * 1000) / 10 : 0;
    return {
      totalPlayed: 1,
      rawAverage,
      outlierCount: 1,
      regressedAverage,
      dropPercent,
      outlierPuzzles: [`${it.game} (${it.score}/${it.max_score})`],
    };
  }

  // Sort descending by ratio
  const sorted = [...items].sort((a, b) => b.ratio - a.ratio || b.score - a.score);

  // Remove top 20% (at least 1, at most n - 1)
  const k = Math.max(1, Math.min(n - 1, Math.ceil(n * 0.2)));
  const outliers = sorted.slice(0, k);
  const remaining = sorted.slice(k);

  const remainingSum = remaining.reduce((acc, it) => acc + it.ratio, 0);
  const regressedMeanRatio = remainingSum / remaining.length;
  const regressedAverage = Math.round(regressedMeanRatio * 5 * 10) / 10;

  const drop = rawAverage - regressedAverage;
  const dropPercent = rawAverage > 0 ? Math.round((drop / rawAverage) * 1000) / 10 : 0;

  const outlierPuzzles = outliers.map((o) => `${o.game} (${o.score}/${o.max_score})`);

  return {
    totalPlayed: n,
    rawAverage,
    outlierCount: k,
    regressedAverage,
    dropPercent: Math.max(0, dropPercent),
    outlierPuzzles,
  };
}

/**
 * Checks if the day's overall winner had a blowout victory (> 20% better than 2nd place).
 */
export function checkBlowout(overallStandings: Standing[]): BlowoutCheck {
  if (overallStandings.length < 2) {
    return {
      isBlowout: false,
      winnerId: overallStandings[0]?.playerId ?? 0,
      winnerScore: overallStandings[0]?.value ?? 0,
      secondId: null,
      secondScore: 0,
      marginPercent: 0,
    };
  }

  const s1 = overallStandings[0]!.value;
  const s2 = overallStandings[1]!.value;

  if (s1 <= 0) {
    return {
      isBlowout: false,
      winnerId: overallStandings[0]!.playerId,
      winnerScore: s1,
      secondId: overallStandings[1]!.playerId,
      secondScore: s2,
      marginPercent: 0,
    };
  }

  if (s2 <= 0) {
    return {
      isBlowout: true,
      winnerId: overallStandings[0]!.playerId,
      winnerScore: s1,
      secondId: overallStandings[1]!.playerId,
      secondScore: s2,
      marginPercent: 100,
    };
  }

  const margin = (s1 - s2) / s2;
  const marginPercent = Math.round(margin * 1000) / 10;

  return {
    isBlowout: margin > 0.2, // strictly > 20%
    winnerId: overallStandings[0]!.playerId,
    winnerScore: s1,
    secondId: overallStandings[1]!.playerId,
    secondScore: s2,
    marginPercent,
  };
}

export interface FallbackItem {
  outlierLabel: string;
  conclusion: string;
  explanation: string;
}

export const FALLBACK_ITEMS: FallbackItem[] = [
  {
    outlierLabel: "Hemohes-tason lääkärinlaukun antimia",
    conclusion: "Taantuu Juha Miedon tavoin ikuiseksi sadasosahäviäjäksi.",
    explanation: "Tulosprofiili muistuttaa hämmästyttävän paljon Lahden huoltoaseman lääkärinlaukun sisältöä. Heti kun pitoalue pestään puhtaaksi Hemohesista, pelaaja taantuu harmaaseen perusmassaan.",
  },
  {
    outlierLabel: "Hetkellistä suojakelin voiteluapua",
    conclusion: "Häviää sadasosasekunnilla joka ikinen kerta.",
    explanation: "Kovin suonenveto johtui pelkästään hetkellisestä suojakelin voiteluedusta. Todellisuudessa pelaaja häviää Juha Miedon tavoin sadasosasekunnilla joka ikinen kerta.",
  },
  {
    outlierLabel: "Järjetöntä lottotason topdeck-tuuria",
    conclusion: "Käteen jää vain paha mana flood ja toivoton mulligan.",
    explanation: "Tämä tulos oli pelkkää järjetöntä lottotason topdeckiä juuri oikealla vuorolla. Kun satunnaistuuri karsitaan pois, käteen jää vain paha mana flood ja toivoton mulligan.",
  },
  {
    outlierLabel: "Vastustajan 322-tason heittelyä",
    conclusion: "Syöttää Divine Rapierin suoraan vihollisen kantaan.",
    explanation: "Huippupisteet selittyvät ainoastaan vastustajan 322-tason throwauksella. Todellisuudessa pelaaja ostaa Divine Rapierin, kuolee ilman buybackia ja syöttää voiton suoraan viholliselle.",
  },
  {
    outlierLabel: "Sokeaa juoksua savujen läpi Silver-tähtäyksellä",
    conclusion: "15–3-johdon heittäminen vihollisen eco-kierrokselle.",
    explanation: "Pelaajan suoritus oli täyttä Silver-tason tuurijuoksua savujen läpi sokkona. Tilastokorjauksen jälkeen edessä on vääjäämätön 15–3-johdon heittäminen suoraan vihollisen eco-kierrokselle.",
  },
  {
    outlierLabel: "Näennäistä 5–1-harhajohtoa",
    conclusion: "Täydellinen sulaminen harmaaksi sarjajyräksi.",
    explanation: "Tilastokorjauksen jälkeen suoritus vastaa vuoden 2003 MM-puolivälierää Ruotsia vastaan. Näennäinen 5–1-johto sulaa vääjäämättä täydelliseksi katastrofiksi.",
  },
  {
    outlierLabel: "Fifty-sixty tuulirakolottoa",
    conclusion: "Putoaa suoraan kumpuun ilman tyylipisteitä.",
    explanation: "Kyseessä oli vain Matti Nykäsen fifty-sixty tuulirako, josta taito oli kaukana. Kun suotuisa puuska laantuu, pelaaja putoaa suoraan kumpuun.",
  },
  {
    outlierLabel: "Ferrarin varikkotaktiikan kaltaista silmänlumetta",
    conclusion: "Vauhti riittää korkeintaan peräpään taisteluun.",
    explanation: "Pisteet näyttävät hyvältä vain hetken, vähän kuin Ferrarin F1-taktiikka ennen ensimmäistä varikkopysähdystä. Todellinen vauhti riittää korkeintaan peräpään taisteluun.",
  },
];

export const FALLBACK_EXPLANATIONS = FALLBACK_ITEMS.map((it) => it.explanation);

export const SYSTEM_PROMPT = `Olet kyyninen, ivallinen ja ilkikurinen tilastoasiantuntija (Hajonta- ja Kärykomission ylitarkastaja). 
Pelaajan tuloksista poistettiin parhaat suoritukset (outlierit), koska ne olivat tilastollista harhaa, puhdasta tuuria tai vilppiä. 
Tehtäväsi on antaa ivallinen ja absurdi analyysi suomeksi sille, miksi pelaaja on todellisuudessa täysin harmaa rivipelaaja.

Käytä eläviä vertauksia suomalaisesta urheilusta, kansainvälisestä huippu-urheilusta tai e-urheilusta.
HUOMAA: Alla mainitut tapaukset ovat VAIN esimerkkejä antamassa suuntaa. Saat ja sinun kannattaa keksiä ja soveltaa vapaasti mitä tahansa muitakin tunnettuja lajeja, urheilutapahtumia, e-urheilupelejä, sääntöjä, meemejä ja klassikkofiascoja:

1. Suomalainen urheilu (esimerkkejä: Lahti 2001, Hemohes, huoltoaseman lääkärinlaukut, Juha Miedon sadasosatappio, Suomi–Ruotsi 2003 5–1 sulaminen, Nykäsen tuuliraot, Seppo Räty, sauvarikot, keihäänheitto jne.).
2. E-urheilu (esimerkkejä ryhmän suosikeista: Counter-Strike, Dota 2, Magic: The Gathering, sekä mikä tahansa muu suosittu kilpapeli: huonot ostot, heittämiset, huono tuuri, kämppääminen, sääntökömmähdykset).
3. Kansainvälinen urheilu (esimerkkejä: F1, jalkapallon sulamiset, tenniksen tuplavirheet jne.).

Ehdottomat säännöt:
- Vastaa AINOASTAAN seuraavassa 3 rivin muodossa:
KARSINTA: <lyhyt 2-6 sanan ivallinen luonnehdinta karsituista suonevedoista>
JOHTOPÄÄTÖS: <lyhyt 3-8 sanan ivallinen johtopäätös todellisesta tasosta>
LAUSUNTO: <1-2 virkkeen pureva asiantuntijalausunto>
- YHDESSÄ VASTAUKSESSA KESKITYTÄÄN VAIN YHTEEN LAJIIN, PELIIN TAI TAPAHTUMAAN KERRALLAAN. Älä sotke useita eri lajeja keskenään samaan vastaukseen (esimerkiksi Magic: The Gatheringia EI saa sekoittaa hiihtoon, eikä Counter-Strikea jalkapalloon). Pysy tiukasti yhdessä valitsemassasi teemassa.
- ÄLÄ KOSKAAN mainitse amerikkalaista jalkapalloa, NFL:ää tai Patrick Mahomesia.
- Sävy on pseudotieteellisen vakava, mutta sisältö purevan humoristinen.`;

export function pickFallback(): FallbackItem {
  const idx = Math.floor(Math.random() * FALLBACK_ITEMS.length);
  return FALLBACK_ITEMS[idx] ?? FALLBACK_ITEMS[0]!;
}

export function parseExplanation(text: string): FallbackItem {
  const karsintaMatch = /KARSINTA:\s*([^\n]+)/i.exec(text);
  const johtopaatosMatch = /JOHTOPÄÄTÖS:\s*([^\n]+)/i.exec(text);
  const lausuntoMatch = /LAUSUNTO:\s*([\s\S]+)/i.exec(text);

  if (karsintaMatch || johtopaatosMatch || lausuntoMatch) {
    const fallback = pickFallback();
    return {
      outlierLabel: karsintaMatch ? karsintaMatch[1]!.trim().replace(/^["'«]+|["'»]+$/g, "") : fallback.outlierLabel,
      conclusion: johtopaatosMatch ? johtopaatosMatch[1]!.trim().replace(/^["'«]+|["'»]+$/g, "") : fallback.conclusion,
      explanation: lausuntoMatch
        ? lausuntoMatch[1]!.trim().replace(/^["'«]+|["'»]+$/g, "")
        : text.replace(/^["'«]+|["'»]+$/g, "").trim() || fallback.explanation,
    };
  }

  const fallback = pickFallback();
  return {
    outlierLabel: fallback.outlierLabel,
    conclusion: fallback.conclusion,
    explanation: text.replace(/^["'«]+|["'»]+$/g, "").trim() || fallback.explanation,
  };
}

/**
 * Calls Cloudflare Workers AI with fallback on failure or timeout.
 */
export async function generateExplanation(
  ai: Ai | undefined,
  name: string,
  context: "player" | "blowout",
  details: string,
): Promise<FallbackItem> {
  if (!ai) return pickFallback();

  const userPrompt =
    context === "player"
      ? `Konteksti: Pelaajan kaikkien pelien tilastoanalyysi.
Pelaaja: ${name}
${details}

Kirjoita analyysi vaaditussa 3 rivin formaatissa (KARSINTA, JOHTOPÄÄTÖS, LAUSUNTO).`
      : `Konteksti: Päivän tulosjulkistus, jossa voittaja saavutti epäilyttävän ylivoiman (>20 % johto).
Päivän voittaja: ${name}
${details}

Kirjoita analyysi vaaditussa 3 rivin formaatissa (KARSINTA, JOHTOPÄÄTÖS, LAUSUNTO).`;

  try {
    const aiPromise = ai.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 160,
      temperature: 0.75,
    });

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("AI timeout")), 2500),
    );

    const res: any = await Promise.race([aiPromise, timeoutPromise]);
    const text = typeof res?.response === "string" ? res.response.trim() : "";
    if (text.length > 5) {
      return parseExplanation(text);
    }
    return pickFallback();
  } catch (err) {
    console.warn("AI generation failed or timed out, using fallback", err instanceof Error ? err.message : err);
    return pickFallback();
  }
}
