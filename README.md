# 🎃 Cukorvadászat

Mobilbarát webapp Halloweenre: bárki felvehet helyeket (ahol cukrot lehet gyűjteni) a térképre, mindenki látja őket, és egy kattintással útvonalat tervezhet a Google Térképen.

## Funkciók

- Sötét, Halloween hangulatú térkép (Leaflet + OpenStreetMap csempék CSS-szűrővel sötétítve – nem kell API kulcs)
- **Új hely**: térkép húzásával (📍 a közepén), saját helyzetből, **címkereséssel** (a hely nevénél gépelve címjavaslatok jönnek), vagy beillesztett koordinátával / Google Térkép linkkel (a mobilos rövid `maps.app.goo.gl/…` linkek is működnek – a szerver oldja fel)
- Minden helyhez: név, megjegyzés, „Elfogyott a cukor 💀 / Mégis van még 🍬” jelölés
- „Útvonal a Google Térképen” és „Megnyitás Google Térképen” gomb minden helynél
- Lista a legközelebbi helyekkel (ha engedélyezed a helymeghatározást)
- Automatikus frissítés 20 másodpercenként

## Helyi futtatás

```bash
npm install
npm start
# http://localhost:3000
```

Helyben a helyek a `data/spots.json` fájlba kerülnek. Ha `DATABASE_URL` be van állítva, Postgres-t használ.

## Telepítés Renderre

1. Töltsd fel a projektet egy GitHub repóba.
2. Renderen: **New → Blueprint**, válaszd ki a repót. A `render.yaml` létrehozza a webszolgáltatást és egy Postgres adatbázist, és be is köti az `DATABASE_URL`-t, meg generál egy `ADMIN_TOKEN`-t.
3. Kb. 2–3 perc múlva kész az `https://cukorvadaszat-xxxx.onrender.com` cím – ezt küldd el mindenkinek.

> **Miért kell az adatbázis?** A Render ingyenes webszolgáltatásának fájlrendszere minden újraindításkor/elalváskor törlődik, így a fájlba mentett helyek elvesznének. Az ingyenes Postgres lejárhat (kb. 30 nap után), de egy Halloween eseményre bőven elég.
>
> Az ingyenes szolgáltatás inaktivitás után elalszik, az első megnyitás ilyenkor ~30–60 mp. Ezen egy fizetős csomag segít, vagy az esemény előtt nyisd meg egyszer.

## Admin

**Új helyet és törlést csak az admin végezhet.** A többi látogató csak nézheti a térképet (és alapból az „elfogyott / van még” jelölést használhatja).

Az `ADMIN_TOKEN` értékét a Render dashboardon találod (Environment). Egyszer nyisd meg az oldalt így:

```
https://a-te-címed.onrender.com/?admin=TOKEN
```

Ezután a böngésző megjegyzi a kulcsot (a címsorból el is tűnik), a fejlécben megjelenik a 🔑 Admin jelvény, látszik az „➕ Új hely” gomb, és minden helynél van „🗑️ Hely törlése”. A jelvényre koppintva kiléphetsz az admin módból az adott eszközön.

Ha az „elfogyott / van még” jelölést is csak te szeretnéd végezni, állítsd be a Renderen az environment változót: `PUBLIC_STATUS=false`.

> Az admin linket ne oszd meg senkivel, aki nem lehet admin.

## Mobilról

A Helymeghatározáshoz HTTPS kell – a Render ezt automatikusan adja. iPhone-on és Androidon is működik, a kezdőképernyőre is felrakható.

## Link feloldás és címkeresés

- `GET /api/resolve?url=…` – Google Térkép link (rövid is) → koordináta. A szerver csak Google-os hosztokat követ (SSRF ellen), a EU-s „cookie hozzájárulás” átirányítást is kezeli.
- `GET /api/geocode?q=…` – címjavaslatok a [Photon](https://photon.komoot.io) (OpenStreetMap) szolgáltatással, hiba esetén Nominatim tartalékkal. API kulcs nem kell.
- Mindkettő csak adminnak érhető el, hogy ne lehessen nyílt proxyként használni.
