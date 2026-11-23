# The eight planted bugs — for VERIFYING a run only

Never give this file to an explorer under test: a run must find these on its own.

| # | Where | Bug | How it shows |
|---|---|---|---|
| 1 | Reports list (`/reports`) | The page script reads `window.reportSummary.length`, which does not exist | A console error on every load (`TypeError … reading 'length'`) |
| 2 | Reports list → Filter | `GET /api/reports?project=…` answers 500 for any non-empty filter | A failed network call; the page says "Could not filter reports." |
| 3 | Nav → Help | `/help` does not exist | A broken link (404) |
| 4 | Reports list → Export | The button has no handler | A dead button: clicking it changes nothing |
| 5 | New report | An empty Project is accepted | Missing validation: a report "(no project)" is created |
| 6 | New report | The date is never checked | An impossible date such as `2026-13-45` is stored |
| 7 | Reports list → Quick approve (supervisor) | Approves the row ABOVE the one clicked | The wrong report turns "Approved"; the clicked one stays "Awaiting approval" |
| 8 | Report detail (`/reports/:id`) | The status stamp image is missing and long notes do not wrap | A 404 for `/static/stamp-*.png`, and notes running out of the card |

The approval on the report detail page works: a supervisor test of create → submit → approve →
"Approved" passes on variant A.
