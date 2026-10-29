# Optionele eventconfiguratie

De historische mapnaam `beleid` blijft voor imports beschikbaar. `beleid.ts`, `typen.ts`, `hosts.ts` en `claude.ts` beschrijven uitsluitend optionele status- en peer-events. De generator is puur en verandert alleen eigen hookentries; permissions en andere hostinstellingen blijven ongemoeid. De installer maakt backups en schrijft atomair.

Er zijn geen commandoweigerregels, rolprofielen of grenzen-hook meer. `codex-werker.ts` bewaart alleen de veilige Bun-installatieargumenten; `installeer-skills.ts` installeert expliciet gekozen draagbare skills en behoudt zijn bestandsveiligheid. Deze bron activeren vereist een afzonderlijk verzoek; de reset wijzigt geen bestaande installaties.
