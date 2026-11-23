# Ledgerly

Invoices and timesheets for small teams. A library (`src/`) and a small HTTP API (`src/server.js`).

```
npm test          # the test suite (node --test)
npm start         # the API on PORT (default 3000)
```

## How it is meant to behave

- **Money** is in dollars with two decimals. Every total shown to a user is rounded to the cent.
- **Discounts** apply to the subtotal, before tax: `total = (subtotal - discount) + tax on that`.
- **Overtime** is paid on hours above 40 in a week, at 1.5x. A week of 40 hours or fewer has no
  overtime and is paid hours x rate.
- **Dates** are shown as `YYYY-MM-DD`.
- **Sessions** last 30 days from sign-in, then the user must sign in again.
- **Timesheet entries longer than 24 hours in one day are rejected** with
  `"an entry cannot be longer than 24 hours"`. This is intentional: a day has 24 hours, and a
  longer entry is always a typing mistake. Split multi-day work into one entry per day.
- **The invoice list** (`GET /invoices?page=N`) returns 5 invoices per page, oldest first.

## API

| Method | Path | |
|---|---|---|
| GET | `/invoices?page=1` | A page of invoices |
| GET | `/invoices/:id` | One invoice with its total |
| POST | `/timesheets` | `{ hours: [..7 days..], rate }` → pay |
| POST | `/login` | `{ user }` → a session |
| GET | `/me` | The signed-in user (header `x-session`) |
