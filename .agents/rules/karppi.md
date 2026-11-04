---
description: Projektin tärkeimmät säännöt
globs: "*"
alwaysApply: true
---

# Projektin tärkeimmät säännöt

> **1. "Karppi puskee suoraan masteriin ja tuotantoon"**
>
> Huomaa, että tämä on kaikista tärkein sääntö tässä kaveriporukan sisäisessä projektissa:
> - Kaikki muutokset pusketaan suoraan päähaaraan (`main`/`master`).
> - Muutokset deployataan aina heti tuotantoon (`npx wrangler deploy`).
> - Ei turhaa byrokratiaa tai erillisiä feature-haaroja, vaan suoraa toimintaa.

> **2. Kaikki päivämäärät aina ISO-8601 -formaatissa (YYYY-MM-DD)**
>
> Kaikkien ohjelmassa esiintyvien ja käyttäjälle näkyvien päivämäärien (viestit, katsaukset, tulokset, hälytykset, taulut jne.) TÄYTYY AINA OLLA ISO-8601 formaatin mukaisia: `YYYY-MM-DD` (esim. `2026-10-23`).
> - Älä koskaan käytä englantilaisia tai muita alueellisia formaatteja (kuten "Fri 23 Oct", "23 Oct", "23.10.").
> - Ainoa sallittu päivämääräformaatti on ISO-8601 (`YYYY-MM-DD`).
