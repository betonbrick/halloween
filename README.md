# 🎃 Cukorvadászat

Mobilbarát webapp Halloweenre: bárki felvehet helyeket (ahol cukrot lehet gyűjteni) a térképre, mindenki látja őket, és egy kattintással útvonalat tervezhet a Google Térképen.

## Funkciók

- Sötét, Halloween hangulatú térkép (Leaflet + OpenStreetMap/CARTO – nem kell API kulcs)
- **Új hely**: térkép húzásával (📍 a közepén), saját helyzetből, vagy beillesztett koordinátával / Google Térkép linkkel
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

## Admin (törlés)

Az `ADMIN_TOKEN` értékét a Render dashboardon találod (Environment). Ha így nyitod meg az oldalt:

```
https://a-te-címed.onrender.com/?admin=TOKEN
```

minden helynél megjelenik egy „Törlés” gomb.

## Mobilról

A Helymeghatározáshoz HTTPS kell – a Render ezt automatikusan adja. iPhone-on és Androidon is működik, a kezdőképernyőre is felrakható.
