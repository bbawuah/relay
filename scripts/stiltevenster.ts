/** Amsterdamse klok voor het gezamenlijke stiltevenster (05:00–07:15). */
export type AmsterdamseTijd = { jaar: number; maand: number; dag: number; uur: number; minuut: number };

export function amsterdam(datum: Date): AmsterdamseTijd {
  const delen = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Amsterdam",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(datum);
  const waarde = (type: Intl.DateTimeFormatPartTypes) => Number(delen.find((deel) => deel.type === type)?.value);
  return { jaar: waarde("year"), maand: waarde("month"), dag: waarde("day"), uur: waarde("hour"), minuut: waarde("minute") };
}

/** Bouw een Date uit lokale Amsterdamse kalenderwaarden, ook rond zomertijd. */
export function vanAmsterdam(jaar: number, maand: number, dag: number, uur: number, minuut: number): Date {
  let uit = new Date(Date.UTC(jaar, maand - 1, dag, uur, minuut));
  for (let i = 0; i < 3; i++) {
    const lokaal = amsterdam(uit);
    const verschil = (Date.UTC(jaar, maand - 1, dag, uur, minuut) - Date.UTC(lokaal.jaar, lokaal.maand - 1, lokaal.dag, lokaal.uur, lokaal.minuut)) / 60_000;
    if (verschil === 0) break;
    uit = new Date(uit.getTime() + verschil * 60_000);
  }
  return uit;
}

export function inStiltevenster(datum: Date): boolean {
  const tijd = amsterdam(datum);
  const minuten = tijd.uur * 60 + tijd.minuut;
  return minuten >= 5 * 60 && minuten < 7 * 60 + 15;
}

if (import.meta.main) {
  const bron = process.env.STILTEVENSTER_NU;
  const datum = bron ? new Date(bron) : new Date();
  if (Number.isNaN(datum.getTime())) process.exit(2);
  process.exit(inStiltevenster(datum) ? 0 : 1);
}
