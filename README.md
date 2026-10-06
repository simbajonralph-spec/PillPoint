# PillPoint

A medicine reservation & pharmacy locator system — real database, real backend, real frontend
(HTML/CSS/JavaScript). Built with Node.js + Express + SQLite, no frameworks required on the frontend.

## Features

**Customer:** register/login (with "remember me"), search medicines, compare prices across
pharmacies, view nearby pharmacies on a live Leaflet map (with real distance calculation, now
combined into the same page as search), reserve medicine, view/cancel own reservations, receive
in-app notifications, edit their display name, and see real search-activity stats on their
dashboard (searches made, medicines/pharmacies seen, potential savings, and a "Most Searched
Medicines" pie chart), along with top-rated verified pharmacies. Unconfirmed reservations expire
automatically after 24 hours.

**Pharmacy staff:** dashboard, manage inventory (add/edit/delete, price, stock), low-stock /
out-of-stock detection, confirm/complete/cancel reservations (reserved units are held against
availability while pending and released on cancellation), analytics, sales history by product and
date, notifications, and customer contact
details on reservation requests — all scoped to their own pharmacy. Completing a reservation
deducts its units from inventory and records a stock transaction. New pharmacies can now
self-register (name, address, phone, and a location pin dropped on a live map) and start as
**unverified** until an admin approves them.

**Admin:** dashboard, verify/unverify pharmacies, system-wide shortage monitoring, notifications.
Admin accounts can only ever be created by seeding the database directly — there is no
registration path that can produce one.

**Security:** session-based authentication, role-based authorization enforced server-side on every
route (not just hidden in the UI) — customers only ever see/cancel their own reservations, pharmacy
staff are scoped to their own pharmacy's inventory and reservations, admin routes require the admin
role. Self-registration only ever creates `customer` or `pharmacy_staff` accounts.

## Requirements

- [Node.js](https://nodejs.org) 18 or newer (includes npm)

## Setup & Run

```bash
cd pillpoint
npm install
npm start
```

Then open **http://localhost:3000** in your browser.

P.A.I. customer assistant and natural-language search features use the OpenAI API. Copy
`.env.example` to `.env` and set
`OPENAI_API_KEY` there before starting the server. Keep `.env` private and never put the key in
frontend files. PillPoint's standard search, reservations, and other core features continue to work
without an OpenAI key; OpenAI-backed customer P.A.I. features report when their provider is unavailable.

Pharmacy P.A.I. insights are calculated from the pharmacy's existing inventory, reservations,
stock transactions, medicine batches, listed prices, and search activity. They are advisory only:
P.A.I. does not change stock, batch records, reservations, or prices.

The first time you run it, a `db/pillpoint.db` SQLite file is created automatically and seeded with
demo pharmacies, medicines, inventory, and three demo accounts:

| Role           | Email                          | Password             |
|----------------|----------------------------------|-----------------------|
| Customer       | customer@pillpoint.test        | password             |
| Pharmacy Staff | staff@pillpoint.test           | password              |
| Admin          | PillPointAdmin@gmail.com       | PillPointAdmin123!   |

The pharmacy demo account is scoped to **HealthPlus Pharmacy**, one of four sample pharmacies
seeded into the database. All sample data (pharmacies, medicines, inventory, the demo accounts
above) is meant to be replaced once you're ready — delete the sample pharmacies from
Admin → Manage Pharmacies, or wipe the database as described below and reseed with your own data.

To start fresh, stop the server and delete `db/pillpoint.db` (and the `.db-shm`/`.db-wal` files if
present) — it will be recreated and reseeded next time you run `npm start`.

## Project Structure

```
pillpoint/
  server.js              Express app entry point
  middleware.js           requireAuth / requireRole guards
  db/
    database.js           SQLite connection + schema (users, pharmacies, medicines,
                           inventory, reservations, notifications, search_logs, sales timestamps)
    seed.js                Demo data
  routes/
    auth.js                register (customer/pharmacy only) / login (remember me) /
                            logout / me / profile (name update)
    customer.js             search (logs real activity), compare, nearby, reservations,
                             notifications, dashboard (real stats + pie chart data)
    pharmacy.js             inventory, reservations management, alerts, analytics, sales history
    admin.js                pharmacy verification, shortages
    notifications.js       shared notification endpoints (all roles)
  public/                  Frontend: plain HTML + CSS + JS (no build step)
    css/style.css           Design system (dark navy sidebar + teal accents, elevated
                             hover-lift cards, smooth scroll, scroll-reveal on landing)
    img/                     logo-mark.svg (icon) and logo-full.svg (icon + wordmark)
    js/                      Shared JS (api.js incl. pie-chart helper, layout.js) + page scripts
    *.html                   Customer-facing pages (search.html now includes the map)
    pharmacy/*.html          Pharmacy staff pages
    admin/*.html             Admin pages
```

## Notes

- The "Nearby Pharmacies" map uses [Leaflet.js](https://leafletjs.com) with OpenStreetMap tiles
  (free, no API key) and each pharmacy's real registered latitude/longitude. If you allow browser
  location access, distances are calculated with the Haversine formula from your actual position.
  It now lives on the same page as Search Medicines.
- Passwords are hashed with bcrypt; sessions are cookie-based (`express-session`). "Remember me" on
  login extends the session cookie from 8 hours to 30 days. For a real production deployment, swap
  the in-memory session store for a persistent one (e.g. Redis) and set a strong `secret` via an
  environment variable.
- The dashboard's search-activity stats and "Most Searched Medicines" pie chart are computed from a
  real `search_logs` table that records every search a customer runs (query, medicines shown,
  pharmacies shown) — nothing there is a placeholder number.
- SQLite is a real embedded SQL database stored in a single file — easy to inspect with any SQLite
  browser, and easy to port to MySQL/Postgres later since all access goes through `db/database.js`.
